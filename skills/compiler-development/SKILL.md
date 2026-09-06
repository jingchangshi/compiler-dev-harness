---
name: compiler-development
description: Efficient, evidence-led workflow for Triton, MLIR, LLVM, and related compiler repositories.
whenToUse: Use for compiler architecture, code review, implementation, tests, or recent-history tasks.
---

# Compiler development

The preset's always-on core policy already binds the invariants: contract-first operations, task-relevant architecture only, one `compiler_inspect` bundle before serial exploration, minimal patches, bounded verification and output, lightweight checkpoints, and the Creator-mode domain boundary. This skill adds the detail and judgment behind those invariants. Load it for compiler work; do not expect it to restate the invariants.

## Working through anchors

Explore explicit anchors first: definitions, direct callers or implementations, applicable lowering or runtime semantics, related tests, then scoped history. Stop when the current design decision has enough evidence — extra exploration is spent tokens, not safety.

When calling `compiler_inspect`, pass what the Repository Contract already states: its test directories as `contract_test_dirs`, and its vendored/submodule or generated boundaries as `exclude_dirs`. Those constraints shape the bundle without duplicating the contract. Interpret the bundle as leads, not conclusions: a probable-definition line shows syntax and two context lines; open the file only when the context is insufficient to decide. A `Vendored matches` section or a truncation marker means the evidence is incomplete — narrow with exact anchors rather than broadening the search.

Treat "latest N commits" as a search horizon, not a request to read every commit. Inspect full commits only when the diff, not the message, carries cross-file design intent.

## Repository Contracts

Order of authority: human Repository Contract, then project instructions, then source, relevant history, inference. Load the contract before any environment, build, or test discovery. Validate a contract command only at its point of use; never replace it with an inferred procedure. Without a contract, discover only the facts this task needs and mention the missing contract only when it affects efficiency.

Never persist inferred operational facts. When a workaround or environment fact proves useful, propose it to the human as a candidate contract update. Use `REPOSITORY_CONTRACT_TEMPLATE.md` only when the human asks to establish or draft one.

## Checkpoints

A checkpoint is one line retained in the conversation — **Decision; Evidence; Uncertainty; Patch implication** — taken before a design-sensitive edit, when a large discovery phase hands off to implementation, and before long verification once design conclusions are stable. Its purpose is to survive compaction: the summary keeps the engineering state even when the raw evidence is shadowed. It is an evidence boundary, not a database; never emit ceremony after trivial reads.

## Verification

Verify narrowly first, then run broader repository-prescribed checks only when justified. Classify failures: patch-caused, environment, pre-existing, or unknown. For a suspected unrelated blocker, run at most one focused control experiment; once it demonstrates the blocker is unrelated, record the blocker, its evidence, and what verification it prevents, then continue unaffected checks and stop investigating it. Do not edit environment or dependency files merely to force green tests.

## Mixed and out-of-domain work

For mixed requests, group related issues into internal work packets and continue an independent packet once its evidence is sufficient.

DeepSeek Harness, preset composition, Cordis plugin, Web/UI, and runtime-infrastructure work belongs in a fresh Creator-mode session — finish any already-running compiler build or test first, and hand the Harness work over with a short summary of what was observed. Do not start that investigation here.
