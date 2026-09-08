#!/usr/bin/env python3
from __future__ import annotations
import argparse, shutil
from pathlib import Path

def main() -> int:
    ap=argparse.ArgumentParser(description='Create a Quarto-first compiler presentation project')
    ap.add_argument('--title', required=True)
    ap.add_argument('--subtitle', default='目标 · 机制 · 关键决策 · 边界',
                    help='subject-adaptive decks state their own subtitle; the pass-shaped default (目标 · Pipeline · IR · 合法性 · 缺陷) is an explicit opt-in for raw pass-source fallback decks')
    ap.add_argument('--output', required=True, type=Path)
    ap.add_argument('--template', type=Path, default=Path(__file__).resolve().parents[1]/'assets'/'quarto-project-template')
    args=ap.parse_args()
    if not args.template.is_dir(): ap.error(f'template not found: {args.template}')
    if args.output.exists() and any(args.output.iterdir()): ap.error(f'output directory is not empty: {args.output}')
    shutil.copytree(args.template, args.output, dirs_exist_ok=True)
    qmd=args.output/'slides.qmd'
    text=qmd.read_text(encoding='utf-8').replace('{{TITLE}}',args.title.replace('"','\\"')).replace('{{SUBTITLE}}',args.subtitle.replace('"','\\"'))
    qmd.write_text(text,encoding='utf-8')
    (args.output/'diagrams').mkdir(exist_ok=True)
    (args.output/'code').mkdir(exist_ok=True)
    print(args.output)
    return 0
if __name__=='__main__': raise SystemExit(main())
