---
name: compiler-development
description: Efficient, evidence-led workflow for Triton, MLIR, LLVM, and related compiler repositories.
whenToUse: Use for compiler architecture, code review, implementation, tests, or recent-history tasks.
---

# Compiler development

The preset's always-on core policy already binds the invariants: contract-first operations, task-relevant architecture only, one `compiler_inspect` bundle before serial exploration, minimal patches, bounded verification and output, lightweight checkpoints, and the Creator-mode domain boundary. This skill adds the detail and judgment behind those invariants. Load it for compiler work; do not expect it to restate the invariants.

## Working through anchors

Explore explicit anchors first: definitions, direct callers or implementations, applicable lowering or runtime semantics, related tests, then scoped history. Stop when the current design decision has enough evidence — extra exploration is spent tokens, not safety.

When calling `compiler_inspect`, pass what the Repository Contract already states: its test directories as `contract_test_dirs`, and its vendored/submodule or generated boundaries as `exclude_dirs`. Reuse those same contract parameters in every later call within the session, and when the bundle's Unresolved section reports a missing anchor file, fix or drop that anchor before broadening the search. For compile or pipeline logs, pass their paths as `log_files` and the passes of interest as `log_passes`: the bundle returns bounded IR-dump indexes, occurrence-addressed slices, and a two-file pass-sequence diff — never stream raw log output into context. Those constraints shape the bundle without duplicating the contract. Interpret the bundle as leads, not conclusions: a probable-definition line shows syntax and two context lines; open the file only when the context is insufficient to decide. A `Vendored matches` section or a truncation marker means the evidence is incomplete — narrow with exact anchors rather than broadening the search.

Treat "latest N commits" as a search horizon, not a request to read every commit. Inspect full commits only when the diff, not the message, carries cross-file design intent.

## Repository Contracts

Order of authority: human Repository Contract, then project instructions, then source, relevant history, inference. Load the contract before any environment, build, or test discovery. Validate a contract command only at its point of use; never replace it with an inferred procedure. Without a contract, discover only the facts this task needs and mention the missing contract only when it affects efficiency.

Never persist inferred operational facts. When a workaround or environment fact proves useful, propose it to the human as a candidate contract update. Use `REPOSITORY_CONTRACT_TEMPLATE.md` only when the human asks to establish or draft one.

## Checkpoints

A checkpoint is one line retained in the conversation — **Decision; Evidence; Uncertainty; Patch implication** — taken before a design-sensitive edit, when a large discovery phase hands off to implementation, and before long verification once design conclusions are stable. In a long implementation or debug loop, re-emit it whenever the working hypothesis changes: a decision that exists only in reasoning does not survive compaction. A design-freeze checkpoint reconciles the stated contract against the implementation item by item, so a contradiction between what you declared and what you wrote is caught by you rather than by review. Prefer spending long reasoning on checkpoints and structured notes over single enormous thinking blocks. Its purpose is to survive compaction: the summary keeps the engineering state even when the raw evidence is shadowed. It is an evidence boundary, not a database; never emit ceremony after trivial reads.

## Verification

Verify narrowly first, then run broader repository-prescribed checks only when justified. Classify failures: patch-caused, environment, pre-existing, or unknown. For a suspected unrelated blocker, run at most one focused control experiment; once it demonstrates the blocker is unrelated, record the blocker, its evidence, and what verification it prevents, then continue unaffected checks and stop investigating it. Do not edit environment or dependency files merely to force green tests.

## Compiler knowledge workflow

`compiler_knowledge` wraps the mlir-compiler-harness repomap CLI (contract: its `adapters/compiler-dev/` docs). It is deterministic retrieval over the compiler knowledge graph and review memory — it never generates reasoning, never mutates finding status, and never writes the graph. For tasks it routes to, the order is: repository context (Repository Contract / AGENTS.md) → compiler memory query → review what it returned (findings, guards, review records) → analyze only the source the results leave open, feeding the returned `file:line` anchors to `compiler_inspect` or targeted reads.

Routing by task type — never force it:

- **Compiler bug / pass review**: `review <pass>` first (pass identity, verbatim review records, invariant guards, linked findings), then `finding-impact` on the returned findings, `evidence` on key nodes; open only the pointed files.
- **Architecture / pipeline audit (incl. Triton lowering order)**: `pipeline-stages <pipeline>` first (AST-confirmed Python compositions with `file:line` evidence), then `evidence` on key stages, `finding-impact` when findings link.
- **Finding re-check**: `finding-impact <id>` first, then `evidence`, `review` as needed.
- **Skip**: build/test execution, single-known-file edits, commit/PR text, or when the user says not to — the same skip rules as `compiler_inspect`. A `compiler_inspect`-shaped task with no pass/pipeline/finding angle needs no knowledge query.

Contract rules that the tool enforces but you must still respect: a stale index is refreshed before results are served (`index --full`, minutes on a large repo) unless `refresh_index:false`; diagnostics, `"not found"`, and empty memory are real negatives — never guess across unresolved references; ambiguous names return candidates — ask or disambiguate, never pick silently; audit only AST-confirmed stage order and mark runtime control flow unknown; keep the raw JSON with the file:line work record; separate query facts from your own reasoning, never present retrieval results as fresh design judgment, and never open/close/escalate a finding from an impact suggestion.

After the task: if queries were used and something real was missing — manual source search was needed where knowledge should have answered, or expected memory came back empty — write one non-sensitive feedback artifact (task kind/target, query, observation, manual_source_search reason, possible_gap, `contains_sensitive_content: false`) into this preset's `analysis/feedback/`, following mlir-compiler-harness `adapters/compiler-dev/feedback-schema.md`. Query calls themselves are auto-logged there under `queries/` (no content, gitignored); the curated artifact is what the knowledge layer's maintainers read. Do not record prompts, transcripts, or source text in either.

## Mixed and out-of-domain work

For mixed requests, group related issues into internal work packets and continue an independent packet once its evidence is sufficient.

DeepSeek Harness, preset composition, Cordis plugin, Web/UI, and runtime-infrastructure work belongs in a fresh Creator-mode session — finish any already-running compiler build or test first, and hand the Harness work over with a short summary of what was observed. Do not start that investigation here.
