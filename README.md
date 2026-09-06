# Compiler Dev preset

## Normal workflow

Enter a compiler repository, start DeepSeek Harness with **Compiler Dev**, and describe the task naturally. The preset retains the Standard coding-agent tools and adds an always-on compiler core policy, the `compiler-development` skill for detailed guidance, and `compiler_inspect`.

"Understand repository architecture" means the smallest architecture or data-flow model needed for the current task. "Understand latest N commits" means use N commits as the relevant history-search horizon, not read every full commit.

## Always-on core policy and the skill

The composition's `compiler-inspect` row registers a compact, always-on system-prompt section: contract-first operations, no rediscovery of documented procedures, task-relevant architecture only, history horizons, `compiler_inspect` first for anchored code/design/history tasks, minimal patches, bounded verification, bounded command output, lightweight evidence checkpoints, and the Creator-mode domain boundary. The preset-local `compiler-development` skill (`skills/compiler-development/`) carries the detailed, conditional guidance — anchor workflow, contract precedence, checkpoint semantics, verification classification, and mixed/out-of-domain work handling. Critical invariants never depend on the model loading the skill.

## Repository Contract

For a repository used repeatedly, a human maintains the operational facts in `AGENTS.md` or a nearby Markdown file based on `REPOSITORY_CONTRACT_TEMPLATE.md`. Put every-task facts in `AGENTS.md`; put larger subsystem-specific material in a project-local Skill or reference. Do not duplicate it.

A contract can specify environment initialization, build and test commands, accelerator constraints, submodule policy, repository boundaries, and approved workarounds. The agent uses these facts before operational discovery and validates a command only at its point of use. It never silently persists inferred facts; it reports a newly useful workaround as a candidate human update.

## Inspection and verification

`compiler_inspect` (v1.1) batches repository state, requested anchors, probable definitions with bounded context, ranked references, likely tests, optional working-tree diff, and path/symbol-scoped history into one bounded bundle — batched searches, default exclusion of `.git`/build/cache noise and vendored trees (with a bounded vendored fallback), and a strict total character budget. It does not infer build or environment commands. Pass the Repository Contract's relevant test directories as `contract_test_dirs` and its vendored/submodule boundaries as `exclude_dirs`; those constraints guide task-specific exploration without duplicating the contract.

Verification starts with targeted checks. A failed command is classified as patch-caused, environment, pre-existing, or unknown. A suspected unrelated blocker gets at most one focused control experiment; once demonstrated, record it and what it prevents, continue unaffected checks, and stop investigating it.

## Early compaction (experimental)

Derived from four audited production sessions: long discovery phases reached ~250K cached tokens on 1M-context routes with no compaction event, so implementation and verification ran on top of a huge discovery history. The preset configures `compaction-basic` `modelPolicies` for confirmed 1M-context routes (DeepSeek-V4 and GLM-5.3 families on their deployed providers): `thresholdRatio: 0.2` (compact near ~200K tokens) with `retainTokens: 65536`. Other presets, unknown models, and small-context routes keep the default 80% overflow threshold. The matching `contextWindow` declarations live in `~/.dsh/settings.yaml`; extend the policy list only after a route's capacity is confirmed there. The tool-result pruner stays in the same compaction realm and participates whenever compaction triggers.

## Session observability

`scripts/analyze-session.mjs` is an offline, non-model-facing analyzer for exported session logs:

```sh
node scripts/analyze-session.mjs <session.jsonl>     # or .jsonl.zstd
node --test scripts/test/                            # run its tests
```

It reports model steps, tool-call mix, `compiler_inspect` adoption, skill-load failures, token accounting, peak request context, tool-result sizes, and compaction counts. It reads the concatenated-frame `.jsonl.zstd` artifacts this deployment writes and tolerates missing fields.

## Reloading preset plugin edits

The host process caches preset plugin modules by file URL for its lifetime. After editing `compiler-inspect-v3-1.cjs`, rename the file (and update the composition row); after editing `compiler-inspect-driver.mjs`, bump the `?v=` query in the plugin's import. Composition YAML (rows, config, skill directories) is re-read at every session mount.

## Phase 2 candidates

Consider deeper LSP retrieval only after measuring symbol-match quality. Repository-specific architecture Skills, exploration-depth guards, semantic diff guards, and automatic contract promotion remain optional follow-up work requiring new production evidence.
