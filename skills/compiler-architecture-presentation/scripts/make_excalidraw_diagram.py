#!/usr/bin/env python3
"""Create an Excalidraw source plus same-layout SVG fallback from a JSON spec.

The SVG fallback is deterministic and intended for embedding in offline HTML decks.
The .excalidraw file remains editable in Excalidraw.

Phase T5 rendering contract:
- node text wraps to the box (multi-line, same wrap rule as spec_to_diagram.py);
- edges may carry `waypoints` (list of [x, y] intermediate points) and are then
  rendered as polylines/elbows instead of straight 2-point lines;
- the arrow enters/exits each box on the side facing the adjacent waypoint
  (or the other box, for straight edges).
"""
from __future__ import annotations
import argparse, json, math
from pathlib import Path
from xml.sax.saxutils import escape

PALETTE = {
    "neutral": ("#343a40", "#ffffff"),
    "blue": ("#2a76dd", "#eef5ff"),
    "green": ("#198754", "#f4fbf7"),
    "amber": ("#fd7e14", "#fff8ef"),
    "red": ("#dc3545", "#fff7f7"),
}

def cjk_len(text: str) -> int:
    return sum(1 for ch in text if ord(ch) >= 0x2E80)

def latin_len(text: str) -> int:
    return len(text) - cjk_len(text)

def estimate_width(text: str, font_size: int = 20) -> float:
    return cjk_len(text) * font_size + latin_len(text) * font_size * 0.55

def wrap_lines(text: str, max_width: float, font_size: int = 18) -> list[str]:
    """Greedy width-aware wrap — must match spec_to_diagram.py's rule so the
    layout reserves the same box the renderer draws."""
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

def element_base(eid, typ, x, y, w, h, stroke, bg, stroke_width=2):
    return {
        "id": eid, "type": typ, "x": x, "y": y, "width": w, "height": h,
        "angle": 0, "strokeColor": stroke, "backgroundColor": bg,
        "fillStyle": "solid", "strokeWidth": stroke_width, "strokeStyle": "solid",
        "roughness": 0, "opacity": 100, "groupIds": [], "frameId": None,
        "index": "a0", "roundness": {"type": 3} if typ == "rectangle" else None,
        "seed": abs(hash(eid)) % 100000, "version": 1, "versionNonce": 1,
        "isDeleted": False, "boundElements": None, "updated": 1, "link": None, "locked": False,
    }

def make_text(eid, text, x, y, w, h, color="#222222", font_size=20, align="center"):
    obj = element_base(eid, "text", x, y, w, h, color, "transparent", 1)
    obj.update({
        "text": text, "fontSize": font_size, "fontFamily": 2,
        "textAlign": align, "verticalAlign": "middle", "containerId": None,
        "originalText": text, "autoResize": False, "lineHeight": 1.25,
        "baseline": int(font_size * .8),
    })
    obj.pop("roundness", None)
    return obj

def anchor(a, b, side_hint=None):
    """Anchor point on box a's edge facing b (or an explicit anchor center)."""
    acx, acy = a["x"] + a["_w"] / 2, a["y"] + a["_h"] / 2
    bcx, bcy = b[0], b[1]
    dx, dy = bcx - acx, bcy - acy
    if abs(dx) >= abs(dy):
        if dx >= 0:
            return a["x"] + a["_w"], acy
        return a["x"], acy
    if dy >= 0:
        return acx, a["y"] + a["_h"]
    return acx, a["y"]

def make_arrow(eid, pts, color="#555555", dashed=False):
    """pts: absolute [[x, y], ...] polyline; first point is the anchor."""
    x0, y0 = pts[0]
    rel = [[p[0] - x0, p[1] - y0] for p in pts]
    w = max(p[0] for p in rel) - min(p[0] for p in rel)
    h = max(p[1] for p in rel) - min(p[1] for p in rel)
    obj = element_base(eid, "arrow", x0, y0, w, h, color, "transparent", 2)
    obj.update({
        "points": rel, "lastCommittedPoint": None,
        "startBinding": None, "endBinding": None, "startArrowhead": None, "endArrowhead": "arrow",
        "elbowed": len(pts) > 2,
    })
    obj["strokeStyle"] = "dashed" if dashed else "solid"
    obj.pop("roundness", None)
    return obj

def svg_text(x, y, w, h, text, font_size, color="#222", align="middle"):
    lines = text.split("\n")
    anchor = "middle" if align == "center" else "start"
    tx = x + w/2 if align == "center" else x
    total_h = len(lines) * font_size * 1.25
    start_y = y + h/2 - total_h/2 + font_size
    spans=[]
    for i,line in enumerate(lines):
        spans.append(f'<text x="{tx:.1f}" y="{start_y+i*font_size*1.25:.1f}" text-anchor="{anchor}" font-family="Arial, Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="{font_size}" fill="{color}">{escape(line)}</text>')
    return "\n".join(spans)

def svg_polyline(pts, color, dashed):
    dash=' stroke-dasharray="8 6"' if dashed else ''
    ptstr = " ".join(f"{p[0]:.1f},{p[1]:.1f}" for p in pts)
    return (f'<polyline points="{ptstr}" fill="none" stroke="{color}" '
            f'stroke-width="2.5" stroke-linejoin="round"{dash} marker-end="url(#arrow)"/>')

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("spec", type=Path)
    ap.add_argument("--excalidraw", type=Path, required=True)
    ap.add_argument("--svg", type=Path, required=True)
    args=ap.parse_args()
    spec=json.loads(args.spec.read_text(encoding="utf-8"))
    els=[]; body=[]
    # True content extents: every drawn element (boxes, arrow polylines, edge
    # label plates) contributes both its max AND min side. Routes may leave the
    # node grid (band gutters above/below, left-margin hops), so the frame is
    # derived from the elements themselves — never assumed to start at (0,0).
    extents=[[None,None],[None,None]]  # [[min_x,max_x],[min_y,max_y]]
    def span(x0,y0,x1,y1):
        e=extents
        e[0][0]=x0 if e[0][0] is None else min(e[0][0],x0); e[0][1]=x1 if e[0][1] is None else max(e[0][1],x1)
        e[1][0]=y0 if e[1][0] is None else min(e[1][0],y0); e[1][1]=y1 if e[1][1] is None else max(e[1][1],y1)
    for node in spec.get("nodes",[]):
        text=node["text"]; fs=node.get("fontSize",18); pad=node.get("padding",36)
        lines = node.get("lines") or wrap_lines(text, max(node.get("width", 0) - 20, 120), fs)
        single = "\n".join(lines)
        minw = max(160, max((estimate_width(ln, fs) for ln in lines), default=0) + pad)
        w=max(node.get("width",0),minw); h=max(node.get("height",0), len(lines)*fs*1.25+16)
        x=node["x"]; y=node["y"]; color=node.get("color","neutral")
        stroke,bg=PALETTE[color]
        rid=node["id"]
        els.append(element_base(rid,"rectangle",x,y,w,h,stroke,bg))
        els.append(make_text(rid+"_text",single,x+10,y+8,w-20,h-16,"#222222",fs,"center"))
        body.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="5" fill="{bg}" stroke="{stroke}" stroke-width="2"/>')
        body.append(svg_text(x+10,y+8,w-20,h-16,single,fs,"#222","center"))
        node["_w"]=w; node["_h"]=h
        span(x,y,x+w,y+h)
    lookup={n["id"]:n for n in spec.get("nodes",[])}
    for i,edge in enumerate(spec.get("edges",[])):
        a=lookup[edge["from"]]; b=lookup[edge["to"]]
        wps=[list(p) for p in (edge.get("waypoints") or [])]
        start=anchor(a, wps[0] if wps else [b["x"]+b["_w"]/2, b["y"]+b["_h"]/2])
        end=anchor(b, wps[-1] if wps else [a["x"]+a["_w"]/2, a["y"]+a["_h"]/2])
        pts=[list(start)] + wps + [list(end)]
        color=PALETTE.get(edge.get("color","neutral"), PALETTE["neutral"])[0]
        dashed=bool(edge.get("dashed", False))
        els.append(make_arrow(f"edge_{i}",pts,color,dashed))
        body.append(svg_polyline(pts,color,dashed))
        for p in pts:
            span(p[0],p[1],p[0],p[1])
        if edge.get("label"):
            # label sits at the midpoint of the longest segment
            seg, best = None, -1.0
            for s0, s1 in zip(pts, pts[1:]):
                length = math.hypot(s1[0]-s0[0], s1[1]-s0[1])
                if length > best:
                    best, seg = length, (s0, s1)
            (x1,y1),(x2,y2)=seg
            mx=(x1+x2)/2; my=(y1+y2)/2-10
            label=edge["label"]; fs2=edge.get("fontSize",16); lw=max(80, estimate_width(label,fs2)+18)
            body.append(f'<rect x="{mx-lw/2:.1f}" y="{my-fs2:.1f}" width="{lw:.1f}" height="{fs2*1.45:.1f}" fill="#fff"/>')
            body.append(svg_text(mx-lw/2,my-fs2,lw,fs2*1.45,label,fs2,"#555","center"))
            span(mx-lw/2, my-fs2, mx+lw/2, my-fs2+fs2*1.45)
    # symmetric margin on ALL four sides so strokes, arrowheads, and routed
    # connectors are never clipped by the SVG frame
    margin=32
    min_x, max_x = extents[0] if extents[0][0] is not None else (0, 0)
    min_y, max_y = extents[1] if extents[1][0] is not None else (0, 0)
    W=(max_x-min_x)+2*margin; H=(max_y-min_y)+2*margin
    svg=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{min_x-margin:.0f} {min_y-margin:.0f} {W:.0f} {H:.0f}" width="100%" height="100%">',
         '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#555"/></marker></defs>']
    svg.extend(body)
    svg.append('</svg>')
    doc={"type":"excalidraw","version":2,"source":"compiler-architecture-presentation","elements":els,"appState":{"gridSize":None,"viewBackgroundColor":"#ffffff"},"files":{}}
    args.excalidraw.parent.mkdir(parents=True,exist_ok=True); args.svg.parent.mkdir(parents=True,exist_ok=True)
    args.excalidraw.write_text(json.dumps(doc,ensure_ascii=False,indent=2),encoding="utf-8")
    args.svg.write_text("\n".join(svg),encoding="utf-8")
    print(args.excalidraw); print(args.svg)

if __name__=="__main__": main()
