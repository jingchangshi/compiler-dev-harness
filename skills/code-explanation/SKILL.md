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

## Composing multiple subjects into a system story (Phase T3)

When the user asks to connect several already-explained components ("梳理 A、B、C 以及它们在系统中的协作关系", "讲清这条 pipeline 为什么这样协作"), do NOT concatenate summaries and do NOT re-analyze what child bundles already cover. The system story is a NORMAL bundle (subject_type `workflow` / `component_group` / `subsystem` / `pipeline`) plus one lightweight `composition.json`:

1. **Gate first** — `compiler_explain compose-preflight` over the candidate child bundles: every child must be READY and FRESH in the same repository at the same current HEAD. Refresh (or create) only what is refused, incrementally — never re-analyze a READY+FRESH child's internals.
2. **Compose** — `compose-plan` scaffolds `composition.json`; then write the system bundle: one explicit disposition per requested component (`core/supporting/context/appendix/excluded`, never a silent drop; excluded needs a reason), context-only nodes for real pipeline stages the user did not request, bridges (each: free-text relation, `flow_type` `data_flow`|`control_flow`, the contract that crosses the boundary, why the order matters, representation before/after, evidence), representation boundaries, and conflicts.
3. **Evidence discipline for bridges** — the parent ledger holds only NEW cross-component facts (pipeline order spans, producer→consumer spans, shared state). Cite child facts as `alias::EV-ID` through `composition.json.imports` (alias → child bundle + subject_id + evidence.json sha256); never copy child records into the parent ledger. A bridge marked `epistemic_status: "fact"` needs fact-class evidence (parent or imported); otherwise mark `reasoning`/`hypothesis`/`unknown` explicitly. An open conflict blocks readiness — record it, gather cross evidence, never narrate past it.
4. **Semantic zoom** — component-local mechanism detail stays in the child dossier; the system story adds only ordering, contracts, representation transitions, system invariants/boundaries, and the end-to-end flow (`mechanism.stages` of the system dossier is the input→…→output skeleton, ≥2 stages). A stitched example from per-pass runs must be labeled as stitched, never as one end-to-end execution.
5. **Gate, render, hand off** — `compiler_explain readiness` on the system bundle (same mechanical gate + audience review, plus composition cross-checks: coverage, bridge evidence, conflicts, ≥1 representation boundary), `compose-render` for the derived `system-story.md` (JSON stays the source of truth), then the normal handoff-first presentation path. Freshness is recursive: the system story is stale if the system bundle, any child, or any import hash drifts; refresh incrementally.

## Orchestrating a whole request (Phase T4)

Everything above is the *semantic* work. The *coordination* around it — discovering bundles, deciding reuse vs refresh vs create, ordering the work, verifying deliverables — is deterministic and belongs to the orchestration control plane (`compiler_explain catalog | run-plan | run-status | run-finalize`):

1. **Route by the request, in the user's words.** One subject ("解释 X") → single-subject run; several subjects and their relations ("梳理 A、B、C 以及它们之间的关系") → multi-subject run; "形成文档" adds the `documents` output; "做 slides" adds `presentation`. The user supplies only subject names and desired outputs — never bundle paths, never compose commands.
2. **Plan first, always.** `compiler_explain run-plan` with the subject names verbatim, the target repository (`repo_root`, default cwd), the depth, and the outputs. The planner builds the artifact catalog (runtime store + curated fixtures), resolves each name deterministically (subject id → name → normalized/condensed name → type canonical ids), and classifies REUSE / REFRESH / CREATE / AMBIGUOUS per subject. A multi-subject request with a system-level output adds the composition node; presentation adds the presentation node. The result is an execution DAG plus compact child work packets.
3. **AMBIGUOUS is your decision, never the tool's.** When a name matches several distinct subjects, the planner returns all candidates and stops that subject — pick with repository evidence, then re-run `run-plan` (it resumes the same run).
4. **Execute only what the plan says is missing.** REUSE subjects are consumed as-is (semantic re-analysis = 0); REFRESH means incremental update of the existing bundle; CREATE follows the work packet (subject, type, repository, HEAD, target bundle root, required depth, required outputs — nothing else). Independent CREATE/REFRESH subjects are parallelizable — delegate them to subagents when available. New bundles for normal use go to the gitignored runtime store (`analysis/runtime/explanations/<repository>/`, via `plan`'s `root_dir`); never write into `analysis/explanations/` unless the user explicitly asks for curated/dogfood artifacts.
5. **Trust gates, not children.** After each child reports done, `compiler_explain run-status` re-validates readiness + freshness deterministically, renders the derived documents (explanation.md per subject, system-story.md for the system) into the runtime store, and emits the next actions. A child's "done" advances nothing by itself.
6. **Close with the final gate.** `compiler_explain run-finalize` verifies every requested deliverable — bundles READY+FRESH, documents current with their JSON, composition recursively fresh with no open conflicts, presentation manifest matching the current handoff hash — and only then reports COMPLETE. Partial runs stay resumable: the run state (`analysis/runtime/runs/<repository>/`) survives sessions, and a new `run-plan` with the same request resumes it instead of duplicating it.

Low-level primitives (`plan/validate/readiness/stale/compose-*`) remain first-class for debugging, testing, and expert workflows — orchestration is a control plane on top, not a replacement.
