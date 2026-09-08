# Compiler Presentation Guidelines

This document defines the writing and layout quality bar for the `compiler-architecture-presentation` skill.

## 1. Default audience and language

Assume the audience is technically strong but time-constrained. They want a clear explanation of the pass architecture, not a wall of prose.

Default language policy:

- prose: **Chinese-first**;
- identifiers, pass names, filenames, options, API names, IR ops: keep original English;
- diagrams: short Chinese labels + necessary English identifiers;
- code/IR: keep authentic syntax; add Chinese explanation outside the code block.

If the user does not explicitly ask for English slides, do not let the deck drift into English-majority prose.

## 2. Title discipline

Every slide title should behave like a signpost, not a paragraph.

Preferred title styles:

- `为什么要合并 VF？`
- `Pass 在哪里执行？`
- `合并前`
- `合并后`
- `核心流程`
- `依赖模型`
- `tryMerge 在判什么？`
- `主要缺陷`
- `改进建议`
- `总结`

Rules:

- keep titles to one line when possible;
- hard cap at two lines;
- avoid stacking multiple clauses with commas/semicolons;
- detailed explanation belongs in body text, callouts, tables, or asides.

## 3. Title slide discipline

The cover slide must be terse.

Allowed:
- pass/component name;
- a short keyword subtitle;
- 0-1 metadata lines such as repository/branch/commit or pass option.

Not allowed:
- long explanatory subtitle;
- repeated title phrases;
- paragraph text;
- any visible note about the generation tool, skill, or style template.

Good subtitle examples:
- `目标 · Pipeline · IR · 合法性 · 缺陷`
- `问题 · 算法 · 依赖 · 风险`
- `Pipeline · Rewrite · Review`

## 4. Quarto baseline, not dashboard style

Use Quarto Reveal.js as the baseline visual language:

- white background;
- near-black text;
- blue accent;
- normal document flow;
- shallow callouts;
- light code blocks;
- small corner radius;
- minimal decoration.

Avoid:
- dark sandwich decks;
- full-slide hero graphics;
- dashboard KPI tiles;
- shadow-heavy cards;
- decorative gradients;
- gratuitous section divider slides.

## 5. Excalidraw-inspired diagram rules

Take inspiration from high-quality Excalidraw systems, but implement the final figure using HTML/CSS/SVG.

### Structural rules

- open white canvas;
- thin strokes;
- rounded corners / rounded connectors;
- simple geometry;
- low label density;
- one local story per diagram.

### Text rules inside diagrams

- keep node labels short;
- do not put sentence-length text inside boxes;
- reserve extra width for Chinese text;
- prefer nearby annotation text outside the figure for details;
- every label must stay within the shape or safe whitespace.

### Practical rules

- if the figure becomes crowded, split it into two slides;
- avoid three separate legends if direct labeling is enough;
- use color semantically: blue focus, green success/internal flow, amber caution, red reject;
- keep the number of colors small.

## 6. Content hierarchy per slide

Recommended hierarchy:

1. concise title;
2. one-sentence Chinese claim or setup line if needed;
3. main body content (figure / code / table / steps / bullets);
4. compact callout for the single most important note;
5. optional small source / evidence line.

Do not let the title or subtitle carry the full explanation.

## 7. Body text density

- Prefer 3-5 bullets on a content slide.
- Prefer 1-2 short sentences per bullet.
- Avoid wide paragraphs.
- Use callouts or compact tables when the content is evaluative.
- Split content across more slides instead of shrinking text aggressively.

## 8. Typography and spacing

- Use the bilingual Latin+CJK sans and monospace stacks from `quarto-reveal-style.md`.
- Titles: usually 28-42 px.
- Body text: usually 16-22 px.
- Code: usually 13-18 px.
- Preserve 7-8% side margins.
- Keep at least ~22 px separation between conceptual groups.
- Do not use `word-break: break-all` in prose.

## 9. IR/code presentation

Keep examples narrow and intentional. Prefer 6-14 visible lines per code panel.

For before/after comparisons:
- preserve stable names where possible;
- highlight only the decisive lines;
- explain the change in Chinese alongside the code;
- mark simplified examples as `示意` or `schematic`.

## 10. Evidence hierarchy

Prefer, in order:

1. current source implementation;
2. current tests and pipeline configuration;
3. commit/PR history explaining intent;
4. design documents supplied by the user;
5. reviewer inference.

Mark inference explicitly.

## 11. Review lens for compiler defects

Inspect at least:

- representation assumptions;
- dominance and region boundaries;
- alias and memory-effect precision;
- dependency closure and graph updates;
- multi-use / multi-call behavior;
- attribute/type propagation;
- failure behavior and diagnostics;
- deterministic ordering;
- compile-time complexity;
- profitability versus legality;
- test coverage for negative and adversarial cases.

## 12. Mandatory QA before delivery

Perform a visible-slide QA pass.

Checklist:

- [ ] Most prose is Chinese.
- [ ] Slide titles are concise.
- [ ] The cover is minimal and non-repetitive.
- [ ] No visible `generated by`, `created with`, `skill`, or similar tool attribution remains.
- [ ] Diagram text stays inside the canvas.
- [ ] No labels cross the slide edge.
- [ ] Code and tables remain readable.
- [ ] The deck still feels like a clean technical presentation, not a dashboard.

If any item fails, revise the deck before presenting it.

## 13. Anti-patterns

Reject these patterns during QA:

- English-dominant prose on a Chinese talk deck;
- titles that are longer than the body bullets;
- long cover subtitles that restate the title;
- any slide containing visible generator/skill attribution;
- diagrams packed so tightly that Chinese labels overflow;
- solving crowding only by shrinking fonts;
- every slide being a 2x2 or 3-card grid;
- dark background behind dense code on many slides;
- excessive legends instead of local labels.
