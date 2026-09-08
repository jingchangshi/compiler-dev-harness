#!/usr/bin/env python3
"""Interpret ONE semantic visual spec from a PresentationHandoff into a
positioned diagram spec, then emit an editable .excalidraw + paired .svg via
make_excalidraw_diagram.py.

Boundary (Phase T1/T2): the handoff spec is semantic-only (nodes/edges/roles/
ordering — no x/y/width/color). POSITION and VISUAL STYLE are presentation
decisions made HERE, deterministically, per supported shape:

  pipeline          — chain along `ordering` (or node order), wrap every 4 nodes
  before_after      — role-based two columns (before* | after*), boundary below
  decision_tree      — breadth levels from the first ordering node; REJECT-role
                      nodes routed to a dedicated right column
  state_transition  — top-down sequence
  fallback          — grid rows of 3 in ordering order

This is a bounded set of presentation interpretations, not a general layout
engine: unsupported shapes fall back to the grid, and humans refine the
.excalidraw afterwards (it stays editable).

Usage:
  python3 spec_to_diagram.py --handoff <handoff.json> --visual V1 \
      --excalidraw diagrams/V1.excalidraw --svg diagrams/V1.svg
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
GENERATOR = HERE / "make_excalidraw_diagram.py"

WRAP = 4            # pipeline nodes per row
GRID_COLS = 3       # fallback grid columns
NODE_W = 200
NODE_H = 72
GAP_X = 90
GAP_Y = 90
MAX_ROW_WIDTH = 1500  # measured-width flow wrapping (long CJK labels overflow fixed grids)


def cjk_len(text: str) -> int:
    return sum(1 for ch in str(text) if ord(ch) > 0x2E7F)


def latin_len(text: str) -> int:
    return len(str(text)) - cjk_len(text)


def measure(node: dict) -> tuple[int, int]:
    """Rendered box size for a node — must mirror make_excalidraw_diagram.py's
    sizing rule exactly (box = max(spec width=NODE_W, min text width), height
    fixed at NODE_H) so layouts reserve real space instead of assuming a grid."""
    text = label(node)
    w = max(NODE_W, 160, cjk_len(text) * 18 + latin_len(text) * 9 + 36)
    return w, NODE_H


def ordered_nodes(spec: dict) -> list:
    nodes = spec.get("nodes", [])
    by_id = {n["id"]: n for n in nodes}
    ordering = [oid for oid in spec.get("ordering", []) if oid in by_id]
    ordered = [by_id[oid] for oid in ordering]
    ordered += [n for n in nodes if n not in ordered]
    return ordered


def label(node: dict) -> str:
    return node.get("label", node.get("id", ""))


def layout_chain(spec: dict, vertical: bool = False) -> dict:
    """pipeline / state_transition: chain along order with measured-width flow
    wrapping — box sizes come from measure(), so long CJK labels never overlap
    neighbors nor escape the bounding box."""
    nodes = ordered_nodes(spec)
    positioned = {}
    x = y = 0
    width = height = 0
    for node in nodes:
        w, h = measure(node)
        if vertical:
            positioned[node["id"]] = {"x": 0, "y": y}
            y += h + GAP_Y
            width = max(width, w)
            height = y
        else:
            if x > 0 and x + w > MAX_ROW_WIDTH:
                x = 0
                y += NODE_H + GAP_Y
            positioned[node["id"]] = {"x": x, "y": y}
            x += w + GAP_X
            width = max(width, x - GAP_X)
            height = max(height, y + h)
    if vertical:
        height = max(height - GAP_Y, NODE_H)
    return positioned, max(width, NODE_W), max(height, NODE_H)


def layout_columns(spec: dict) -> dict:
    """before_after: left = before*/source roles, right = after*/result, boundary bottom."""
    nodes = ordered_nodes(spec)
    left, right, bottom = [], [], []
    for node in nodes:
        role = str(node.get("role", ""))
        if "before" in role or role in ("source",):
            left.append(node)
        elif "after" in role or role in ("result", "reject", "rewrite"):
            right.append(node)
        else:
            bottom.append(node)
    positioned = {}
    for col, group in ((0, left), (1, right)):
        for i, node in enumerate(group):
            positioned[node["id"]] = {"x": col * (NODE_W + 3 * GAP_X), "y": i * (NODE_H + GAP_Y)}
    base_y = max(len(left), len(right), 1) * (NODE_H + GAP_Y)
    for i, node in enumerate(bottom):
        positioned[node["id"]] = {"x": i * (NODE_W + GAP_X), "y": base_y}
    width = 2 * NODE_W + 3 * GAP_X
    height = base_y + (len(bottom) > 0) * NODE_H
    return positioned, width, max(height, NODE_H)


def layout_levels(spec: dict) -> dict:
    """decision_tree: BFS levels from the first node; REJECT-role nodes to a
    separate right column so REJECT branches stay visually separated."""
    nodes = ordered_nodes(spec)
    if not nodes:
        return {}, NODE_W, NODE_H
    by_id = {n["id"]: n for n in nodes}
    start = nodes[0]["id"]
    adjacency: dict = {n["id"]: [] for n in nodes}
    for edge in spec.get("edges", []):
        if edge["from"] in adjacency and edge["to"] in by_id:
            adjacency[edge["from"]].append(edge["to"])
    level = {start: 0}
    frontier = [start]
    while frontier:
        nxt = []
        for cur in frontier:
            for child in adjacency.get(cur, []):
                if child not in level:
                    level[child] = level[cur] + 1
                    nxt.append(child)
        frontier = nxt
    main_nodes = [n for n in nodes if str(n.get("role", "")).lower() != "reject"]
    reject_nodes = [n for n in nodes if str(n.get("role", "")).lower() == "reject"]
    positioned = {}
    per_level: dict = {}
    for node in main_nodes:
        depth = level.get(node["id"], 0)
        col = per_level.get(depth, 0)
        per_level[depth] = col + 1
        positioned[node["id"]] = {"x": depth * (NODE_W + 2 * GAP_X), "y": col * (NODE_H + GAP_Y)}
    reject_x = (max(per_level) + 1) * (NODE_W + 2 * GAP_X)
    for i, node in enumerate(reject_nodes):
        positioned[node["id"]] = {"x": reject_x, "y": i * (NODE_H + GAP_Y)}
    max_depth = max(level.values(), default=0)
    width = (max_depth + 2) * (NODE_W + 2 * GAP_X)
    height = max(max(per_level.values(), default=1), len(reject_nodes)) * (NODE_H + GAP_Y)
    return positioned, width, max(height, NODE_H)


def layout_grid(spec: dict) -> dict:
    nodes = ordered_nodes(spec)
    positioned = {}
    x = y = 0
    row_h = 0
    width = height = 0
    per_row = 0
    for node in nodes:
        w, h = measure(node)
        if x > 0 and (per_row >= GRID_COLS or x + w > MAX_ROW_WIDTH):
            x = 0
            y += row_h + GAP_Y
            row_h = 0
            per_row = 0
        positioned[node["id"]] = {"x": x, "y": y}
        x += w + GAP_X
        row_h = max(row_h, h)
        per_row += 1
        width = max(width, x - GAP_X)
        height = max(height, y + h)
    return positioned, max(width, NODE_W), max(height, NODE_H)


KIND_LAYOUT = {
    "pipeline": lambda s: layout_chain(s),
    "sequence": lambda s: layout_chain(s, vertical=True),
    "state_transition": lambda s: layout_chain(s, vertical=True),
    "before_after": layout_columns,
    "decision_tree": layout_levels,
}


def interpret(spec: dict) -> dict:
    positioned, width, height = KIND_LAYOUT.get(spec.get("kind"), layout_grid)(spec)
    out = {"width": width, "height": max(height, NODE_H), "nodes": [], "edges": []}
    for node in ordered_nodes(spec):
        pos = positioned[node["id"]]
        out["nodes"].append({
            "id": node["id"],
            "text": label(node),
            "x": pos["x"], "y": pos["y"],
            "width": NODE_W, "height": NODE_H,
            "fontSize": 18,
        })
    for edge in spec.get("edges", []):
        out["edges"].append({"from": edge["from"], "to": edge["to"], "label": edge.get("label") or ""})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--handoff", type=Path, required=True)
    ap.add_argument("--visual", required=True, help="visual id in handoff.visuals")
    ap.add_argument("--excalidraw", type=Path, required=True)
    ap.add_argument("--svg", type=Path, required=True)
    args = ap.parse_args()

    handoff = json.loads(args.handoff.read_text(encoding="utf-8"))
    spec = next((v for v in handoff.get("visuals", []) if v.get("id") == args.visual), None)
    if spec is None:
        print(f"ERROR: visual id {args.visual!r} not in handoff.visuals", file=sys.stderr)
        return 1
    positioned = interpret(spec)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
        json.dump(positioned, tmp, ensure_ascii=False)
        tmp_path = tmp.name
    result = subprocess.run(
        [sys.executable, str(GENERATOR), tmp_path,
         "--excalidraw", str(args.excalidraw), "--svg", str(args.svg)],
        capture_output=True, text=True)
    Path(tmp_path).unlink(missing_ok=True)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        return result.returncode
    print(args.excalidraw)
    print(args.svg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
