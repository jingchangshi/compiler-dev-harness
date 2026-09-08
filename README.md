# Compiler Dev preset

## Normal workflow

Enter a compiler repository, run workspace preparation once (`node <harness>/scripts/prepare-workspace.mjs`) so the team `AGENTS.md` stays untouched and the harness-owned `AGENTS.local.md` overlay is present, then start DeepSeek Harness with **Compiler Dev** and describe the task naturally. The preset retains the Standard coding-agent tools and adds an always-on compiler core policy, the `compiler-development` skill for detailed guidance, `compiler_inspect`, the `compiler_knowledge` memory queries, and one compact `compiler_route` decision per task.

"Understand repository architecture" means the smallest architecture or data-flow model needed for the current task. "Understand latest N commits" means use N commits as the relevant history-search horizon, not read every full commit.

## Always-on core policy and the skill

The composition's `compiler-inspect` row registers a compact, always-on system-prompt section: contract-first operations, no rediscovery of documented procedures, task-relevant architecture only, history horizons, `compiler_inspect` first for anchored code/design/history tasks, minimal patches, bounded verification, bounded command output, lightweight evidence checkpoints, and the Creator-mode domain boundary. The `compiler-knowledge` row registers a second always-on section right after it: the knowledge-first order (repository context → compiler memory query → review findings → analyze source) routed by task type, never forced. The preset-local `compiler-development` skill (`skills/compiler-development/`) carries the detailed, conditional guidance — anchor workflow, knowledge workflow, contract precedence, checkpoint semantics, verification classification, and mixed/out-of-domain work handling. Critical invariants never depend on the model loading the skill.

## Compiler knowledge (`compiler_knowledge`)

`compiler-knowledge-v3.cjs` + `compiler-knowledge-driver.mjs` wrap the mlir-compiler-harness repomap CLI (its `adapters/compiler-dev/` contract) in-process: `review`, `finding-impact`, `pipeline-stages`, `evidence`, and `status`, against the target compiler repository (`repo_root`, default cwd; the repo needs an `mlir-repomap` index; binary discovery: `MLIR_REPOMAP_BIN` → the sibling `mlir-compiler-harness` venv → PATH). The driver enforces the query contract mechanically: a stale index is refreshed with `index --full` before results are served (~97s on AscendNPU-IR; `refresh_index:false` returns an explicit refusal instead), CLI errors/diagnostics/`"not found"` pass through verbatim as valid negatives, and the JSON envelope is delivered under a strict 24K budget (largest arrays cut with notes; `command`/`index`/`result` never dropped). It is deterministic retrieval only — no reasoning, no finding mutations, no graph writes.

Task-type routing (always-on section + skill): compiler bug / pass review → `review` first, then `finding-impact`/`evidence`; architecture / pipeline audit / Triton lowering → `pipeline-stages` first; skip for build/test execution, single-known-file edits, commit/PR text, or on user request. Per-query costs measured 2026-09-07: ~3.4s (AscendNPU-IR), ~0.4s (triton-ascend); the three validation tasks (MergeVecScope review, AutoVectorizeV2 finding re-check, Triton lowering audit) needed 7 queries and **zero** discovery greps (`analysis/2026-09-07-knowledge-integration-validation.md`).

## Code explanation (`compiler_explain`)

`compiler-explain-v2.cjs` + `compiler-explain-driver.mjs` + `scripts/teaching-schema.mjs` implement the generic Code Explanation / teaching capability (Teaching Artifact Protocol v1): any code object — function, class, algorithm, pass, module, subsystem, pipeline, data structure, workflow, or cooperating component group — is explained through one workflow, not per-subject processes. The tool is the deterministic half only: `plan` scaffolds a teaching bundle (`analysis/explanations/<date>-<slug>-<type>/` with subject skeleton, evidence plan over the existing tools, extension fields, readiness checklist, audience questions), `validate` enforces schema + evidence discipline (Source Fact vs Reasoning separation, every claim's `evidence_refs` resolved, boundary classifications only with evidence), `readiness` runs the mechanical readiness gate and records the required audience-comprehension review (READY = mechanical pass + semantic review, never field completeness), and `stale` compares recorded HEAD/source-file hashes against the repository. The semantic half — mechanism stages derived from source, mental model, causal context, decisions, storyline, visual specs (semantic only, no layout/pixels/colors) — is agent reasoning recorded in the artifacts; `skills/code-explanation/` carries the workflow. Pass-centric concepts (pipeline placement, legality, before/after IR) live only in the `pass` extension; the common core stays subject-agnostic. Detailed contract: ARCHITECTURE §17.

## Presentation consumer closure (Phase T2)

The chain `Explain → Teach → Handoff → Present` is closed: `scripts/preflight-handoff.mjs <bundle-dir>` is the one deterministic consumer gate — it reuses the Teaching Artifact Protocol owner (no second validator) and returns `CONSUMABLE` (with a bounded consumption digest: storyline, visual specs, must-have ids, canonical example, takeaways, evidence index) or refuses with `NOT_CONSUMABLE` / `STALE_PRESENTATION_INPUT` / `UNSUPPORTED_SCHEMA`. The `compiler-architecture-presentation` skill consumes a READY+FRESH handoff handoff-first: its storyline is the semantic source of truth (the skill's pass-shaped canonical narrative is demoted to the raw-input fallback), and the deck records consumer provenance in a `presentation-manifest.json` — per-storyline-step slide mapping (no silent drops; appendix/omission needs a recorded reason), must-have-visual→asset/slide mapping, evidence ids ⊆ handoff evidence index, and every adaptation with a reason; `check_project.py` enforces that coverage in handoff-first projects. Raw-source presentation (`给我源码做 slides`) remains a first-class standalone mode. Ownership boundary: the producer owns what to tell, the consumer owns how to tell it visually; `Handoff ≠ slides`. Detailed contract: ARCHITECTURE §18.

## System story composition (Phase T3)

Multiple READY child bundles compose into ONE system-level technical story — why these components coexist, why this order, which contract crosses each boundary, where representations change — and the result is a **normal** TeachingDossier + PresentationHandoff consumed by the unchanged T2 presentation pipeline. A system story is a normal bundle (`subject_type` workflow/component_group/subsystem/pipeline, typically presentation depth) plus one lightweight `composition.json` provenance artifact: every requested component gets an explicit disposition (core/supporting/context/appendix/excluded — never a silent drop), context-only nodes need no dossier, bridges carry `flow_type` (data_flow/control_flow), the transferred contract, and evidence, `representation_boundaries` are first-class, and open conflicts block readiness. READY+FRESH child bundles are the semantic source — the composer never re-analyzes child internals — and child facts are cited through namespaced imports (`alias::EV-ID`, hashes recorded per import; imported reasoning never becomes a fact), never by copying child ledgers. The tool gains four commands on `compiler_explain`: `compose-preflight` (deterministic gate before any system-level reasoning: READY+FRESH, unique subject ids, same repository, same current HEAD), `compose-plan`, `compose-validate`, `compose-render` (derived `system-story.md`; JSON stays the source of truth). Freshness is recursive (system + every child + every import hash) and refresh is incremental; the single staleness entrypoint means the T2 preflight gate gains recursion without system-story special-casing. Protocol schema stays v1. Detailed contract: ARCHITECTURE §19.

## Generic source context (Ripwire backend, Phase R1)

`compiler_inspect` gained a code-context provider seam with an explicit backend policy — `backend: auto | ripwire | legacy` (input, or `COMPILER_INSPECT_BACKEND` for diagnosis without source edits). Since R1.7 the **repository default is `auto`**: normal usage attempts [Ripwire](https://github.com/redhat-et/ripwire) `--pack-task --json` first and falls back to the retained rg/git retrieval on any failure (missing binary, invocation failure, invalid output, timeout, weak/no retrieval) — with a finite, always-visible reason. `ripwire` is the explicit strict-diagnosis mode (a failure degrades loudly instead of silently switching); `legacy` is the control/regression backend. Phase R1.6 made the evidence trustworthy first (observation protocol v2 separates provider ATTEMPTS from what actually SERVED — a fallback is a Ripwire attempt failure plus a legacy served delivery, never a "legacy failure"); only then did the default move to `auto`. No percentage rollout, no random routing. Only the generic source retrieval swaps: git state/diff/history and the MLIR log forensics run unchanged in every mode, and Ripwire remains an implementation detail behind the same three model-facing tools.

### Dogfood runbook (normal usage needs no backend decision)

```sh
dsh        # repository default = auto: Ripwire first, legacy fallback, all disclosed
```

- Binary discovery: `RIPWIRE_BIN` → `PATH`. A missing Ripwire is safe — `auto` falls back to legacy and the fallback is stated in the bundle (`Context backend: legacy-rg (fallback: ripwire-not-found) | delivery=fallback`).
- Force legacy for diagnosis: `COMPILER_INSPECT_BACKEND=legacy dsh`. Force strict Ripwire (no fallback): `COMPILER_INSPECT_BACKEND=ripwire dsh`. `COMPILER_INSPECT_BACKEND=auto` is now equivalent to the default. The variable must be present in the host process environment (the preset reads it in-process, like `MLIR_REPOMAP_BIN`).
- Repository Contract `exclude_dirs` matter under `auto` too — pass them on every `compiler_inspect` call (see the contract template's source-context exclusions).
- Normal users should not manually rotate backends; `auto` produces the natural evidence (attempts, fallbacks, weak results, post-context discovery) without an experiment calendar.

- **Normalization, not a dump.** The Ripwire bundle is normalized into a bounded `source_context` (ranked symbols with signatures, top bodies, 1-hop callers, tests-to-run) plus a `source_disclosures` block that preserves weak/ambiguous/truncation/floor counts. Ripwire's own token budget is derived from the CompilerDev delivery budget (a 12000-char slice of the 20000-char total ⇒ `--token-budget=5084`), so the ceilings do not stack.
- **No silent fallback.** Every result states `backend`, `fallback`, and a finite `fallback_reason` (`ripwire-not-found`, `ripwire-invocation-failed`, `ripwire-invalid-output`, `ripwire-timeout`, `ripwire-weak-result`, `backend-policy-legacy`); the rendered bundle carries a `Context backend:` line the offline analyzer aggregates. A weak result (nothing retrieved) falls back in `auto` with the explicit note that "not retrieved" is not semantic absence; an explicit `ripwire` failure returns a degraded result and never pretends legacy ran.
- **Binary discovery.** `RIPWIRE_BIN` → `PATH`; argument-array spawn only, no shell, no installation, no downloading, 240s guard. Absent binary = usable preset (legacy serves).
- **Corpus boundaries.** Ripwire crawls with its own denylist and (by default) `.gitignore` — measured on AscendNPU-IR: its `third-party/` (hyphen) is NOT in Ripwire's `third_party` (underscore) denylist, so a naive crawl chews 4.3 GB of vendored code (>6 min, >12 GB RSS) while the configured crawl with `exclude_dirs: ["third-party"]` answers in ~2.2 s cold / ~1.2 s warm. Contract `exclude_dirs` map to Ripwire `--exclude` prunes; anchored files under crawl-pruned trees are reported `outside_corpus` with a narrow legacy vendored supplement instead of being silently missing.
- **Epistemic boundary.** The rendered Source-context section is labelled generic retrieval/ranking evidence — approximate 1-hop, name-based; it is never an `mlir-repomap` semantic fact, and nothing from it writes the graph, findings, or evidence.
- **Observation.** One non-sensitive JSONL line per source-retrieval attempt lands in gitignored `analysis/feedback/context/` (ts, correlation id, policy, provider, mode, duration, sizes, truncated/weak/fallback/reason, anchor/symbol counts, outside-corpus count, repo basename — never prompts, task prose, source bodies, raw output, or stderr). The correlation id joins the `compiler_route`/`compiler_knowledge` streams via a shared per-agent state module.

## Production knowledge observation loop (Phase 2)

Normal work produces the architecture feedback evidence by itself — no manual case logging:

```text
normal compiler task
        ↓
automatic route decision (compiler_route, one per task)
        ↓
knowledge queries if useful (workflow-contract sequences, never over-queried)
        ↓
source work
        ↓
automatic observation (gitignored streams) → offline analysis → candidates
        ↓
periodic: human review → curated feedback → bundle export → architecture review
```

- **Route decision.** Each real task opens with one compact `compiler_route` call: route kind (`pass-review`, `finding-review`, `pipeline-audit`, `anchored-code-analysis`, `single-file-edit`, `build-test`, `commit-pr`, `environment`, `git-operation`, `log-forensics`, `other`), `knowledge_expected`, `confidence`, a reason category (never free text), and an optional stable target id. Routing is conservative: only high-confidence pass/pipeline/finding angles expect knowledge; the goal is correct routing, not a higher call rate. Declared skips are recorded too — a skip is a correct outcome, not a failure.
- **Correlation.** The route decision mints an opaque per-task `correlation_id` (`k<16 hex>`; no user, prompt, or path data) that is stamped onto every subsequent `compiler_knowledge` record and delivery envelope, joining route decisions, the query stream, and the offline session analyzer. State is keyed per session inside the plugin; one id per task.
- **Runtime streams (gitignored).** `analysis/feedback/routes/<date>.jsonl` (one line per route decision) and `analysis/feedback/queries/<date>.jsonl` (one line per served query: ts, correlation id, command, target name, repo, HEAD, refresh, duration, size, diagnostic count, truncation, error state — never result bodies, source text, or prompts).
- **Offline analyzer.** `scripts/analyze-session.mjs` adds route metrics, adoption (eligible/adopted/missed per declared route), temporal order (first knowledge/inspect/discovery/edit step, `knowledge-before-search`), and a precision-first search classification: bounded reads of files a query already pointed at are **verification reads**, unscoped repo-wide searches after queries are **discovery searches** (potential coverage gap), and everything undecidable — artifact/log paths, generated trees — is reported as **uncertain**, never judged a gap.
- **Candidates.** `scripts/collect-feedback.mjs <session.jsonl...>` correlates session logs with the query stream and writes Feedback Protocol v2 candidates (`origin: automatic`) to `analysis/feedback/candidates/` (gitignored): `query-sufficient` (positive evidence — deliberately kept), `query-insufficient` (discovery after queries; only a `possible_gap`, never an asserted feature), `adoption-missed` (high-confidence expected + zero calls), `query-operational` (stale/refresh/not-found/truncation/diagnostic/error signals). Undeclared routes, status-only groups, and correct skips produce nothing.
- **Review.** `scripts/review-feedback.mjs <candidate.json> --accept` validates, strips any runtime-only field, marks `origin: curated`, and moves the artifact to `analysis/feedback/` (cross-checked against the sibling harness's Python validator when its venv exists). `--reject` parks the candidate under `candidates/rejected/`. Nothing commits itself.
- **Batch + bundle.** `scripts/summarize-feedback.mjs` aggregates sessions/streams/candidates into counts only (route kinds, adoption, sufficiency, operational failures, command breakdown, gap categories) — it never concludes "implement X". `scripts/export-feedback-bundle.mjs --since YYYY-MM-DD --output bundle.tar.gz` packages `manifest.json`, `summary.json`, `route-summary.json`, `query-summary.json`, and `curated-feedback/` (optionally a counts-only `candidate-summary.json`), and fails closed if any staged file contains prompt/message/transcript/source-text/credential keys, user home paths, key material, or oversized files.

The feedback protocol is owned by mlir-compiler-harness (`adapters/compiler-dev/feedback-schema.md` v2, ADR-025); this preset only observes and produces candidates. Automatic candidates never mutate the compiler graph or finding lifecycle.

Phase R1.5 made the generic-context telemetry a first-class part of this loop (still compiler-dev-owned, still a different artifact class from knowledge feedback): `summarize-feedback.mjs --context` aggregates the context stream (providers, fallbacks, weak/truncated/outside-corpus, cost) alongside `search.discovery_after_inspect` / `verification_after_inspect`; `export-feedback-bundle.mjs` ships a counts-only `context-summary.json` (never the raw stream); and `scripts/evaluate-context-backend.mjs` compares the observed provider groups with objective, ordering-only metrics — explicitly observational, no score, no automatic promotion. The analyzer's `discovery-after-inspect` means only "a discovery search occurred after a `compiler_inspect` result in the same route window"; it is never proof that a backend failed.

## Repository Contract

Repository instructions have two ownership domains that must not compete for the same tracked file:

- **Team-owned**: the target repository's tracked `AGENTS.md` is upstream operational truth. The harness reads it but never overwrites, symlinks, or `skip-worktree`s it — a normal `git pull`/rebase updates it with no manual recovery.
- **Harness-owned**: `contracts/<Profile>/REPOSITORY_PROFILE.md` (harness retrieval policy: `compiler_inspect` `exclude_dirs`/`contract_test_dirs`, tool disciplines, repo conventions the team does not track) plus per-server host facts in `contracts/<Profile>/hosts/<host-id>/AGENTS.local.md` — human-provided from `contracts/HOST_FACTS_TEMPLATE.md` (minimal `REQUIRED:` set; the agent may draft one for review, never invent values), selected automatically by hostname or `--host`. `scripts/prepare-workspace.mjs` materializes both into the target worktree as one managed, content-marked `AGENTS.local.md` overlay (excluded locally via `info/exclude`, never the team `.gitignore`), which the DSH instruction loader reads additively after the team file.

```sh
node <harness>/scripts/prepare-workspace.mjs [target-root]     # first use, new worktree, or after editing harness sources
node <harness>/scripts/prepare-workspace.mjs --check [target]  # validate/repair triage
```

The command is idempotent and conflict-safe: it refuses to overwrite an unmanaged `AGENTS.local.md` and detects hand edits by digest. Run it once after `git clone` and once per linked worktree; nothing is needed after `git pull`/rebase. Ownership rules, migration record, and worktree semantics: `contracts/README.md` and `ARCHITECTURE.md` §6.

Team-side contracts are drafted by the human in the target repository from `REPOSITORY_CONTRACT_TEMPLATE.md`. Put every-task facts in the team `AGENTS.md`; put larger subsystem-specific material in a project-local Skill or reference. Do not duplicate it. A contract can specify environment initialization, build and test commands, accelerator constraints, submodule policy, repository boundaries, and approved workarounds. The agent uses these facts before operational discovery and validates a command only at its point of use. It never silently persists inferred facts; it reports a newly useful workaround as a candidate human update for the correct ownership domain.

## Inspection and verification

`compiler_inspect` (v1.4) batches repository state, requested anchors, and — depending on the backend policy (see above) — either a normalized Ripwire pack-task bundle or the classic hand-written rg/git retrieval: probable definitions with bounded context (keyword declarations, assignments, and C/C++ attached-brace function definitions), ranked references, likely tests, optional working-tree diff, and path/symbol-scoped history into one bounded bundle — batched searches, default exclusion of `.git`/build/cache noise and vendored trees (with a bounded vendored fallback that also runs when an anchored file sits inside a vendored tree or when no definition-shaped match exists outside them), and a strict total character budget. Optional `log_files` forensics index `IR Dump After/Before <pass>` markers in compile/pipeline logs, extract occurrence-addressed bounded dump slices, and diff two logs' pass sequences — mechanical line arithmetic only, never IR interpretation. `history_window` accepts 1–30 (declared in the schema); out-of-range values are clamped and the clamp is reported in `Unresolved` instead of failing the call. It does not infer build or environment commands. Pass the Repository Contract's relevant test directories as `contract_test_dirs` and its vendored/submodule boundaries as `exclude_dirs` — reuse them in every call of a session; those constraints guide task-specific exploration without duplicating the contract (and, under the Ripwire backend, they shape its corpus too).

Verification starts with targeted checks. A failed command is classified as patch-caused, environment, pre-existing, or unknown. A suspected unrelated blocker gets at most one focused control experiment; once demonstrated, record it and what it prevents, continue unaffected checks, and stop investigating it.

## Early compaction (experimental)

Derived from four audited production sessions: long discovery phases reached ~250K cached tokens on 1M-context routes with no compaction event, so implementation and verification ran on top of a huge discovery history. The preset configures `compaction-basic` `modelPolicies` for confirmed 1M-context routes (DeepSeek-V4 and GLM-5.3 families on their deployed providers): `thresholdRatio: 0.2` (compact near ~200K tokens) with `retainTokens: 65536`. Other presets, unknown models, and small-context routes keep the default 80% overflow threshold. The matching `contextWindow` declarations live in `~/.dsh/settings.yaml`; extend the policy list only after a route's capacity is confirmed there. The tool-result pruner stays in the same compaction realm and participates whenever compaction triggers.

## Session observability

`scripts/analyze-session.mjs` is an offline, non-model-facing analyzer for exported session logs:

```sh
node scripts/analyze-session.mjs <session.jsonl>     # or .jsonl.zstd
node --test "scripts/test/*.test.mjs"                # run its tests
```

It reports model steps, tool-call mix, `compiler_inspect` adoption with a backend breakdown (ripwire vs legacy-rg, fallback reasons, weak results), `compiler_knowledge` adoption with a per-command breakdown, `compiler_route` decisions with route/adoption metrics, the temporal order of knowledge, inspect, discovery-search, and edit steps, a precision-first classification of bash searches (verification reads vs discovery searches vs uncertain), skill-load failures, token accounting, peak request context, tool-result sizes, and compaction counts. It reads the concatenated-frame `.jsonl.zstd` artifacts this deployment writes and tolerates missing fields.

## Case regression corpus

`cases/` (gitignored) holds exported production session logs (`cases/<id>/session.jsonl` or `cases/<id>.jsonl[.zstd]`). `scripts/regression-cases.mjs` replays every log through the analyzer and compares the metrics against the committed baseline `analysis/case-baseline.json` (metric numbers only — session ids and counts, no paths or prompts):

```sh
node scripts/regression-cases.mjs           # replay + compare; non-zero exit on drift
node scripts/regression-cases.mjs --update  # re-bless after an intended analyzer change
```

The 9 audited 2026-09-05/06 production sessions are the initial corpus: all replay deterministically with zero `compiler_knowledge` calls (the pre-integration baseline) and their historical `compiler_inspect`/search metrics intact. Old cases are a regression corpus, not a manual case source.

## Reloading preset plugin edits

Tool output schemas use the harness's supported JSON-schema subset: a single `type` string (type arrays are rejected at mount), `oneOf` for nullable shapes, and only type/oneOf/properties/required/additionalProperties/items/enum/const plus description/title/default/examples. The v3-3 rename exists because the 2026-09-07 harness build started enforcing this; v3-4 carries the Phase R1 backend policy.

The host process caches preset plugin modules by file URL for its lifetime. After editing `compiler-inspect-v3-5.cjs` or `compiler-knowledge-v3.cjs`, rename the file (and update the composition row); after editing `compiler-inspect-driver.mjs`, `compiler-context-backend.mjs`, or `compiler-knowledge-driver.mjs`, bump the `?v=` query in the plugin's import. Composition YAML (rows, config, skill directories) is re-read at every session mount.

## Case feedback loop

`analysis/` holds the case feedback analysis report, validation records, and, under `analysis/feedback/`, the knowledge-system feedback artifacts distilled from audited production sessions. They record how the knowledge layer was (or was not) consumable — they are not compiler findings and are owned by this preset's maintainers. Curated, committed JSONs follow mlir-compiler-harness `adapters/compiler-dev/feedback-schema.md` (v1 corpus preserved; new artifacts use v2, ADR-025). Two runtime observation streams feed the loop from the gitignored side: `analysis/feedback/queries/` (auto-appended by the `compiler_knowledge` driver) and `analysis/feedback/routes/` (auto-appended by `compiler_route`), both correlated by per-task correlation ids; automatic candidates accumulate under `analysis/feedback/candidates/` until a human reviews them via `scripts/review-feedback.mjs`. Agents hand-write curated artifacts only for verified gaps the automation cannot see.

## Phase 2 candidates

Consider deeper LSP retrieval only after measuring symbol-match quality. Repository-specific architecture Skills, exploration-depth guards, semantic diff guards, and automatic contract promotion remain optional follow-up work requiring new production evidence.
