# Compiler Knowledge Integration — Validation (2026-09-07)

Real-repo validation of the `compiler_knowledge` integration (Step 5 of the
knowledge-workflow goal), following `mlir-compiler-harness/adapters/compiler-dev/workflow-contract.md`
sequences. Targets: AscendNPU-IR (head `d00398bd9be2`, branch `dev-skip-once-multibuf`,
index refreshed 2026-09-07) and triton-ascend (head `8ba4ac4ce567`, index fresh).

## Method

Each task was run through the contract's preset sequence via the new driver/tool
code path (`compiler-knowledge-driver.mjs`, the exact code the tool executes),
with the knowledge query FIRST and source access limited to what the contract
allows afterwards: opening the few files the results point to. Discovery
searches (grep/rg/awk/find) are the measured quantity; contract-allowed
verification reads of pointed evidence are counted separately.

| Task (type) | Contract sequence used | Knowledge queries | Discovery greps | Pointed verification reads |
|---|---|---|---|---|
| MergeVecScope guard/assumption review (compiler bug / pass review) | `review MergeVecScope` → `finding-impact MVS-001` → `evidence pass:hfusion-merge-vf` | 3 | **0** | 1 read, 3 line ranges |
| AutoVectorizeV2 finding re-check (finding 复核) | `finding-impact AV2-001` | 1 | **0** | 1 read, 1 range |
| Triton lowering order (pipeline audit, triton-ascend) | `pipeline-stages make_ttir` → `pipeline-stages ttir_to_linalg` → `evidence pipeline:…ttir_to_linalg` | 3 | **0** | 1 read, 1 range |

Auto-observation: `analysis/feedback/queries/2026-09-07.jsonl` — 7 queries, none
truncated except one 24K-budget cut (AV2-001 finding-impact, envelope trimmed by
the bounded delivery, contract keys intact). Per-query latency ~3.4s
(AscendNPU-IR) / ~0.4s (triton-ascend).

## Findings

1. **Knowledge queries answered the structural questions with zero discovery
   search.** Pass identity, verbatim review record, 4 legality-guard
   `file:line`+snippet rows, linked findings, review-scope suggestion with
   covering tests, guard drift classification ("guards moved (same guard set)",
   1406→1654), and the AST-confirmed pipeline stage orders (10 + 15 stages with
   exact `file:line`) all came from queries. Every pointed line verified exactly
   (MergeVecScope.cpp:631-634/:1422, AutoVectorizeV2.cpp:1654,
   compiler.py:169-180).
2. **Baseline contrast.** The 2026-09-06 case feedback showed 0 knowledge-query
   calls across 9 production sessions with 142–293 grep-class calls in the
   log-heavy ones; this session's analyzer metric on session C4 still reads
   `compiler_knowledge calls: 0`, `bash grep-like search calls: 146`. The three
   validated task shapes above needed 7 queries and 0 discovery greps — the
   routing seam the integration closes.
3. **One real coverage gap found** (feedback artifact
   `2026-09-07-triton-lowering-pipeline-stage-names.query-coverage.json`):
   `pipeline-stages` returns the stage order and `file:line` evidence but leaves
   direct `passes.<ns>.add_x(pm)` binding names unresolved (9 of 10 make_ttir
   stages), forcing one extra bounded read of the pointed region per audit.
   Proposal: resolve direct bindings into stage labels. Not implemented here —
   the knowledge repo owns its queries.
4. **Honest scope notes.** (a) The stale→auto-refresh path is covered by stub
   tests (`refresh_index` default true, refusal mode, refresh-failure) and the
   real refresh cost was measured at 97s on AscendNPU-IR; the validation run
   started from an already-fresh index, so the production auto-refresh path was
   not re-timed end-to-end on a live stale repo. (b) This validation ran in the
   harness creative-mode session, not a fresh compiler-dev production session;
   the preset-side adoption signal (does the model route through
   `compiler_knowledge` unprompted) needs the next batch of real sessions,
   observable via `analyze-session.mjs` (`compiler_knowledge calls` +
   per-command breakdown vs `bash grep-like search calls`).

## Artifacts

- Feedback: `2026-09-07-mergevecscope-review-sufficient.json` (no gap),
  `2026-09-07-autovectorizev2-finding-impact-sufficient.json` (no gap),
  `2026-09-07-triton-lowering-pipeline-stage-names.query-coverage.json`
  (query-coverage proposal). All validated by
  `mlir_repomap.feedback.validate_feedback`.
- Query log (gitignored runtime stream): `analysis/feedback/queries/2026-09-07.jsonl`.
