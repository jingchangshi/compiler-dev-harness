---
name: compiler-architecture-presentation
whenToUse: Use when turning compiler architecture, pass, class, algorithm, subsystem, or pipeline knowledge (code, IR, design notes, or an existing PresentationHandoff) into presentation slides.
description: Create evidence-first compiler presentations. Two entry paths — handoff-first (consume a READY PresentationHandoff bundle as the semantic source of truth, no source re-analysis) and raw-input fallback (source/notes → evidence → story → slides). Quarto/QMD-first, Chinese-first technical writing, Excalidraw-first editable diagrams, Reveal.js browser presentation, HTML as a build artifact.
---

# Compiler Architecture Presentation

## Objective

Turn compiler implementation knowledge into a presentation that explains both **how the code works** and **why the design is correct or risky** — without ever re-deriving, from source, a story that a READY PresentationHandoff already tells.

Default deliverable: a maintainable presentation project whose source of truth is:

- `slides.qmd` for content and layout;
- `styles.scss` for typography and visual system;
- `diagrams/*.excalidraw` for editable flow/architecture diagrams;
- `diagrams/*.svg` as the rendered/static diagram assets referenced by QMD;
- `presentation-manifest.json` (handoff-first projects) recording what was consumed and how;
- `_site/slides.html` as the Quarto Reveal.js build output when Quarto is available.

Do **not** hand-author the final HTML as the primary source unless the user explicitly asks for raw HTML.

Default audience: Chinese-speaking technical listeners comfortable with English identifiers, pass names, options, filenames, and IR/code.

## Producer / consumer ownership (formal contract)

```text
Code Explanation producer (compiler_explain)          Presentation consumer (this skill)
────────────────────────────────────────              ──────────────────────────────────
what should be understood and told                    how to tell it visually
mental model, need, storyline                         slide boundaries and count
canonical example, important decisions                layout, typography, hierarchy
comparisons, key takeaways                            diagram geometry, CJK width
semantic visual requirements (nodes/edges/roles)      code placement, animation/build
evidence references (fact vs reasoning)               QMD, Excalidraw, SVG, HTML
```

The consumer does NOT own: re-judging why a pass exists, re-deriving the core algorithm, re-ranking which strategy matters, re-picking the canonical example, re-constructing a legality story, or re-discovering source evidence — **unless the handoff is missing / not READY / STALE, or the user explicitly asks for source re-verification** (then the refresh belongs to the producer workflow, see Mode B / Source re-verification).

`PresentationHandoff ≠ slides`, and presentation ≠ source re-analysis.

## Input modes — decide FIRST, before any content work

### Mode A — READY PresentationHandoff (preferred)

Preconditions (all enforced by the deterministic preflight):

```text
handoff.json exists + bundle schema valid + readiness == READY
+ bundle FRESH (staleness false) + schema version supported
```

Run first, always:

```bash
node <harness>/scripts/preflight-handoff.mjs <bundle-dir> [--subject-id <id>] [--repo-root <dir>]
```

`CONSUMABLE` returns a bounded **consumption digest** (storyline steps, visual specs, must-have visual ids, canonical example, key takeaways, evidence index, dossier pointers). That digest — not the source tree — is the semantic input. Do not re-run repository-wide evidence acquisition or story extraction. Reading the dossier/evidence is allowed and expected for slide notes, diagram labels, and citations, but the handoff's semantic story stands; any deviation is recorded in the manifest `adaptations` with a reason.

Verdicts and their meanings:

- `CONSUMABLE` → proceed handoff-first.
- `NOT_CONSUMABLE` → do not generate from this bundle; fall back to Mode B/C and say why.
- `STALE_PRESENTATION_INPUT` → stop; the explanation bundle must be refreshed through the code-explanation producer first. Never edit recorded SHAs to bypass.
- `UNSUPPORTED_SCHEMA` → stop clearly; never guess fields of an unknown schema version.

A system-story handoff (Phase T3 composition of multiple child bundles) is consumed exactly like any other Mode A handoff — there is no system-story mode and no special case: the storyline, visuals, canonical example, takeaways, and evidence index in the handoff are the deck's semantic input regardless of whether the subject is one class or a multi-pass pipeline. Recursion is invisible here: the preflight already refuses when any consumed child bundle (via composition imports) is stale.

**Deck reuse (Phase T4).** The manifest is also the reuse key: an existing presentation project whose `presentation-manifest.json` records the CURRENT handoff hash (and composition hash, for system stories) of a READY+FRESH bundle is still valid — do not regenerate the same deck. The orchestration control plane (`compiler_explain run-status` / `run-finalize`) checks this deterministically before asking for presentation work; when it reports a deck `reused`, the correct action is no deck action. If the handoff hash changed, the deck is invalidated — rebuild it through Mode A from the refreshed handoff, never by patching the old deck in place.

### Mode B — TeachingDossier exists but no PresentationHandoff

Do not invent the presentation story from the dossier yourself. Route back to the code-explanation workflow (`compiler_explain` / `skills/code-explanation/`) to produce the presentation-depth handoff, then return to Mode A:

```text
Dossier → Code Explanation producer → PresentationHandoff → Presentation
```

### Mode C — Raw source / design notes / user document (standalone fallback)

The original capability, preserved: establish evidence → extract the architecture story → design slides. Use when no explanation bundle exists and the user asks directly ("给我源码做 slides"), or for uploaded notes. The pass-shaped heuristics below apply **only here**.

## Handoff-first workflow (Mode A)

1. **Preflight** as above; capture `handoff_sha256`, `dossier_sha256`, `source_head`, `readiness` from the preflight output.
2. **Consume the digest**: the storyline positions/roles/claims are the deck's backbone; must-have visuals are semantic requirements; the canonical example is the worked example; key takeaways become the summary. Read `dossier_pointers` (mental model, mechanism stages with `file:line`, boundaries, risks) for notes and labels.
3. **Storyboard**: assign each storyline step to one or more slides (splitting a step or merging adjacent compatible steps is fine; dropping one is not — see coverage). Choose slide titles from the step roles/claims, subject-adaptively (a class deck talks responsibility/state/lifecycle/collaborators; an algorithm deck talks problem/iteration/termination/complexity — never force a pass narrative onto them).
4. **Visuals**: for each must-have visual, interpret the semantic spec into an editable diagram:

```bash
python3 skills/compiler-architecture-presentation/scripts/spec_to_diagram.py \
  --handoff <bundle>/handoff.json --visual V1 \
  --excalidraw diagrams/V1.excalidraw --svg diagrams/V1.svg
```

   This makes the positioning decisions (bounded shapes: pipeline/before_after/decision_tree/state_transition/sequence, grid fallback) and keeps the `.excalidraw` editable. Refine geometry for CJK width and readability; semantic content comes from the spec.
5. **Scaffold + write QMD** (see Quarto project workflow reference). Titles short, Chinese-first, no generator provenance.
6. **Manifest**: write `presentation-manifest.json` (shape below) recording input identity (hashes from preflight), consumed storyline→slides mapping, must-have visual→asset/slide mapping, evidence ids used, and every adaptation with its reason.
7. **Check**:

```bash
python3 <PROJECT_DIR>/scripts/check_project.py [--handoff <bundle>/handoff.json]
```

8. **Render** if Quarto is available (`make render`); otherwise generate the full project + SVGs, run the checker, and state clearly that `_site/slides.html` must be produced locally (`HTML NOT RENDERED — Quarto unavailable`). Never fabricate a build.

## Presentation consumption manifest

`presentation-manifest.json` (project root, handoff-first projects only) is consumer provenance — NOT a new knowledge layer:

```json
{
  "artifact": "presentation_manifest",
  "schema_version": 1,
  "input": { "bundle_id", "subject_id", "subject_type", "handoff_schema_version",
             "handoff_sha256", "dossier_sha256", "source_head",
             "readiness_verdict": "ready", "preflight": "CONSUMABLE" },
  "consumed": {
    "storyline": [ { "position": 1, "role": "…", "disposition": "consumed|split|merged|appendix|omitted",
                     "slides": ["<slide header text>", …], "reason": "… (required for appendix/omitted)" } ],
    "must_have_visuals": [ { "id": "V1", "assets": ["diagrams/V1.excalidraw", "diagrams/V1.svg"],
                             "slides": ["…"] } ],
    "optional_visuals": [ { "id": "V4", "used": false } ],
    "key_takeaways": ["…"],
    "evidence_ids": ["EV-013", "…"],
    "canonical_example": { "summary": "…", "slide": "…" }
  },
  "adaptations": [ { "source_element": "…", "presentation_decision": "…", "reason": "…" } ],
  "generated": { "qmd": "slides.qmd", "diagrams": ["…"], "rendered": null }
}
```

Coverage obligations (checker-enforced): every handoff storyline step appears with a disposition and slide mapping — `appendix`/`omitted` require a recorded reason, silent drops fail; every must-have visual maps to existing assets and a slide; manifest evidence ids must be a subset of the handoff evidence index; recorded handoff hash must match the consumed file. Never record prompts, transcripts, or large source excerpts.

Evidence traceability stays intact end to end — `slide claim → handoff step → evidence ids → evidence ledger` — without stuffing `file:line` onto every visible slide; visible evidence goes in footers, speaker notes, appendix, or an evidence slide per presentation judgment.

## Handoff authority rules (Mode A)

- **Storyline**: `handoff.storyline` is the semantic ordering source of truth. You may split one step into multiple slides, merge adjacent compatible steps, or move deep detail to the appendix — preserving claim meaning, order constraints, learning objectives, and key takeaways. Changing the story requires recording the reason in `adaptations`; silent overrides are contract violations.
- **Canonical example**: `handoff.canonical_example` is the deck's example. Reducing it to a readable excerpt is a presentation adaptation (keep the mapping); substituting a different example is not allowed.
- **Must-have visuals**: semantic requirements, not optional decoration. You decide how to draw them, how many diagrams, node geometry, CJK label width — but omitting one requires a recorded reason and fails the checker if unmapped.
- **Evidence epistemics**: never present reasoning as source fact, never present a reconstructed example as executed, never blur the fact/reasoning distinctions when condensing.
- **User-requested source re-verification**: run the staleness check, refresh the explanation bundle via the code-explanation producer, re-gate READY, then present. The presentation skill never silently overwrites a handoff while reading source.

## Fallback narrative for raw compiler evidence (Mode C only)

When no READY handoff exists and you are working from raw pass source, this canonical narrative remains a good heuristic — it is a fallback, not the system's shape:

1. `problem-background` — 问题 / 动机 / 优化目标
2. `pipeline-position` — pipeline 位置及前后 IR
3. `ir-before-after` — 最小 IR/code 前后对比
4. `core-algorithm` — 核心算法与关键数据结构
5. `dataflow-architecture` — 数据/依赖/移动边界
6. `corner-cases` — legality、拒绝条件、限制
7. `design-defects` — 假设、崩溃路径、覆盖缺口
8. `improvement-proposals` — P0/P1/P2 改进与验证

A title slide and final `总结` slide may wrap these sections. **Handoff precedence is absolute**: `handoff.storyline > fallback canonical narrative` whenever Mode A preconditions hold. In Mode C, adapt the narrative to the actual subject — a class deck is responsibility/state/lifecycle/collaborators, an algorithm deck is problem/mental model/iteration/termination/complexity/boundaries; do not fabricate pipeline/IR/legality sections for subjects that have none.

## Non-negotiable presentation rules

1. **Chinese-first writing.** Outside code/IR, write primarily in Chinese; keep English for identifiers, options, APIs, filenames, IR.
2. **Short titles.** One line when possible; never put detailed reasoning in the title.
3. **Minimal cover.** Component/subject name + short keyword subtitle + compact metadata.
4. **No visible generator provenance.** Never show `generated by`, `created with`, `AI generated`, `... Skill`.
5. **Readable browser presentation.** Quarto Reveal.js at 1600×900; no unpredictable responsive rewrapping.
6. **Excalidraw-first diagrams.** Editable `.excalidraw` source first, paired SVG referenced from QMD; keep labels short and reserve CJK width; node boxes must not overlap; edges avoid crossing nodes; REJECT branches stay separated; long pipelines get enough horizontal spacing; split overloaded figures instead of shrinking text.

## Slide roles

Mode A: derive roles from the handoff (storyline roles, visual kinds, decisions, comparisons) — e.g. `hero`, `why`, `mental-model`, `mechanism`, `worked-example`, `decision-tree`, `state-transition`, `strategy-compare`, `boundary`, `risk`, `summary`, `evidence`. Mode C pass decks may use the classic roles (`problem`, `pipeline`, `code-compare`, `algorithm`, `dependency-map`, `decision-tree`, `rewrite`, `evidence`, `risk-matrix`, `roadmap`, `summary`). Use roughly 8–12 slides; split content rather than shrinking text.

## Compiler-specific rules (raw fallback + label writing)

- **Pipeline diagrams**: show representation boundaries (tensor → memref, host → device) on the diagram.
- **IR before/after**: use real reduced IR from tests/evidence; mark simplified examples `示意`; show exactly what disappears/moves/fuses/is preserved.
- **Algorithm**: phases first; function names are secondary annotations.
- **Dataflow**: never merge SSA, memory/alias, control/region, and physical movement into one unlabeled arrow type.
- **Corner cases vs defects**: deliberately handled/rejected = corner case; incomplete/brittle/missing = defect/risk.
- **Improvements** (when the handoff/dossier carries risks): `P0 正确性`, `P1 稳健性 / 可维护性`, `P2 优化 / 覆盖`, each with a validation artifact.

## Visual system

Quarto Reveal.js baseline: white background, near-black text, Quarto-like blue accent, minimal decoration, light code blocks, shallow callouts, small radii, no dark sandwich, no KPI tiles. Font stacks from `references/quarto-reveal-style.md`.

## Deliverable contract

```text
<name>-slides/  (or analysis/presentations/<bundle>/)
├── slides.qmd
├── _quarto.yml
├── styles.scss
├── Makefile
├── presentation-manifest.json        # handoff-first projects only
├── diagrams/
│   ├── *.excalidraw
│   └── *.svg
├── code/
├── scripts/
│   ├── export-diagrams.sh
│   ├── check_project.py
│   └── validate_manifest.py
└── _site/slides.html                 # only if Quarto render succeeded
```

Also package the project as a ZIP when convenient so the user can edit and rebuild locally.
