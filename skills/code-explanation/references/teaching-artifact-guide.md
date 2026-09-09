# Teaching Artifact Protocol v1 — field guide

Authoritative validators: `scripts/teaching-schema.mjs`. Deterministic tool: `compiler_explain` (`compiler-explain-v2.cjs` + `compiler-explain-driver.mjs`). This guide explains intent; the validators decide acceptance.

## Bundle layout

```text
analysis/explanations/<YYYY-MM-DD>-<slug>-<subject_type>/
├── subject.json      AnalysisSubject + provenance        (required)
├── evidence.json     evidence ledger                     (required)
├── dossier.json      TeachingDossier                     (required)
├── handoff.json      PresentationHandoff                 (presentation depth)
└── readiness.json    readiness report                    (written by the tool)
```

Unknown fields are rejected everywhere (the schema is closed — put new information into existing semantic fields, or propose a protocol extension). Evidence ids are cited as `evidence_refs: ["EV-001", …]` and must resolve against the ledger.

## subject.json — AnalysisSubject

| field | req | notes |
|---|---|---|
| `subject_id` | ✔ | lowercase slug; used by every other artifact |
| `subject_type` | ✔ | one of the 11 types |
| `name`, `repository` | ✔ | as users refer to it; repo name/path |
| `source_locations` | rec | `[{file, lines?}]` |
| `scope` | rec | one sentence bounding what the analysis covers |
| `related_entities` | opt | `[{name, relation}]` |
| `why_this_subject` | opt | dogfood provenance — why this subject was analyzed |
| `provenance` | ✔ | `repository`, `branch`, `head`, `analyzed_at`, `tool_versions`, `runtime_verification` (`none|partial|full` + note), `source_files: [{path, sha256}]` (staleness input) |

## evidence.json — evidence ledger

`records[]`, each `{id, class, statement, tool?, command?, refs?: [{file, lines?}], commit?, note?}`. Classes and their burdens:

- `source_fact` — needs `refs`; came from reading source.
- `graph_fact` — needs `tool`/`command` (e.g. the `compiler_knowledge` query); never confused with source reads.
- `runtime_fact` — a run you actually executed (test, probe, IR-dump slice).
- `historical_fact` — needs `commit` or `refs`; git evidence.
- `reasoning` — your inference. Valid evidence for interpretation fields (`conceptual_view`, `placement`, tradeoffs) but never presentable as fact.
- `hypothesis` — unverified conjecture kept alive deliberately.
- `unknown` — recorded absence of knowledge.

`historical_fact` without a commit/refs, `source_fact` without refs, and `graph_fact` without its tool are validation errors — the tool burden is what makes the class meaningful.

## dossier.json — TeachingDossier (common core)

Everything except the identity fields is optional at schema level; the readiness gate decides what this subject+depth actually requires. Presence ≠ required.

| field | shape | intent |
|---|---|---|
| `mental_model` | string | 1–3 sentences, domain language; symbol dumps fail the mechanical floor |
| `need`, `responsibility`, `observable_outcome` | string | the why-model; `purpose` accepted as a compact alias |
| `audience_contract` | object | who this dossier must teach |
| `system_context` | `{upstream[], downstream[], triggers[]}` | entries `{role, entity, interaction, evidence_refs}` — causal, both sides |
| `inputs`, `outputs` | entries `{name, form, description, evidence_refs}` | interfaces |
| `mechanism` | `{summary?, stages[], control_flow?, data_flow?, mutable_state?, has_important_branching?}` | stages `{name, what, where?, key_functions?, evidence_refs}` — names derived from source |
| `implementation_view`, `conceptual_view` | entries `{aspect, description, evidence_refs}` | how it is built vs why it behaves so |
| `canonical_example` | `{provenance{kind, source}, initial_state?, inputs?, execution_trace?, steps?, important_states?, result?, boundary_examples?}` | generic concepts; pass-shaped before/after IR belongs in the pass extension. At presentation depth for example-required types the example must be **worked**: ≥3 ordered trace steps. Trace/step entries are strings or step mappings carrying at least one of `label`/`action`/`description`/`state` (plus optional `result`, `mechanism_stage`, `evidence_refs`) — `mechanism_stage` ties a step to a `mechanism.stages` name so the deck can walk the example along the mechanism |
| `worked_examples` | `[{title, provenance{kind, source}, steps[], result?, evidence_refs?}]` | per-mechanism step-by-step instances beyond the canonical example (Phase T5) — one per complex mechanism the audience must trace, not a second canonical example |
| `state_transitions` | `{phase, before, operation, after, reason?, evidence_refs}` | first-class state primitive; omit when stateless |
| `decisions` | `{id?, question, condition, outcomes?, reason?, evidence_refs, example_refs?}` | branching that decides behavior; not compiler-legality-specific |
| `strategies`, `comparisons` | arrays | only when ≥2 real paths exist; a single strategy is a validation error |
| `contracts` | `{producer, consumer, subject_side, element, form?, evidence_refs}` | cross-component edges (arguments, files, callbacks, shared state, …) |
| `constraints`, `invariants`, `assumptions` | `{statement, status?, evidence_refs}` | status: `guarded|unguarded|verified|assumed|potential` |
| `boundaries` | `{category, statement, evidence_refs}` | category: `supported|partially_supported|rejected_by_design|unsupported|potential_risk|unknown` — evidence-required |
| `placement` | `{applicable?, why_here?, why_not_earlier?, why_not_later?, status?}` | `applicable:false` requires `status:"not_applicable"` |
| `ownership` | object | who creates/owns/mutates/consumes/destroys — only for resource-bearing subjects |
| `complexity` | object | with provenance `derived|measured|reasoning|unknown` |
| `key_takeaways` | string[3–5] | the memorable core |
| `design_tradeoffs`, `risks` | arrays | reviewer-facing |
| `extensions` | `{<subject_type>: {...}}` | exactly one, matching the subject type |
| `evidence_refs` | ids | top-level claim index (optional) |

### Extensions (registry in `EXTENSION_KEYS`)

| type | fields |
|---|---|
| `pass` | `pass_arg, operation_scope, pipeline_placements, ir_contract, attributes, legality, rewrite` |
| `function` | `parameters, return_values, preconditions, control_flow, side_effects, callers, callees` |
| `algorithm` | `input_model, state_representation, iteration, termination, complexity` |
| `class` | `responsibility, owned_state, lifecycle, public_api, collaborators` |
| `subsystem` | `components, architecture_boundaries, external_interfaces` |
| `pipeline` | `stages, stage_order_evidence, representation_boundaries` |
| `data_structure` | `representation, invariants, operations, ownership` |
| `module` | `responsibilities, public_api, dependencies` |
| `workflow` | `participants, flow, contracts` |
| `component_group` | `components, interactions` |
| `other` | (none) |

Readiness requires, per type: pass → placements + IR contract + legality/rewrite; function → parameters + returns + callers/callees; algorithm → iteration + termination + complexity; class → lifecycle + collaborators + state/API; subsystem → components + external interfaces. No pass-centric field (`pipeline_position`, `legality`, `before_ir`, `after_ir`, …) exists outside the pass extension.

## handoff.json — PresentationHandoff

`{subject_id, subject_type, depth?, audience?, learning_objectives?, storyline[], visuals[], must_have_visuals[], optional_visuals[], canonical_example?, worked_examples?, key_takeaways?, comparisons?, important_decisions?, appendix_topics?, evidence_index[]}`.

- `storyline` steps: `{position?, role, claim, dossier_section?, evidence_refs?}` — roles are free text, adaptive to the subject; the fixed pass narrative is forbidden.
- `visuals`: semantic specs `{id, kind, title, purpose?, nodes[{id,label,role?}], edges[{from,to,label?,role?}], groups?, ordering?}` — `x/y/width/height/color/…` keys are validation errors; the harness never does layout.
- `worked_examples`: `[{id, title, summary, evidence_refs?}]` — semantic references to the dossier's worked examples the deck must show; ids are stable keys the presentation manifest maps to slides (missing mapping fails the deck checker). Declare one per complex mechanism you expect the audience to trace step by step.
- `evidence_index`: bounded subset `[{id, statement?, class?, refs?}]`, ids must resolve.

## readiness.json — written by the tool

`{mechanical: {checks[], verdict, failures}, semantic_review?, verdict, reasons[], evaluated_at}`. READY ⇔ mechanical pass ∧ semantic review recorded `ready` with all ten generic audience questions answered `sufficient` ∧ artifact not stale. The semantic review is the reviewer's recorded judgment (Goal §30/§31); the tool enforces that it exists and is coherent, never that it is favorable — a dishonest `ready` is an audit failure, not a schema failure.

## Aggregation forward-compatibility (System Story)

Contracts (`producer`/`consumer` + element/form) and context entries (`role`/`entity`/`interaction`) are plain referenced strings, so dossiers can be joined across bundles later; handoff `evidence_index` keeps ids stable. Nothing in the schema prevents aggregating multiple dossiers into a system story.
