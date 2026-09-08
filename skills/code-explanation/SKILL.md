---
name: code-explanation
description: Generic repository-first workflow that turns any code object — function, class, algorithm, pass, module, subsystem, pipeline, scheduler, data structure, or cooperating component group — into evidence-backed mechanism, teaching, and presentation-handoff artifacts.
whenToUse: Use when the user asks to explain, break down, or teach a code object ("解释/梳理 X 的机制", "X 是怎么实现的", "分析 X 的架构", "我要把 X 讲给别人", "给 X 形成 slides 前置材料"), or before handing technical knowledge to the presentation system.
---

# Code explanation (generic teaching workflow)

The preset's always-on code-explanation section binds the invariants; this skill adds the working detail. One workflow serves every subject type — never design a per-subject process. The deterministic tools (`compiler_inspect`, `compiler_knowledge`, git, test runs) own facts; you own understanding: mechanism reconstruction, teaching reconstruction, and the presentation story.

## The four artifacts (and what each is for)

```text
subject.json     AnalysisSubject  — what is being explained, where it lives, provenance
evidence.json    Evidence ledger  — statements classed source_fact / graph_fact /
                                    runtime_fact / historical_fact / reasoning /
                                    hypothesis / unknown, each citing its tool
dossier.json     TeachingDossier  — mechanism + teaching reconstruction (common
                                    core + exactly one type extension)
handoff.json     PresentationHandoff — how the knowledge should be TOLD (optional
                                    until presentation depth)
readiness.json   ReadinessReport  — mechanical gate + recorded semantic review
```

All five are JSON under `analysis/explanations/<bundle>/` (bundle id: `<date>-<slug>-<type>`). `compiler_explain plan|validate|readiness|stale` scaffolds, checks, gates, and freshness-tests them. They are not markdown and not slides:

- **Evidence Artifact** = what the repository deterministically says (classes above).
- **Mechanism Model** = the source-derived stage reconstruction inside the dossier (`mechanism.stages`); names must come from the code's own behavior, never preset and never source-file order.
- **Teaching Dossier** = the full understanding a domain engineer needs (mental model, why, context, contracts, decisions, constraints, boundaries, takeaways).
- **Presentation Handoff** = the telling of that understanding (adaptive storyline, learning objectives, semantic visual specs, evidence index). **The handoff is not slides** — no layout, pixels, colors, or coordinates; the presentation system owns storyboard and layout.

## Workflow

### 1. Declare the subject

`compiler_explain plan` with `subject_type` (`function|class|algorithm|pass|module|subsystem|pipeline|data_structure|workflow|component_group|other`), `name`, `depth` (`overview|standard|deep|presentation`), and `why_this_subject`. Multi-entity requests ("解释 A、B、C 如何共同工作") are first-class: use `workflow` / `component_group` / `subsystem` and model A→B, A↔B interactions in `system_context`, `contracts`, and the mechanism stages. The plan returns the subject skeleton, the evidence plan, your type's extension fields, the readiness checklist, and the audience questions. Declare the task on `compiler_route` as `anchored-code-analysis` (when a pass/pipeline/finding angle exists) or `other`.

### 2. Gather evidence first (never explain from memory)

Follow the plan's evidence steps with the existing tools and keep the raw `file:line` work record:

- `compiler_knowledge` for graph facts (pass review, pipeline stages, findings) — the returned review records, guards, and evidence rows are `graph_fact` entries;
- `compiler_inspect` for definitions, callers, tests, history windows, and (for passes in real logs) IR-dump slices — `source_fact` / `historical_fact`;
- real test or tool runs for `runtime_fact`; a command you did not run is not runtime evidence;
- anything you infer is `reasoning` (or `hypothesis` if unverified and load-bearing); anything you could not determine is `unknown`.

The separation is the product: a teaching layer that blurs fact and inference is worthless. In the ledger, one statement per record, one id each (`EV-001`…); dossier/handoff elements cite these ids in `evidence_refs`.

### 3. Reconstruct the mechanism

Build the stage model from what the code does — `Acquire → Analyze → Decide → Transform → Update` shape only if the code has it. For each stage: what happens, where (`file:line`), key functions, and its evidence ids. Then set the two flags honestly — `mechanism.mutable_state` and `mechanism.has_important_branching` — they drive required checks (state transitions / decision model). Declare `control_flow` (who drives whom) and `data_flow` (what value moves where) separately when the subject is complex enough that a call graph alone would mislead.

### 4. Write the teaching dossier

Common core, filled only with what the subject actually has:

- `mental_model` — 1–3 sentences in domain language; a symbol dump fails the gate. If you cannot write it, the analysis is not deep enough yet.
- `need` / `responsibility` / `observable_outcome` — the why-model (never force a perf story onto a plain utility).
- `system_context` — who triggers/calls/creates it upstream, who consumes/relies on it downstream, with the interaction (causal context, not symbol references).
- `inputs` / `outputs` / `contracts` — forms and producers/consumers.
- `canonical_example` — for pass/algorithm/pipeline/subsystem/workflow/component_group it is mechanically required at standard+ depth. Provenance kinds: `test` > `production` > `probe` > `reconstructed`; label reconstructed examples and never present them as executed.
- `state_transitions` (`phase/before/operation/after/reason`), `decisions` (`question/condition/outcomes/reason`), `strategies` + `comparisons` only when ≥2 real paths exist, `constraints`/`invariants`/`assumptions` with `status` (`guarded|unguarded|verified|assumed|potential`), `boundaries` classified (`supported|partially_supported|rejected_by_design|unsupported|potential_risk|unknown`) — only where evidence supports the class; "I did not see code for X" is `unknown`, never `unsupported`.
- `placement` — why here / why not earlier / why not later; mark `applicable:false, status:"not_applicable"` when the question does not fit the subject.
- `ownership`, `complexity` (with provenance: derived / measured / reasoning / unknown), `key_takeaways` (3–5).

Then exactly one type extension under `extensions.<subject_type>` — pass fields (`pipeline_placements`, `ir_contract`, `legality`, `rewrite`, …) exist only there, never in the core. Field catalogs live in the plan output and `references/teaching-artifact-guide.md`.

### 5. Derive the presentation handoff (presentation depth)

`storyline` is your reasoning output and must adapt to the subject (a function is told differently than a subsystem); 3+ steps, each with its claim and dossier section. `visuals` are semantic specs only: `kind` (`architecture|pipeline|control_flow|data_flow|flowchart|decision_tree|state_transition|sequence|before_after|comparison|dependency_graph|ownership`), nodes/edges/groups/roles/ordering — the validator rejects any layout, pixel, or color key. `must_have_visuals` reference defined visual ids. `evidence_index` is a bounded subset of the ledger, not a copy of everything.

### 6. Gate readiness

`compiler_explain readiness` without `semantic_review` runs the mechanical gate: schema validity, fact-evidence presence, evidence resolution, mental-model floor, context both sides, mechanism stages, example/state/decision applicability, constraints, boundaries, takeaways, type-extension requirements, and (at presentation depth) handoff storyline/visuals. A mechanical pass is never READY: record the semantic review — answer the ten generic audience questions plus the type-specific ones, each judged `sufficient` only if the dossier alone lets a domain engineer who never read the source answer it — and the tool persists `readiness.json`. Fix the dossier until the review is honest, then re-run. `compiler_explain stale` later reports HEAD drift and changed source files.

## Depth discipline

`overview` = mental model + mechanism summary. `standard` adds example, decisions, constraints. `deep` adds both views (implementation + conceptual), placement, complexity. `presentation` = deep enough to teach + structured for handoff — not "most verbose". A stateless utility must not grow ten diagrams and twenty sections to look finished.

## Anti-overfitting

The generic layer (schema, tool, validators) must never contain subject-specific concepts — anything about a specific pass, VF, scheduler, or buffer belongs in artifact data only. If explaining a new subject type needs engine changes, first check whether the common core plus a new `extensions.<type>` key list suffices; grow the extension registry, not special cases.

## Handing off to the presentation system

When the user wants a presentation too ("做成 slides / 演示文稿"), the handoff is the contract, not an intermediate file: once `readiness.json` records READY and `compiler_explain stale` (or `scripts/preflight-handoff.mjs`) confirms FRESH, the compiler-architecture-presentation skill consumes the bundle in handoff-first Mode A — its storyline/visuals/takeaways are the deck's semantic source of truth, and the presentation side must not re-derive the story from source. If the user asks for presentation while the bundle is NOT_READY or STALE, that is producer work first: finish or refresh the explanation bundle (evidence → teaching → handoff → readiness), then hand off. A dossier without a handoff is not enough for the presentation skill to start — produce the handoff (Mode B), don't let the presentation side guess the story.
