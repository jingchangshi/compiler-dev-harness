# Repository Contracts: ownership and workspace preparation

This directory tracks the **harness-owned** half of each target compiler
repository's operating instructions. The team-owned half lives in the target
repository itself. The two ownership domains compose without competing for the
same tracked file:

```text
TEAM / TARGET REPOSITORY                     compiler-dev-harness
        │                                            │
        ├── AGENTS.md          (read-only)           ├── harness-wide policy (preset / skill)
        │     team-owned,                            ├── contracts/<Profile>/REPOSITORY_PROFILE.md
        │     tracked, follows                             harness repository profile
        │     normal Git evolution                   └── contracts/<Profile>/AGENTS.local.md
        │                                                  host-local facts
        ▼                                            │
  normal git pull / rebase                           ▼
  updates AGENTS.md normally        scripts/prepare-workspace.mjs
                                                     │
                                                     ▼
                                     <TARGET>/AGENTS.local.md
                                           generated, managed,
                                           git-excluded locally
```

## Ownership rules

- **Team `AGENTS.md`** (target repository, tracked) is upstream operational
  truth. The harness reads it and detects whether it exists or is tracked, but
  never overwrites it, never replaces it with a symlink, never marks it
  `skip-worktree`/`assume-unchanged`, never restores a harness copy after
  pull/rebase, and never silently merges harness policy into it.
- **`contracts/<Profile>/REPOSITORY_PROFILE.md`** is harness-owned repository
  policy for one target repository: `compiler_inspect` contract parameters
  (`exclude_dirs`, `contract_test_dirs`), harness tool disciplines, and
  repository conventions the team does not track.
- **`contracts/<Profile>/AGENTS.local.md`** is host-specific personal fact
  material (toolchain paths, accelerator availability, workarounds).
- **`<TARGET>/AGENTS.local.md`** is the only harness artifact inside the target
  worktree: a generated copy of (profile + local facts) with a managed header
  (`compiler-dev-harness:managed-v1`, profile name, content SHA-256). Ownership
  is detected by content, not by filename; the digest detects hand edits.

The deployed file name is `AGENTS.local.md` because that is the additive
local-overlay candidate the DeepSeek Harness agent-instructions loader reads by
default (rendered after the base `AGENTS.md`, never shadowing it). The source
files above keep harness-side names; only the deployed copy uses the loader's
name.

## Preparation

```sh
node <harness>/scripts/prepare-workspace.mjs [target-root]   # materialize/update
node <harness>/scripts/prepare-workspace.mjs --check [root]  # validate only
# optional: --profile <name> forces a profile; --harness-root <dir> overrides
```

The script resolves the actual Git worktree root, identifies the profile
(explicit `--profile` > remote-URL match > worktree basename; no/ambiguous
match is a bounded failure), never touches the team `AGENTS.md`, materializes
or updates the managed overlay (refusing unmanaged or hand-edited files), adds
an idempotent marked entry to Git's per-repository `info/exclude`
(**not** the team's tracked `.gitignore`), and validates via
`git check-ignore`. Exit codes: 0 ok, 1 conflict/drift, 2 usage/unknown profile.

Cases for an existing `<TARGET>/AGENTS.local.md`:

| Case | Behavior |
|---|---|
| absent | materialize |
| managed, intact | update if harness sources changed, else no-op (idempotent) |
| unmanaged file | refuse with actionable migration guidance |
| foreign-managed / hand-edited managed | refuse with digest evidence |
| team `AGENTS.md` changed upstream | nothing to do; preparation still succeeds |

## Git and worktree semantics

- The exclusion lives in the **common** Git dir (`git rev-parse --git-path
  info/exclude` resolves correctly for normal clones, linked worktrees, and
  `.git`-file layouts), so one entry covers every linked worktree.
- The overlay artifact is per working tree: run preparation once inside each
  new `git worktree` — no manual Git metadata edits.
- After `git clone`: run preparation once. After `git pull`/`rebase`: nothing —
  the team `AGENTS.md` updates normally and the overlay stays valid. After
  editing harness sources: re-run preparation (the `--check` mode reports
  drift). The DSH preset composition has no reliable startup-script hook
  (rows are service/tool/prompt registrations), so invocation is explicit and
  the command is idempotent, keeping the architecture ready for later
  automatic invocation.

## Current profiles

- `AscendNPU-IR-Dev/` — profile for the `gitcode.com/Ascend/AscendNPU-IR`
  repository and its personal forks (local checkout directory currently named
  `AscendNPU-IR-Dev`; the profile name is a stable label, and identity is
  matched from remote URLs first because clones and worktrees may use any
  local directory name).

## Migration record (2026-09-07)

The previous design kept `contracts/AscendNPU-IR-Dev/AGENTS.md` as a "tracking
master": a frozen snapshot of the target repository's `AGENTS.md` with harness
additions merged in, which humans were expected to apply back into the target
repository. That competes with the team's own evolving tracked file, so it was
removed (git history and the c42038d commit retain it). Content classification
and destinations:

| Source (old) | Category | Destination |
|---|---|---|
| `AGENTS.md` §0 preamble, §7/§8/§14 (working-tree/git-history/do-not-rediscover) | A — team upstream | team `AGENTS.md` in the target repository (live file; not duplicated here) |
| `AGENTS.md` §1 repository map, §2–§6 (environment/build/submodules), §9–§12 (verification/formatting), §16 updating-the-contract | A — team upstream | team `AGENTS.md` in the target repository |
| `AGENTS.md` §1 Source-context boundaries (`exclude_dirs`), `bishengir/test` as `contract_test_dirs` | B — harness profile | `AscendNPU-IR/REPOSITORY_PROFILE.md` §1 |
| `AGENTS.md` §1 hivmc/ A5 mirror tree | B — harness profile | `AscendNPU-IR/REPOSITORY_PROFILE.md` §2 |
| `AGENTS.md` §15 Compile Pipeline Log Forensics | B — harness profile | `AscendNPU-IR/REPOSITORY_PROFILE.md` §3 |
| `AGENTS.md` §13 `.dsh/skills/ascendnpu-ir-expert` pointer | B — harness profile | `AscendNPU-IR/REPOSITORY_PROFILE.md` §4 |
| `AGENTS.local.md` §1–§8 (CANN, toolchain repair, Python/conda, accelerator, host capabilities, toolkits, workarounds) | C — host-local | `AscendNPU-IR/AGENTS.local.md` (source), materialized by prepare |
| `AGENTS.md`/`AGENTS.local.md` provenance headers ("tracking copy/master") | D — stale | dropped; this README records provenance |

Deploying into the real target repository is a human step (the agent only
proposes): run the preparation command above inside the target worktree. If an
unmanaged `AGENTS.local.md` is already there (as in the current
`AscendNPU-IR-Dev` checkout, whose content is preserved verbatim in the
harness source), move any unique edits into the harness source, delete the
target file, and re-run preparation.
