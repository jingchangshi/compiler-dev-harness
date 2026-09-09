#!/usr/bin/env python3
"""Interpret ONE semantic visual spec from a PresentationHandoff into a
positioned diagram spec, then emit an editable .excalidraw + paired .svg via
make_excalidraw_diagram.py.

Boundary (Phase T1/T2/T5): the handoff spec is semantic-only (nodes/edges/
roles/ordering — no x/y/width/color). POSITION, WRAPPING and EDGE ROUTING are
presentation decisions made HERE, deterministically, per supported shape:

  pipeline          — chain along `ordering` (or node order); flow-wrapped into
                      row bands at MAX_BAND_WIDTH; wrap connectors route through
                      the gutter between rows (never diagonally across a row)
  sequence          — vertical chain; non-forward edges route through the
  state_transition    right-hand channel
  before_after      — role-based two columns (before* | after*), boundary below
  comparison        — role-based two columns (left | right), remainder below
  decision_tree     — BFS levels from the first ordering node; levels become
  flowchart           columns; columns wrap into horizontal bands; REJECT-role
  control_flow        nodes go to a dedicated right-hand column
  data_flow
  dependency_graph
  architecture
  ownership etc.    — grid fallback (rows of 3, measured widths)

Determinism rules (Phase T5):
- box sizes are MEASURED from label text (CJK-aware, wrapped at
  MAX_TEXT_WIDTH) — layouts reserve real space, so long CJK labels can never
  overlap neighbours;
- every edge is either straight between horizontally adjacent columns or an
  elbow through reserved node-free channels (inter-column corridors + band
  gutters + outer margins); no edge crosses a node box;
- band wrapping bounds content width, so no layout can produce an ultra-wide
  single-line figure (geometry QA enforces this independently).

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

MAX_BAND_WIDTH = 1500  # wrap columns/nodes into a new band beyond this width
GAP_X = 90             # horizontal gap between columns/nodes (holds corridors)
INTRA_GAP_Y = 56       # vertical gap between nodes stacked in one column
GUTTER = 90            # reserved routing channel between bands/rows
NODE_FONT = 18
MAX_TEXT_WIDTH = 320   # wrap node label text beyond this width
MIN_NODE_W = 170
MIN_NODE_H = 64
BOX_PAD = 36           # horizontal padding inside a box (matches renderer)


def cjk_len(text: str) -> int:
    return sum(1 for ch in str(text) if ord(ch) > 0x2E7F)


def latin_len(text: str) -> int:
    return len(str(text)) - cjk_len(text)


def estimate_width(text: str, font_size: int = NODE_FONT) -> float:
    # must match make_excalidraw_diagram.py's estimate_width
    return cjk_len(text) * font_size + latin_len(text) * font_size * 0.55


def wrap_lines(text: str, max_width: float = MAX_TEXT_WIDTH,
               font_size: int = NODE_FONT) -> list:
    """Greedy width-aware wrap — must match make_excalidraw_diagram.py."""
    lines = []
    for raw in str(text).split("\n"):
        cur, cur_w = "", 0.0
        for ch in raw:
            cw = font_size if ord(ch) > 0x2E7F else font_size * 0.5
            if cur and cur_w + cw > max_width:
                lines.append(cur)
                cur, cur_w = ch, cw
            else:
                cur += ch
                cur_w += cw
        lines.append(cur)
    return lines or [""]


def measure(node: dict):
    """Rendered box size for a node — mirrors make_excalidraw_diagram.py's
    sizing rule (per-line width + padding, line-count height) so layouts
    reserve real space."""
    lines = wrap_lines(label(node))
    w = max(MIN_NODE_W, max(estimate_width(ln) for ln in lines) + BOX_PAD)
    h = max(MIN_NODE_H, len(lines) * NODE_FONT * 1.25 + 20)
    return w, h, lines


def ordered_nodes(spec: dict) -> list:
    nodes = spec.get("nodes", [])
    by_id = {n["id"]: n for n in nodes}
    ordering = [oid for oid in spec.get("ordering", []) if oid in by_id]
    ordered = [by_id[oid] for oid in ordering]
    ordered += [n for n in nodes if n["id"] not in ordering]
    return ordered


def label(node: dict) -> str:
    return node.get("label", node.get("id", ""))


def node_color(node: dict) -> str:
    """Presentation encoding of the Phase T6 semantic contract (consumer
    decision, deterministic): nodes that depict producer-declared STATE
    entities render amber so scheduling/live/analysis lanes read apart from
    control-phase nodes, which render blue. Nodes without semantic fields
    keep the neutral palette (legacy visuals are unchanged)."""
    if node.get("state_refs") and not node.get("mechanism_stages"):
        return "amber"
    if node.get("mechanism_stages"):
        return "blue"
    return "neutral"


def edge_style(edge: dict) -> dict:
    """Presentation encoding of edge semantics: state-domain edges (state
    read/update/create/finalize) are NOT control flow and render dashed;
    explicit per-edge `dashed` still wins. No other kind changes geometry."""
    dashed = bool(edge.get("dashed", False)) or edge.get("domain") == "state"
    return {"dashed": dashed}


def is_reject(node: dict) -> bool:
    return str(node.get("role", "")).lower() == "reject"


def adjacency(spec: dict, by_id: dict) -> dict:
    adj = {nid: [] for nid in by_id}
    for edge in spec.get("edges", []):
        if edge["from"] in adj and edge["to"] in by_id:
            adj[edge["from"]].append(edge["to"])
    return adj


# ─────────────────────────────────────────────────────────────────────────────
# Band/column model shared by level and chain layouts + edge router
# ─────────────────────────────────────────────────────────────────────────────

class Column:
    """One vertical stack of nodes inside a band. `w` is the max node width;
    corridors live in the GAP_X channels left/right of the column."""

    def __init__(self, band, index: int):
        self.band = band
        self.i = index
        self.x = 0
        self.w = 0
        self.nodes = []          # node ids in stack order
        self.placed = []         # [{"id", "y", "h"}] relative to band top

    @property
    def right(self):
        return self.x + self.w


class Band:
    def __init__(self, index: int):
        self.index = index
        self.columns: list = []
        self.top = 0
        self.bottom = 0
        self.cursor_x = 0  # running x where the next column starts

    def new_column(self) -> "Column":
        col = Column(self, len(self.columns))
        col.x = self.cursor_x
        self.columns.append(col)
        return col

    def placed_column(self, col: "Column"):
        """Record the column's final width; advance the running cursor."""
        self.cursor_x = col.x + col.w + GAP_X

    def gutter_below(self):
        return self.bottom + GUTTER / 2

    def gutter_above(self):
        return self.top - GUTTER / 2

    def corridor_right_of(self, col_index: int) -> float:
        """Node-free vertical corridor immediately right of a column."""
        if col_index + 1 < len(self.columns):
            return (self.columns[col_index].right + self.columns[col_index + 1].x) / 2
        return self.columns[col_index].right + GAP_X / 2

    def corridor_left_of(self, col_index: int) -> float:
        """Node-free vertical corridor immediately left of a column."""
        if col_index > 0:
            return (self.columns[col_index - 1].right + self.columns[col_index].x) / 2
        return self.columns[0].x - GAP_X / 2


def place_column(col: Column, node_ids, sizes, positions):
    """Stack node_ids vertically inside col (relative coords); grows col.w."""
    y = 0
    for nid in node_ids:
        w, h, _ = sizes[nid]
        positions[nid] = {"x": 0, "y": y, "w": w, "h": h, "col": col}
        col.placed.append({"id": nid, "y": y, "h": h})
        col.w = max(col.w, w)
        y += h + INTRA_GAP_Y
    return y - INTRA_GAP_Y


def finalize_bands(bands, positions):
    """Assign absolute x/y: columns packed left→right with GAP_X, bands stacked
    top→bottom with GUTTER. Returns total content height."""
    y = 0
    width = 0
    for band in bands:
        band.top = y
        x = 0
        for col in band.columns:
            col.x = x
            x += col.w + GAP_X
        band_h = 0
        for col in band.columns:
            for p in col.placed:
                pos = positions[p["id"]]
                pos["x"] = col.x
                pos["y"] = band.top + p["y"]
                band_h = max(band_h, p["y"] + p["h"])
        band.bottom = band.top + band_h
        width = max(width, x - GAP_X)
        y = band.bottom + GUTTER
    return max(y - GUTTER, 0), width


def route_edge(a: dict, b: dict) -> list:
    """Deterministic elbow route through node-free corridors + band gutters.

    Straight adjacency is handled by the caller. All vertical segments run in
    inter-column corridors or the left margin (node-free by construction); all
    long horizontal segments run in band gutters (node-free by construction).

    Redundancy rules (Phase T6): a route may never run PAST its target and
    double back. Same-column targets connect directly along the shared
    node-free corridor (no gutter dip); same-band cross-column edges cross at
    the NEARER of the band's two gutters."""
    a_band, b_band = a["col"].band, b["col"].band
    a_cy = a["y"] + a["h"] / 2
    b_cy = b["y"] + b["h"] / 2
    if a_band is b_band:
        exit_vx = a_band.corridor_right_of(a["col"].i)
        enter_right = b["col"].i <= a["col"].i
        entry_vx = (b_band.corridor_right_of(b["col"].i) if enter_right
                    else b_band.corridor_left_of(b["col"].i))
        if a["col"] is b["col"] or exit_vx == entry_vx:
            # same column, or adjacent columns sharing one gap corridor: the
            # corridor alone connects the two nodes; dipping to a band gutter
            # would overshoot the target and double back
            return _dedup([(exit_vx, a_cy), (exit_vx, b_cy)])
        # distinct corridors: cross at the nearer node-free horizontal channel
        below, above = a_band.gutter_below(), a_band.gutter_above()
        g_y = below if (abs(below - a_cy) + abs(below - b_cy)) <= (abs(above - a_cy) + abs(above - b_cy)) else above
        pts = [(exit_vx, a_cy), (exit_vx, g_y), (entry_vx, g_y), (entry_vx, b_cy)]
        return _dedup(pts)
    if b_band.index > a_band.index:
        g_y = a_band.gutter_below()
    else:
        g_y = a_band.gutter_above()
    exit_vx = a_band.corridor_right_of(a["col"].i)
    enter_right = (b_band.index, b["col"].i) < (a_band.index, a["col"].i)
    entry_vx = (b_band.corridor_right_of(b["col"].i) if enter_right
                else b_band.corridor_left_of(b["col"].i))
    pts = [(exit_vx, a_cy), (exit_vx, g_y), (entry_vx, g_y), (entry_vx, b_cy)]
    if abs(b_band.index - a_band.index) > 1:
        # non-adjacent bands: hop vertically in the left margin, which no band
        # occupies (columns always start at x >= 0)
        lm = -GAP_X / 2
        g2 = b_band.gutter_below() if b_band.index < a_band.index else b_band.gutter_above()
        pts = [(exit_vx, a_cy), (exit_vx, g_y), (lm, g_y), (lm, g2),
               (entry_vx, g2), (entry_vx, b_cy)]
    return _dedup(pts)


def _dedup(pts) -> list:
    dedup = []
    for p in pts:
        if not dedup or list(p) != list(dedup[-1]):
            dedup.append(list(p))
    return dedup


def self_loop_waypoints(a: dict) -> list:
    """A self-relation (e.g. a loop backedge from a stage to itself) leaves the
    node's right side, makes a small detour inside the node-free corridor, and
    returns — never a degenerate down-and-back line."""
    cx = a["x"] + a["w"]
    cy = a["y"] + a["h"] / 2
    dx = GAP_X / 2
    y1, y2 = cy - a["h"] / 4, cy + a["h"] / 4
    return [[cx + dx, y1], [cx + dx, y2]]


def make_edge(e, a, b, wps):
    style = edge_style(e)
    return {"from": e["from"], "to": e["to"], "label": e.get("label") or "",
            "dashed": style["dashed"], "waypoints": wps}


# ── Straight-segment guard (Phase T6) ─────────────────────────────────────────
# Adjacent columns/bands are connected straight ONLY when the straight segment
# is genuinely node-free. Stacked columns make naive straight lines cut through
# the boxes above/below the endpoints; those edges fall back to the corridor
# elbow, which is node-free by construction.

def anchor_point(a: dict, b: dict) -> tuple:
    """Mirror make_excalidraw_diagram.py's anchor choice: the side of box a
    facing box b (horizontal-dominant exits sideways, vertical exits top/bottom)."""
    acx, acy = a["x"] + a["w"] / 2, a["y"] + a["h"] / 2
    bcx, bcy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
    dx, dy = bcx - acx, bcy - acy
    if abs(dx) >= abs(dy):
        return (a["x"] + a["w"], acy) if dx >= 0 else (a["x"], acy)
    return (acx, a["y"] + a["h"]) if dy >= 0 else (acx, a["y"])


def segment_crosses_box(p1: tuple, p2: tuple, box: tuple, tol: float = 2.0) -> bool:
    """Liang-Barsky segment/rect intersection. `box` = (x, y, w, h), shrunk by
    `tol` so lines that merely touch a border do not count."""
    x, y, w, h = box
    xmin, ymin, xmax, ymax = x + tol, y + tol, x + w - tol, y + h - tol
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, p1[0] - xmin), (dx, xmax - p1[0]), (-dy, p1[1] - ymin), (dy, ymax - p1[1])):
        if p == 0:
            if q < 0:
                return False
            continue
        t = q / p
        if p < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1:
            return False
    return True


def straight_is_clean(e, a: dict, b: dict, boxes: dict) -> bool:
    """True when the straight anchor-to-anchor segment touches no third box."""
    p1 = anchor_point(a, b)
    p2 = anchor_point(b, a)
    for nid, box in boxes.items():
        if nid in (e["from"], e["to"]):
            continue
        if segment_crosses_box(p1, p2, box):
            return False
    return True


def connect(e, a: dict, b: dict, boxes: dict, straight_when: bool):
    """Straight when allowed AND clean; self-loops get a dedicated mini-detour;
    corridor elbow otherwise."""
    if e["from"] == e["to"]:
        return make_edge(e, a, b, self_loop_waypoints(a))
    wps = [] if (straight_when and straight_is_clean(e, a, b, boxes)) else route_edge(a, b)
    return make_edge(e, a, b, wps)


def router_layout(spec, multi_root: bool):
    """Generic band/column layout for decision_tree/flowchart (single root) and
    control_flow/data_flow/dependency_graph/architecture (all roots): BFS
    levels become columns, wrapped into bands; REJECT roles go to a dedicated
    trailing column; non-adjacent edges route through corridors/gutters."""
    nodes = ordered_nodes(spec)
    if not nodes:
        return {}, [], MIN_NODE_W, MIN_NODE_H
    by_id = {n["id"]: n for n in nodes}
    sizes = {n["id"]: measure(n) for n in nodes}
    adj = adjacency(spec, by_id)
    incoming = {nid: 0 for nid in by_id}
    for e in spec.get("edges", []):
        if e["from"] in incoming and e["to"] in by_id:
            incoming[e["to"]] += 1

    main = [n for n in nodes if not is_reject(n)]
    rejects = [n for n in nodes if is_reject(n)]
    order_ids = [n["id"] for n in main]

    if multi_root:
        starts = [nid for nid in order_ids if incoming[nid] == 0] or order_ids[:1]
    else:
        first = next((oid for oid in spec.get("ordering", [])
                      if oid in by_id and not is_reject(by_id[oid])), None)
        starts = [first] if first else (
            [nid for nid in order_ids if incoming[nid] == 0] or order_ids[:1])

    level = {}
    discovery = []
    frontier = []
    for s in starts:
        if s not in level:
            level[s] = 0
            frontier.append(s)
            discovery.append(s)
    while frontier:
        nxt = []
        for cur in frontier:
            for child in adj.get(cur, []):
                if child in by_id and not is_reject(by_id[child]) and child not in level:
                    level[child] = level[cur] + 1
                    nxt.append(child)
                    discovery.append(child)
        frontier = nxt
    unreachable = [nid for nid in order_ids if nid not in level]
    next_level = (max(level.values()) + 1) if level else 0
    for nid in unreachable:
        level[nid] = next_level
        discovery.append(nid)

    by_level = {}
    for nid in discovery:
        by_level.setdefault(level[nid], []).append(nid)

    bands = []
    positions = {}
    band = Band(0)
    bands.append(band)
    for lv in sorted(by_level):
        nids = by_level[lv]
        lw = max(sizes[nid][0] for nid in nids)
        if band.cursor_x > 0 and band.cursor_x + lw > MAX_BAND_WIDTH:
            band = Band(len(bands))
            bands.append(band)
        col = band.new_column()
        place_column(col, nids, sizes, positions)
        band.placed_column(col)
    if rejects:
        rw = max(sizes[n["id"]][0] for n in rejects)
        if band.cursor_x > 0 and band.cursor_x + rw > MAX_BAND_WIDTH + 300:
            band = Band(len(bands))
            bands.append(band)
        col = band.new_column()
        place_column(col, [n["id"] for n in rejects], sizes, positions)
        band.placed_column(col)

    height, width = finalize_bands(bands, positions)
    boxes = {nid: (p["x"], p["y"], p["w"], p["h"]) for nid, p in positions.items()}

    routed = []
    for e in spec.get("edges", []):
        a, b = positions.get(e["from"]), positions.get(e["to"])
        if not a or not b:
            continue
        straight = (a["col"].band is b["col"].band and b["col"].i == a["col"].i + 1)
        routed.append(connect(e, a, b, boxes, straight))

    return positions, routed, max(width, MIN_NODE_W), max(height, MIN_NODE_H)


def chain_layout(spec):
    """pipeline: flow-wrapped horizontal chain; each node is a 1-node column,
    wrap connectors route through the gutter via the shared router."""
    nodes = ordered_nodes(spec)
    if not nodes:
        return {}, [], MIN_NODE_W, MIN_NODE_H
    sizes = {n["id"]: measure(n) for n in nodes}
    bands = []
    positions = {}
    band = Band(0)
    bands.append(band)
    for n in nodes:
        w, h, _ = sizes[n["id"]]
        if band.cursor_x > 0 and band.cursor_x + w > MAX_BAND_WIDTH:
            band = Band(len(bands))
            bands.append(band)
        col = band.new_column()
        place_column(col, [n["id"]], sizes, positions)
        band.placed_column(col)
    height, width = finalize_bands(bands, positions)
    boxes = {nid: (p["x"], p["y"], p["w"], p["h"]) for nid, p in positions.items()}
    routed = []
    for e in spec.get("edges", []):
        a, b = positions.get(e["from"]), positions.get(e["to"])
        if not a or not b:
            continue
        straight = (a["col"].band is b["col"].band and b["col"].i == a["col"].i + 1)
        routed.append(connect(e, a, b, boxes, straight))
    return positions, routed, max(width, MIN_NODE_W), max(height, MIN_NODE_H)


def vertical_layout(spec):
    """sequence / state_transition: vertical chain; non-forward edges route
    through the right-hand channel."""
    nodes = ordered_nodes(spec)
    if not nodes:
        return {}, [], MIN_NODE_W, MIN_NODE_H
    sizes = {n["id"]: measure(n) for n in nodes}
    positions = {}
    y = 0
    order = [n["id"] for n in nodes]
    pos_index = {nid: i for i, nid in enumerate(order)}
    for nid in order:
        w, h, _ = sizes[nid]
        positions[nid] = {"x": 0, "y": y, "w": w, "h": h}
        y += h + GUTTER
    height = max(y - GUTTER, MIN_NODE_H)
    width = max((p["w"] for p in positions.values()), default=MIN_NODE_W)
    channel = width + GAP_X / 2
    routed = []
    for e in spec.get("edges", []):
        a, b = positions.get(e["from"]), positions.get(e["to"])
        if not a or not b:
            continue
        forward = pos_index[e["to"]] == pos_index[e["from"]] + 1
        if e["from"] == e["to"]:
            wps = self_loop_waypoints(a)
        elif not forward:
            a_cy, b_cy = a["y"] + a["h"] / 2, b["y"] + b["h"] / 2
            wps = [(channel, a_cy), (channel, b_cy)]
        else:
            wps = []
        routed.append(make_edge(e, a, b, wps))
    return positions, routed, max(width + GAP_X, MIN_NODE_W), max(height, MIN_NODE_H)


def column_layout(spec):
    """before_after: left = before*/source, right = after*/result/reject/rewrite,
    remainder below. comparison: left/right roles, remainder below. Measured
    widths; cross-column edges are straight through the empty middle gap."""
    nodes = ordered_nodes(spec)
    if not nodes:
        return {}, [], MIN_NODE_W, MIN_NODE_H
    sizes = {n["id"]: measure(n) for n in nodes}
    left, right, bottom = [], [], []
    for node in nodes:
        role = str(node.get("role", "")).lower()
        if "before" in role or role in ("source", "left"):
            left.append(node)
        elif "after" in role or role in ("result", "reject", "rewrite", "right"):
            right.append(node)
        else:
            bottom.append(node)
    positions = {}
    col1_w = max((sizes[n["id"]][0] for n in left), default=MIN_NODE_W)
    col2_x = col1_w + GAP_X
    for group, x in ((left, 0), (right, col2_x)):
        y = 0
        for n in group:
            w, h, _ = sizes[n["id"]]
            positions[n["id"]] = {"x": x, "y": y, "w": w, "h": h}
            y += h + INTRA_GAP_Y
    base_y = max((positions[n["id"]]["y"] + sizes[n["id"]][1]
                  for n in left + right), default=0)
    if left or right:
        base_y += GUTTER
    right_w = max((sizes[n["id"]][0] for n in right), default=0)
    strip_width = max(col2_x + right_w, MAX_BAND_WIDTH / 2)
    x = 0
    y = base_y
    row_h = 0
    for n in bottom:
        w, h, _ = sizes[n["id"]]
        if x > 0 and x + w > strip_width:
            x = 0
            y += row_h + INTRA_GAP_Y
            row_h = 0
        positions[n["id"]] = {"x": x, "y": y, "w": w, "h": h}
        x += w + GAP_X
        row_h = max(row_h, h)
    height = max(y + row_h, MIN_NODE_H)
    width = max(col2_x + right_w, x - GAP_X, MIN_NODE_W)

    routed = []
    for e in spec.get("edges", []):
        a, b = positions.get(e["from"]), positions.get(e["to"])
        if not a or not b:
            continue
        if e["from"] == e["to"]:
            wps = self_loop_waypoints(a)
        else:
            a_top = a["y"] + a["h"] <= base_y + 1
            b_top = b["y"] + b["h"] <= base_y + 1
            straight = (a_top and b_top and a["x"] != b["x"]) or (not a_top and not b_top)
            wps = []
            if not straight:
                channel = max(a["x"] + a["w"], b["x"] + b["w"]) + GAP_X / 2
                a_cy, b_cy = a["y"] + a["h"] / 2, b["y"] + b["h"] / 2
                wps = [(channel, a_cy), (channel, b_cy)]
        routed.append(make_edge(e, a, b, wps))
    return positions, routed, width, height


def grid_layout(spec):
    nodes = ordered_nodes(spec)
    positions = {}
    x = y = 0
    row_h = 0
    width = height = 0
    per_row = 0
    for node in nodes:
        w, h, _ = measure(node)
        if x > 0 and (per_row >= 3 or x + w > MAX_BAND_WIDTH):
            x = 0
            y += row_h + INTRA_GAP_Y
            row_h = 0
            per_row = 0
        positions[node["id"]] = {"x": x, "y": y, "w": w, "h": h}
        x += w + GAP_X
        row_h = max(row_h, h)
        per_row += 1
        width = max(width, x - GAP_X)
        height = max(height, y + h)
    boxes = {nid: (p["x"], p["y"], p["w"], p["h"]) for nid, p in positions.items()}
    routed = []
    for e in spec.get("edges", []):
        a, b = positions.get(e["from"]), positions.get(e["to"])
        if not a or not b:
            continue
        # grid rows wrap: treat same-row right-neighbours as straight candidates,
        # everything else goes through the shared corridor router
        straight = abs(a["y"] - b["y"]) < 1.0 and b["x"] > a["x"]
        routed.append(connect(e, a, b, boxes, straight))
    return positions, routed, max(width, MIN_NODE_W), max(height, MIN_NODE_H)


KIND_LAYOUT = {
    "pipeline": chain_layout,
    "sequence": vertical_layout,
    "state_transition": vertical_layout,
    "before_after": column_layout,
    "comparison": column_layout,
    "decision_tree": lambda s: router_layout(s, multi_root=False),
    "flowchart": lambda s: router_layout(s, multi_root=False),
    "control_flow": lambda s: router_layout(s, multi_root=True),
    "data_flow": lambda s: router_layout(s, multi_root=True),
    "dependency_graph": lambda s: router_layout(s, multi_root=True),
    "architecture": lambda s: router_layout(s, multi_root=True),
}


def interpret(spec: dict) -> dict:
    kind = spec.get("kind")
    layout = KIND_LAYOUT.get(kind, grid_layout)
    positions, routed, width, height = layout(spec)
    out = {"width": max(width, MIN_NODE_W), "height": max(height, MIN_NODE_H),
           "nodes": [], "edges": routed}
    for node in ordered_nodes(spec):
        p = positions.get(node["id"])
        if p is None:
            continue
        w, h, lines = measure(node)
        out["nodes"].append({
            "id": node["id"],
            "text": label(node),
            "x": p["x"], "y": p["y"],
            "width": w, "height": h,
            "lines": lines,
            "fontSize": NODE_FONT,
            "color": node_color(node),
        })
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
