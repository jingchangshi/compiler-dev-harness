# Browser Display and Excalidraw Reference

Use this reference for Quarto Reveal.js compiler presentations shown directly in a desktop browser.

## 1. Browser presentation model

Use Quarto Reveal.js as the presentation runtime.

Configure a deterministic logical slide size in `_quarto.yml`:

```yaml
format:
  revealjs:
    width: 1600
    height: 900
    margin: 0.065
```

Let Reveal.js scale the complete slide to the current browser viewport. Do not recreate viewport scaling with custom JavaScript.

Avoid viewport-relative typography such as `vw`, `vh`, or aggressive `clamp()` rules that can change line breaks independently from the slide scale.

## 2. Safe layout assumptions

Treat the 1600x900 Reveal canvas as the logical design surface.

Keep:

- titles concise;
- normal content within Quarto/Reveal margins;
- diagrams below roughly 560 logical px in height unless the slide is diagram-only;
- code blocks short enough to remain readable without scrolling;
- source notes small but visible.

If a slide overflows, split it. Do not hide overflow or shrink all text to compensate.

## 3. Quarto-first layout

Prefer Quarto-native structures:

- headings;
- `::: columns` / `::: {.column}`;
- code fences;
- callouts;
- Markdown tables;
- images with size classes;
- concise source notes.

Use raw HTML only when Quarto cannot express the layout cleanly.

## 4. Excalidraw-first diagrams

For pipelines, process diagrams, dependency graphs, and legality trees:

1. create a valid `.excalidraw` source;
2. export or generate a paired `.svg`;
3. reference the SVG from `slides.qmd`;
4. keep the `.excalidraw` source beside it;
5. when modifying the diagram, edit `.excalidraw` first and regenerate the SVG.

Recommended Excalidraw appearance:

- `roughness: 0` for a clean technical look;
- `fillStyle: solid`;
- white canvas;
- thin neutral strokes;
- Quarto blue for focus;
- green / amber / red only for semantic states;
- minimal containers;
- simple arrows.

## 5. CJK-aware sizing

Chinese labels require more width than Latin labels.

For approximately 20px diagram text, use conservative sizing:

- Latin width ~= `0.55 * fontSize * charCount`;
- CJK width ~= `1.0 * fontSize * charCount`;
- add 32-40px horizontal padding per node.

A simpler source-generation heuristic is acceptable:

- Latin: `max(160, charCount * 9)`;
- CJK: `max(160, charCount * 18)`.

Keep node labels to roughly 1-4 words or a short phrase. Move detailed explanation to QMD prose.

## 6. Diagram spacing

Recommended minimums on a 1600x900 logical slide:

- node-to-node gap: >= 55px;
- label-to-shape edge: >= 16px;
- diagram boundary to content boundary: >= 35px;
- prefer 3-8 primary entities per figure.

Route arrows around labels and boxes. Avoid spaghetti edges.

## 7. Render-and-verify

When an Excalidraw renderer is available:

1. render/export SVG or PNG;
2. inspect the result;
3. fix clipping, overlaps, bad routing, or unreadable text;
4. regenerate before delivery.

When no renderer is available, generate the editable `.excalidraw` plus a deterministic same-geometry SVG fallback. State this accurately; do not claim the fallback was rendered by Excalidraw.

## 8. Browser QA after Quarto build

After `quarto render slides.qmd`, inspect the resulting Reveal.js deck at common browser sizes such as:

- 1366x768;
- 1440x900;
- 1920x1080.

Check:

- no slide content is clipped;
- no image or SVG exceeds its slide area;
- Chinese labels remain readable;
- code does not require tiny fonts;
- tables do not spill horizontally;
- cover and titles remain concise.
