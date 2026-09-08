# Quarto Reveal.js Visual Reference for Compiler Slides

Use this reference when composing or reviewing the visual design of a compiler architecture deck. The target is the visual language of Quarto's official Reveal.js demo, adapted for bilingual Chinese/English technical presentations.

## 1. Core visual language

Anchor the deck to these Quarto/Reveal defaults:

- White slide canvas: `#ffffff`.
- Primary text: near-black `#222222`.
- Link / primary accent: Quarto blue near `#2a76dd`.
- Muted text: medium gray derived from body text.
- Body line height: about `1.3`-`1.36`.
- Heading line height: about `1.15`-`1.2`.
- Heading weight: `600`, not extra-bold.
- Small border radius: about `3px` for code, tables, and callouts.
- No decorative shadows, glassmorphism, gradients, or dark hero backgrounds by default.
- Title slide: centered, white background, generous vertical whitespace.
- Content slides: left-aligned titles and content, matching Quarto's normal reading flow.

## 2. Bilingual typography

Do not bundle or expose font binaries. Use resilient system font stacks.

### Sans-serif stack

Use a Latin-first stack that falls through to a high-quality CJK sans font:

```css
font-family:
  "Source Sans 3",
  "Source Sans Pro",
  "Noto Sans CJK SC",
  "Source Han Sans SC",
  "PingFang SC",
  "Microsoft YaHei",
  "Hiragino Sans GB",
  Helvetica,
  Arial,
  sans-serif;
```

### Monospace stack

Use:

```css
font-family:
  SFMono-Regular,
  Menlo,
  Monaco,
  Consolas,
  "Liberation Mono",
  "Sarasa Mono SC",
  "Noto Sans Mono CJK SC",
  monospace;
```

### Chinese/English harmony rules

- Do not apply positive letter-spacing to Chinese headings or mixed Chinese/English titles.
- Do not uppercase mixed bilingual headings automatically.
- Use weight 600 for H1/H2; avoid extreme boldness.
- For mixed titles such as `MergeVecScope：核心流程`, keep the English identifier unchanged and render the Chinese naturally.
- Use `line-break: strict` and `word-break: normal` for Chinese prose.
- Keep CJK body line-height around `1.35` when a slide is Chinese-heavy.
- Use Chinese punctuation in prose and ASCII punctuation in code.

## 3. Layout rhythm

Default slide composition:

1. concise title at top;
2. optional one-line Chinese claim;
3. main content region using one of:
   - single column;
   - 50/50 columns;
   - 60/40 columns;
   - code + explanation;
   - figure/diagram + caption;
   - table;
   - equation / IR block.
4. optional aside/source line at the bottom.

Prefer native document flow. Use absolute positioning only when a diagram genuinely requires precise placement.

## 4. Content element styling

### Code

- White or very light neutral background.
- Thin gray border only when needed.
- Avoid black code panels on otherwise white slides.
- Prefer line highlighting with a pale yellow or pale blue background.
- Split code across slides before reducing below readable size.

### Callouts

- white or very light background;
- semantic colored left border;
- no floating dashboard-card look;
- use only when the content is truly a note, warning, tip, or important constraint.

### Tables

- Minimal horizontal rules.
- Avoid full boxed grids unless the matrix needs them.
- Use semantic color only in compact status/priority cells.

### Diagrams

Blend Quarto restraint with Excalidraw discipline:

- white background;
- thin neutral strokes;
- one blue accent for focus/current pass;
- semantic amber/red/green only for warnings, reject paths, and success/internal flow;
- no large filled dark rectangles;
- direct local labels instead of oversized legends;
- reserve enough room for Chinese labels.

## 5. Title and closing slides

The default title slide must remain light and minimal:

- white background;
- centered pass/component name;
- one short keyword subtitle;
- optional compact metadata line;
- no paragraph text.

The closing slide should also be white by default. Use a concise `总结` or `Takeaways` slide with at most three points. Do not switch to a dark closing slide unless explicitly requested.

## 6. Anti-patterns

Reject these unless explicitly requested:

- dark title / light body / dark close as a fixed sandwich;
- full-slide gradients;
- oversized metric cards on title slides;
- repeated rounded-card grids;
- dashboard-like KPI tiles;
- strong shadows;
- dark code windows on every code slide;
- decorative section-divider slides that add no information;
- long cover subtitles;
- visible generator / skill attribution on the slide canvas.

## 7. Compiler-specific adaptation

Keep Quarto's visual simplicity while adding domain-specific structures:

- Pipeline: a simple horizontal sequence with thin connectors and one blue-highlighted target pass.
- IR before/after: two aligned light code columns; changed lines use pale highlight.
- Algorithm: numbered list or a thin step rail.
- Dependency architecture: flat node-edge diagram on white, with minimal semantic coloring.
- Legality funnel: compact decision tree with red `REJECT` labels.
- Risk review: simple table.
- Roadmap: clean three-column text layout with colored top rules.

The visual priority is always: **content readability > diagram clarity > style decoration**.
