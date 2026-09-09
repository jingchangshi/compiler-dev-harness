# Quarto content semantics — canonical QMD forms

> Consumer-owned reference (presentation skill). It fixes how *semantic intent*
> (evidence, lists, comparisons, notes) is expressed in `slides.qmd` so that the
> Quarto Reveal.js render is deterministic and readable at 1600×900.
> The Code Explanation producer never writes QMD; these forms are presentation
> decisions. All examples are generic — substitute subject-adaptive content.

Rule of thumb: **every block must survive Quarto's renderer unchanged in
meaning**. Anything that only works by luck of Pandoc parsing (bracketed
footnote syntax, mid-paragraph separator chains) is not a canonical form.

## 1. Evidence footer (slide-level source/evidence line)

Slide-bottom source/evidence information uses the `footer` fenced div as the
**last block of the slide**, before the next slide header:

```markdown
## 机制总览

正文内容……

::: footer
证据：`src/foo.cpp:120-210` · EV-013 / EV-014
:::
```

- One footer per slide at most; it carries evidence pointers, never new
  technical claims (new claims belong to the producer, in the handoff).
- Styling comes from the project's `styles.scss` `.reveal .footer` rule
  (small, muted, bottom-anchored) — the template ships it.
- **Forbidden**: `.footnote[...]` (Pandoc bracket syntax). Quarto Reveal.js
  renders it as literal text in the HTML — it is not a Quarto form. The
  project checker fails any `.footnote[` occurrence.

## 2. Semantic lists (parallel items are real lists)

Any set of parallel items — capability scopes, reject reasons, unsupported
cases, risks — is a real Markdown list: **one `- ` item per element**. Never
join parallel items into one paragraph with `·` separators:

```markdown
::: {.danger}
**✘ 设计拒绝**

- 跨 region 改写
- gap 含同步指令
- extract-kind 不匹配
:::
```

- A lead-in label (`✘ 设计拒绝` / `✔ 支持` / `◐ 部分支持` / `? 未知`) is its
  own bold line (or `::: {.good}`/`{.warn}`/`{.danger}`/`{.muted}` callout),
  followed by a list — never `label` + `a · b · c` prose.
- The checker flags paragraphs (outside code/tables) containing ≥ 3 `·`
  separators as mis-rendered lists. Short prose may legitimately contain one
  or two `·`; three or more parallel items is a list.
- Use `·` only *inside* a single short phrase where it is punctuation, not a
  list separator.

## 3. Column layouts

Two-column comparisons use `::: {.columns}` with `::: {.column width="..%"}`
children, as in the template. Each column contains structured blocks (list,
code, callout) — not one long prose paragraph. A before/after pair pairs a
left "before" column with a right "after" column and states what moves in a
boundary line below.

## 4. Code and IR

- Fenced code blocks with a language tag (` ```mlir `).
- Mark simplified IR `示意`; executed/collected output cites its evidence in
  the slide footer (form 1).
- Keep lines ≤ ~90 chars; long IR belongs in `code/` with the interesting
  lines shown.

## 5. Speaker notes and appendix

- Presenter-only text goes in `::: {.notes}` blocks — never on the visible
  slide.
- Appendix slides are normal `##` slides placed after the summary; the
  manifest records deferred storyline steps with disposition `appendix`.

## 6. Diagrams

- Reference the SVG (not `.excalidraw`) from QMD: `![](diagrams/V1.svg){.diagram}`.
- Wide figures use `{.diagram .diagram-wide}`; if a figure would render text
  below readable size at 1600×900, split the figure instead of shrinking text
  (the geometry checker enforces this deterministically).
- Keep `diagrams/*.excalidraw` as the editable source of truth; regenerate
  SVGs via `make render` / `scripts/export-diagrams.sh`.

## 7. Slide headers are manifest keys

`## Header text` lines are the slide identity recorded in
`presentation-manifest.json` (`consumed.storyline[].slides`). Keep headers
short, unique, and stable — the checker matches them verbatim.
