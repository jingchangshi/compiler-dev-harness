#!/usr/bin/env python3
"""Deterministic geometry QA for presentation diagrams (Phase T5).

Reads `.excalidraw` sources (the editable source of truth a deck ships) and
checks, per file:

  G1  node overlap          — no two node rectangles intersect (beyond a small
                              tolerance for shared edges)
  G2  edge crosses node     — no arrow segment passes through a node box it is
                              not anchored to
  G3  extreme aspect ratio  — content bounding box wider/taller than a sane
                              figure (fail > ASPECT_FAIL, warn > ASPECT_WARN);
                              legibility itself is G4's job
  G4  projected text size   — label font size scaled by how the figure fits a
                              1600×900 slide must stay readable
                              (fail < FONT_FAIL_PX, warn < FONT_WARN_PX)
  G5  text overflow         — each label line must fit its box width
                              (multi-line wrapped labels)

Purely mechanical: no rendering, no LLM, no semantic judgement. Exit 1 on any
ERROR. This checker never decides whether a diagram is *good* — only that it
is not physically broken.

Usage:
  python3 check_diagram_geometry.py [project_dir]           # diagrams/*.excalidraw
  python3 check_diagram_geometry.py diagrams/V1.excalidraw …
Options:
  --slide-width PX / --slide-height PX   projected-size reference (default 1600×900)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ASPECT_FAIL = 20.0
ASPECT_WARN = 6.0
FONT_FAIL_PX = 12.0
FONT_WARN_PX = 16.0
TOUCH_TOL = 2.0          # rectangles may share an edge up to this many px
ENDPOINT_TOL = 5.0       # arrow anchors sit on their own boxes; ignore within this


def cjk_len(text: str) -> int:
    return sum(1 for ch in text if ord(ch) >= 0x2E80)


def estimate_width(text: str, font_size: float) -> float:
    return cjk_len(text) * font_size + (len(text) - cjk_len(text)) * font_size * 0.55


def rects_intersect(a, b, tol=0.0):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return (ax + aw - tol > bx and bx + bw - tol > ax and
            ay + ah - tol > by and by + bh - tol > ay)


def point_in_rect(px, py, r, tol=ENDPOINT_TOL):
    x, y, w, h = r
    return x - tol <= px <= x + w + tol and y - tol <= py <= y + h + tol


def seg_intersects_rect(p0, p1, rect):
    """True if the open segment passes through the rect interior (Liang-Barsky
    clip; boundary-only contact counts as no crossing)."""
    x, y, w, h = rect
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, p0[0] - x), (dx, x + w - p0[0]),
                 (-dy, p0[1] - y), (dy, y + h - p0[1])):
        if abs(p) < 1e-9:
            if q < 0:
                return False
            continue
        t = q / p
        if p < 0:
            if t > t1:
                return False
            t0 = max(t0, t)
        else:
            if t < t0:
                return False
            t1 = min(t1, t)
    return t1 - t0 > 0.02  # more than a boundary graze


def elements_of(doc):
    return [e for e in doc.get("elements", []) if not e.get("isDeleted", False)]


def check_file(path: Path, slide_w: float, slide_h: float):
    errors, warns = [], []
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as err:
        return [f"not readable excalidraw JSON: {err}"], []

    els = elements_of(doc)
    rects = {}
    texts = []
    arrows = []
    for e in els:
        if e.get("type") == "rectangle":
            rects[e["id"]] = (e["x"], e["y"], e.get("width", 0), e.get("height", 0))
        elif e.get("type") == "text":
            texts.append(e)
        elif e.get("type") == "arrow":
            arrows.append(e)

    # G1 node overlap
    ids = sorted(rects)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if rects_intersect(rects[a], rects[b], tol=TOUCH_TOL):
                errors.append(f"G1 node overlap: {a} ∩ {b}")

    # G2 edge crossing node boxes
    for arrow in arrows:
        pts = [(arrow["x"] + p[0], arrow["y"] + p[1])
               for p in arrow.get("points") or []]
        if len(pts) < 2:
            continue
        anchored = {rid for rid, r in rects.items()
                    if point_in_rect(*pts[0], r) or point_in_rect(*pts[-1], r)}
        for rid, r in rects.items():
            if rid in anchored:
                continue
            for p0, p1 in zip(pts, pts[1:]):
                if seg_intersects_rect(p0, p1, r):
                    errors.append(f"G2 edge crosses node: arrow at "
                                  f"({arrow['x']:.0f},{arrow['y']:.0f}) through {rid}")
                    break

    # content bounding box (boxes + arrow endpoints)
    xs0, ys0, xs1, ys1 = [], [], [], []
    for x, y, w, h in list(rects.values()):
        xs0.append(x); ys0.append(y); xs1.append(x + w); ys1.append(y + h)
    for arrow in arrows:
        for p in arrow.get("points") or []:
            xs0.append(arrow["x"] + p[0]); ys0.append(arrow["y"] + p[1])
            xs1.append(arrow["x"] + p[0]); ys1.append(arrow["y"] + p[1])
    if not xs0:
        return ["no content elements"], []
    W = max(xs1) - min(xs0)
    H = max(ys1) - min(ys0)
    if H > 0:
        aspect = W / H
        if aspect > ASPECT_FAIL or aspect < 1 / ASPECT_FAIL:
            errors.append(f"G3 aspect ratio {aspect:.2f} ({W:.0f}×{H:.0f}) exceeds {ASPECT_FAIL}")
        elif aspect > ASPECT_WARN or aspect < 1 / ASPECT_WARN:
            warns.append(f"G3 aspect ratio {aspect:.2f} ({W:.0f}×{H:.0f}) — consider splitting the figure")

    # G4 projected text size: the figure scales to fit the slide box
    if W > 0 and H > 0:
        scale = min(slide_w / W, slide_h / H)
        sizes = sorted({t.get("fontSize", 18) for t in texts})
        for fs in sizes:
            projected = fs * scale
            if projected < FONT_FAIL_PX:
                errors.append(f"G4 projected text {projected:.1f}px "
                              f"(figure {W:.0f}×{H:.0f} scaled {scale:.2f}×) below {FONT_FAIL_PX}px")
            elif projected < FONT_WARN_PX:
                warns.append(f"G4 projected text {projected:.1f}px below {FONT_WARN_PX}px — text is shrinking")

    # G5 label overflow: each line must fit its box (match by containment)
    for t in texts:
        fs = t.get("fontSize", 18)
        box = None
        for rid, r in rects.items():
            if point_in_rect(t["x"], t["y"], r, tol=0.0):
                box = r
                break
        if box is None:
            continue
        for line in str(t.get("text", "")).split("\n"):
            line_w = estimate_width(line, fs)
            if line_w > box[2] - 16:
                errors.append(f"G5 label overflows box {box[0]:.0f},{box[1]:.0f}: "
                              f"line needs {line_w:.0f}px, box is {box[2]:.0f}px")
    return errors, warns


def collect_targets(args):
    paths = []
    for raw in args.targets:
        p = Path(raw)
        if p.is_dir():
            paths.extend(sorted(p.glob("*.excalidraw")))
        elif p.suffix == ".excalidraw" or p.suffix == ".json":
            paths.append(p)
        else:
            print(f"ERROR: unsupported target {raw}", file=sys.stderr)
    if not paths:
        diag = Path(args.project) / "diagrams" if args.project else None
        if diag and diag.is_dir():
            paths = sorted(diag.glob("*.excalidraw"))
    return paths


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("targets", nargs="*", help="project dir, diagrams dir, or .excalidraw files")
    ap.add_argument("--project", default=None, help="presentation project root (default: cwd)")
    ap.add_argument("--slide-width", type=float, default=1600)
    ap.add_argument("--slide-height", type=float, default=900)
    args = ap.parse_args()

    project = Path(args.project) if args.project else Path.cwd()
    targets = collect_targets(args) if args.targets else sorted((project / "diagrams").glob("*.excalidraw"))
    if not targets:
        print("OK: no .excalidraw diagrams found — nothing to check")
        return 0

    failed = False
    for path in targets:
        errors, warns = check_file(path, args.slide_width, args.slide_height)
        status = "FAIL" if errors else "PASS"
        print(f"{status} {path.name}")
        for w in warns:
            print(f"  WARN: {w}")
        for e in errors:
            print(f"  ERROR: {e}")
            failed = True
    if failed:
        print("ERROR: diagram geometry checks failed", file=sys.stderr)
        return 1
    print("OK: diagram geometry checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
