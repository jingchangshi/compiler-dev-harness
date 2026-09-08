# Quarto/QMD-first Project Workflow

Use this reference when generating a maintainable compiler presentation project.

## Source of truth

Treat these as editable sources:

- `slides.qmd`: slide content and layout;
- `styles.scss`: typography, colors, spacing, slide-specific styling;
- `diagrams/*.excalidraw`: editable diagram sources;
- `diagrams/*.svg`: exported/static diagram assets referenced by QMD;
- `code/*`: optional reduced IR/code snippets used by slides.

Treat `_site/slides.html` as a build artifact, not as the primary editable source.

## Local workflow

Preview while editing:

```bash
make preview
```

or:

```bash
quarto preview slides.qmd
```

Render final HTML:

```bash
make render
```

The default `_quarto.yml` uses Reveal.js, a 1600x900 slide canvas, Quarto/Reveal browser navigation, and `embed-resources: true` so the final HTML can be distributed as a single file.

## Diagram workflow

Edit the `.excalidraw` file in Excalidraw, then export/update the paired SVG before rendering slides.

```bash
make diagrams
make render
```

When an Excalidraw CLI is unavailable, keep a checked-in SVG fallback alongside each `.excalidraw` source. Do not modify only the SVG if the change should remain editable; update the `.excalidraw` source first.

## Content editing

Prefer editing Markdown/QMD rather than generated HTML. Use Quarto columns, callouts, tables, code blocks, and image attributes. Use raw HTML only for a layout Quarto cannot express cleanly.

## Build output

Expected tree:

```text
project/
├── slides.qmd
├── _quarto.yml
├── styles.scss
├── Makefile
├── diagrams/
│   ├── pipeline.excalidraw
│   ├── pipeline.svg
│   └── ...
├── code/
├── scripts/
└── _site/
    └── slides.html
```
