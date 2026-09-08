#!/usr/bin/env python3
"""Create a simple Excalidraw source plus same-layout SVG fallback from a JSON spec.

The SVG fallback is deterministic and intended for embedding in offline HTML decks.
The .excalidraw file remains editable in Excalidraw.
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

def make_arrow(eid, x1, y1, x2, y2, color="#555555", dashed=False):
    w, h = x2-x1, y2-y1
    obj = element_base(eid, "arrow", x1, y1, w, h, color, "transparent", 2)
    obj.update({
        "points": [[0,0],[w,h]], "lastCommittedPoint": None,
        "startBinding": None, "endBinding": None, "startArrowhead": None, "endArrowhead": "arrow",
        "elbowed": False,
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

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("spec", type=Path)
    ap.add_argument("--excalidraw", type=Path, required=True)
    ap.add_argument("--svg", type=Path, required=True)
    args=ap.parse_args()
    spec=json.loads(args.spec.read_text(encoding="utf-8"))
    els=[]; body=[]
    content_max_w=spec.get("width", 1200); content_max_h=spec.get("height", 500)
    for node in spec.get("nodes",[]):
        text=node["text"]; fs=node.get("fontSize",20); pad=node.get("padding",36)
        minw=max(160, cjk_len(text)*18 + latin_len(text)*9 + pad)
        w=max(node.get("width",0),minw); h=node.get("height",60)
        x=node["x"]; y=node["y"]; color=node.get("color","neutral")
        stroke,bg=PALETTE[color]
        rid=node["id"]
        els.append(element_base(rid,"rectangle",x,y,w,h,stroke,bg))
        els.append(make_text(rid+"_text",text,x+10,y+8,w-20,h-16,"#222222",fs,"center"))
        body.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="5" fill="{bg}" stroke="{stroke}" stroke-width="2"/>')
        body.append(svg_text(x+10,y+8,w-20,h-16,text,fs,"#222","center"))
        node["_w"]=w; node["_h"]=h
        # real content extents: rendered boxes are measured from label text and
        # can exceed the layout's assumed NODE_W/NODE_H grid
        content_max_w=max(content_max_w, x+w); content_max_h=max(content_max_h, y+h)
    lookup={n["id"]:n for n in spec.get("nodes",[])}
    for i,edge in enumerate(spec.get("edges",[])):
        a=lookup[edge["from"]]; b=lookup[edge["to"]]
        acx=a["x"]+a["_w"]/2; acy=a["y"]+a["_h"]/2
        bcx=b["x"]+b["_w"]/2; bcy=b["y"]+b["_h"]/2
        dx=bcx-acx; dy=bcy-acy
        if abs(dx) >= abs(dy):
            if dx >= 0:
                x1=a["x"]+a["_w"]; y1=acy; x2=b["x"]; y2=bcy
            else:
                x1=a["x"]; y1=acy; x2=b["x"]+b["_w"]; y2=bcy
        else:
            if dy >= 0:
                x1=acx; y1=a["y"]+a["_h"]; x2=bcx; y2=b["y"]
            else:
                x1=acx; y1=a["y"]; x2=bcx; y2=b["y"]+b["_h"]
        color=PALETTE.get(edge.get("color","neutral"), PALETTE["neutral"])[0]
        els.append(make_arrow(f"edge_{i}",x1,y1,x2,y2,color,edge.get("dashed",False)))
        dash=' stroke-dasharray="8 6"' if edge.get("dashed",False) else ''
        body.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="2.5"{dash} marker-end="url(#arrow)"/>')
        content_max_w=max(content_max_w, x1, x2); content_max_h=max(content_max_h, y1, y2)
        if edge.get("label"):
            mx=(x1+x2)/2; my=(y1+y2)/2-10
            label=edge["label"]; fs=edge.get("fontSize",16); lw=max(80, estimate_width(label,fs)+18)
            body.append(f'<rect x="{mx-lw/2:.1f}" y="{my-fs:.1f}" width="{lw:.1f}" height="{fs*1.45:.1f}" fill="#fff"/>')
            body.append(svg_text(mx-lw/2,my-fs,lw,fs*1.45,label,fs,"#555","center"))
    margin=24
    W=content_max_w+margin; H=content_max_h+margin
    svg=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" width="100%" height="100%">',
         '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#555"/></marker></defs>']
    svg.extend(body)
    svg.append('</svg>')
    doc={"type":"excalidraw","version":2,"source":"compiler-architecture-presentation","elements":els,"appState":{"gridSize":None,"viewBackgroundColor":"#ffffff"},"files":{}}
    args.excalidraw.parent.mkdir(parents=True,exist_ok=True); args.svg.parent.mkdir(parents=True,exist_ok=True)
    args.excalidraw.write_text(json.dumps(doc,ensure_ascii=False,indent=2),encoding="utf-8")
    args.svg.write_text("\n".join(svg),encoding="utf-8")
    print(args.excalidraw); print(args.svg)

if __name__=="__main__": main()
