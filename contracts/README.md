# Repository Contracts: ownership and workspace preparation

This directory tracks the **harness-owned** half of each target compiler
repository's operating instructions. The team-owned half lives in the target
repository itself. The two ownership domains compose without competing for the
same tracked file:

```text
TEAM / TARGET REPOSITORY                     compiler-dev-harness
        │                                            │
        ├── AGENTS.md          (read-only)           ├── harness-wide policy (preset / skill)
        │     team-owned when tracked;               ├── contracts/<Profile>/REPOSITORY_CONTRACT.md
        │     a repository may track none                  optional carried contract
        │     (see ownership rules)                  ├── contracts/<Profile>/REPOSITORY_PROFILE.md
        │                                            │     harness repository profile
        ▼                                            ├── contracts/hosts/<host-id>/AGENTS.local.md
  normal git pull / rebase                           │     shared machine facts
  updates AGENTS.md normally                         ├── contracts/<Profile>/hosts/<host-id>/AGENTS.local.md
                                                     │     profile host facts (delta)
                                                     ▼
                                     scripts/prepare-workspace.mjs
                                                     │
                                                     ▼
                                     <TARGET>/AGENTS.local.md
                                           generated, managed composition:
                                           contract → profile → shared → delta
                                           git-excluded locally
```

## Ownership rules

- **Team `AGENTS.md`** (target repository, tracked) is upstream operational
  truth. The harness reads it and detects whether it exists or is tracked, but
  never overwrites it, never replaces it with a symlink, never marks it
  `skip-worktree`/`assume-unchanged`, never restores a harness copy after
  pull/rebase, and never silently merges harness policy into it.
- **`contracts/<Profile>/REPOSITORY_CONTRACT.md`** (optional) carries the
  repository operating contract for target repositories whose team does **not**
  track an upstream `AGENTS.md` (the Triton-distributed-ascend case). Its
  content is human-curated: agents propose, the human decides. The harness
  deploys it inside the managed overlay and never materializes it as
  `AGENTS.md`; if the team later adopts a tracked `AGENTS.md` upstream, the
  carried contract is retired and the ordinary team-file mode takes over.
- **`contracts/<Profile>/REPOSITORY_PROFILE.md`** is harness-owned repository
  policy for one target repository: `compiler_inspect` contract parameters
  (`exclude_dirs`, `contract_test_dirs`), harness tool disciplines, and
  repository conventions the team does not track.
- **Shared machine facts** live per server:
  `contracts/hosts/<host-id>/AGENTS.local.md` (+ `host.json` with `host` id and
  `hostnames` aliases). They hold what is true for **every** repository on that
  machine (CANN setup, toolchain paths, accelerator, machine capacity, E2E
  toolkit inventory, machine-level workaround policy) so that adding a profile
  or a server never re-copies them.
- **Profile host facts** are per-profile deltas:
  `contracts/<Profile>/hosts/<host-id>/AGENTS.local.md` — facts scoped to one
  repository's workflow on that machine (Python environments, build
  containers, per-repo build commands, repo-coupled workarounds). Host
  identity is declared once, in the shared layer's `host.json`; a delta-only
  host (no shared entry yet) may declare its own.
- Preparation selects the host by the current machine's hostname (matched
  against the **union** of both layers' `hostnames`), or explicitly via
  `--host <id>`. A match may be shared-only, delta-only, or both; a legacy
  profile-level `AGENTS.local.md` still works for single-host layouts (both
  that and a `hosts/` layer at once is an error). Host facts are
  **human-provided** — `contracts/HOST_FACTS_TEMPLATE.md` is the minimal
  required set, preparation refuses files that still contain `REQUIRED:`
  placeholders, and materialized values are never invented by the agent.
- **`<TARGET>/AGENTS.local.md`** is the only harness artifact inside the target
  worktree: a generated, managed composition (carried contract → repository
  profile → shared machine facts → profile delta, in that order) with a
  managed header (`compiler-dev-harness:managed-v1`, profile name, content
  SHA-256, exact source files). Ownership is detected by content, not by
  filename; the digest detects hand edits. When a host has shared facts but no
  delta for the profile, preparation appends a missing-delta notice pointing
  at the template.

The deployed file name is `AGENTS.local.md` because that is the additive
local-overlay candidate the DeepSeek Harness agent-instructions loader reads by
default (rendered after the base `AGENTS.md`, never shadowing it). The source
files above keep harness-side names; only the deployed copy uses the loader's
name.

## Preparation

```sh
node <harness>/scripts/prepare-workspace.mjs [target-root]   # materialize/update
node <harness>/scripts/prepare-workspace.mjs --check [root]  # validate only
# optional: --profile <name> / --host <id> force selection; --harness-root overrides
```

The script resolves the actual Git worktree root, identifies the profile
(explicit `--profile` > remote-URL match > worktree basename; no/ambiguous
match is a bounded failure), selects the host facts layers for **this**
machine (explicit `--host` > hostname match over the union of
`contracts/hosts/` and `contracts/<Profile>/hosts/`), never touches the team
`AGENTS.md`, materializes or updates the managed overlay (refusing
unmanaged, hand-edited, or incomplete-`REQUIRED:` files), adds an idempotent
marked entry to Git's per-repository `info/exclude` (**not** the team's
tracked `.gitignore`), and validates via `git check-ignore`. Exit codes: 0
ok, 1 conflict/drift, 2 usage/unknown profile.

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

## Host facts: minimal template and new servers

Host-local facts are the one instruction class that cannot come from a
repository (team or harness): they describe a physical machine. Ownership and
flow:

1. **Human provides.** On a new server, copy `contracts/HOST_FACTS_TEMPLATE.md`
   to `contracts/hosts/<host-id>/AGENTS.local.md` (shared machine layer) and
   replace every `REQUIRED:` line with the actual value (or `NONE`); add
   `host.json` listing the machine's hostnames (include a container hostname
   if DSH also runs inside one there). If a profile needs workflow-scoped
   facts on that server, copy the template's delta scaffold to
   `contracts/<Profile>/hosts/<host-id>/AGENTS.local.md`. Keep
   `[USER MAY PROVIDE]` / `[DSH MAY DETECT AT SESSION TIME]` placeholders
   where they are legal.
2. **Agent may draft, never decides.** The propose-not-persist flow also works:
   start a DSH session on the new server and ask the agent to detect the
   environment and draft the file(s) from the template; the human reviews,
   corrects, and commits them. An agent never silently writes these facts.
3. **Preparation validates and materializes.** A source still containing
   `REQUIRED:` is refused (exit 1) before anything is written; a hostname with
   no matching source is refused (exit 2) with onboarding guidance — the
   previous server's facts are never materialized onto a new machine.
4. **Propagation.** After editing any harness source, re-run preparation in the
   target worktree; the managed header's sources line names the exact files
   that produced the deployed overlay.

## Current profiles

- `AscendNPU-IR-Dev/` — profile for the `gitcode.com/Ascend/AscendNPU-IR`
  repository and its personal forks (identity is matched from remote URLs
  first because clones and worktrees may use any local directory name). Host
  facts: shared machine layer `hosts/user12364/` (CANN, CMake/Ninja/ccache,
  Ascend950PR, bishengir-compile/ccec toolkit inventory) + profile delta
  `AscendNPU-IR-Dev/hosts/user12364/` (conda `triton-py311`, build container
  `s00653124_build`, canonical/incremental build commands).
- `TritonDistributed-Ascend-Dev/` — profile for the
  `gitcode.com/Ascend/Triton-distributed-ascend` repository and its personal
  forks. Carries the repository operating contract
  (`REPOSITORY_CONTRACT.md`) because the team repository does not track an
  upstream `AGENTS.md`. Host facts: shared machine layer `hosts/tbe/` (CANN
  `/data/pri/cann-9.1.0`, 256-core/503 GiB capacity, Ascend950PR,
  bishengir-toolkits/ccec-toolkits inventory) + profile delta
  `TritonDistributed-Ascend-Dev/hosts/tbe/` (conda `s00653124_mk`,
  `LLVM_SYSPATH=llvm4tritonascend`, MAX_JOBS=32 policy, `run_triton.sh`
  mechanics).

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

### Re-hosting addendum (2026-09-08)

By user decision, host-specific operational content from the removed
tracking-master contract returned as host facts; for these rows the table
above is superseded:

| Old tracking-master section | New destination |
|---|---|
| §2 build container entry (`docker exec` into `s00653124_build`, `ASCEND_HOME_PATH` guard) | `AscendNPU-IR-Dev/hosts/user12364/AGENTS.local.md` §9 |
| §2 `source set_docker_env.sh` | inlined into §9 (PATH reset, `/opt/cmake/bin`, conda `triton-py311`); the untracked target-repo script and its `info/exclude` entry were removed |
| §4 canonical build / §5 incremental build | `AscendNPU-IR-Dev/hosts/user12364/AGENTS.local.md` §10 |

## Migration record (2026-09-09): shared machine layer + Triton-distributed-ascend absorption

Two changes, both serving semi-automatic migration across servers and
repositories. `scripts/prepare-workspace.mjs` gained the shared machine layer
(`contracts/hosts/<id>/`), the optional carried contract source
(`REPOSITORY_CONTRACT.md`), deterministic multi-part composition
(contract → profile → shared → delta), and the missing-delta notice; the test
suite covers both layers.

### 1. Shared machine layer carved out of `AscendNPU-IR-Dev`

Host identity moved to `contracts/hosts/user12364/host.json` (the profile
delta's own `host.json` was removed). Moves into
`contracts/hosts/user12364/AGENTS.local.md` (verbatim unless noted):

| From `AscendNPU-IR-Dev/hosts/user12364/AGENTS.local.md` | To shared layer |
|---|---|
| §1 Environment Ownership | §1 |
| §2 CANN (setup command is machine-level) | §2 |
| §3 Toolchain Paths and Standard Repair | §3 (the "(~4600 targets)" ccache-rebuild scale stayed in the profile delta, where the build belongs) |
| §5 Accelerator Availability | §4 (wording adapted: "the team `AGENTS.md`" → "the target repository's contract", because the layer is cross-repository) |
| §6 capability framework text | §5 (framework only; per-repo E2E notes stay in the delta) |
| §6 bishengir-compile/bisheng toolkit base dirs + per-run selection policy | §6 toolkit inventory |
| §7 workaround policy scaffold | §7 |
| §8 Optional Local Notes scaffold | §8 |

Staying in the profile delta `AscendNPU-IR-Dev/hosts/user12364/AGENTS.local.md`
(renumbered §1–§5; numeric cross-references replaced by named ones): §4
Python/Conda, the ccache-rebuild scale note, the repo-coupled E2E notes
(`[USER MAY PROVIDE]`, "evolves as AscendNPU IR repo evolves"), §9 build
container entry, §10 canonical/incremental build.

### 2. Triton-distributed-ascend → `TritonDistributed-Ascend-Dev/`

Matching: remote substring `Triton-distributed-ascend` (covers `Ascend/` and
personal forks), basename `Triton-distributed-ascend`.

Key fact: the team repository does **not** track `AGENTS.md` upstream — the
worktree copies of `AGENTS.md`, `AGENTS.local.md`, and `run_triton.sh` are
excluded via the repository's `.git/info/exclude`. A fresh clone on a new
server would lose all three, so the contract is carried by the harness.
Classification:

| Source (target worktree, 2026-09-09) | Destination |
|---|---|
| `AGENTS.md` preamble + §1–§15 (repository scope, build environment, wheel/incremental builds, submodule policy, working-tree/git-history policy, verification matrix, failure policy, formatting, knowledge pointers, do-not-rediscover, update protocol) | `TritonDistributed-Ascend-Dev/REPOSITORY_CONTRACT.md` — verbatim except: provenance blockquote, §15 harness-carrying adaptation, "exmaple"→"example" typo fix |
| `AGENTS.md` §1/§6 boundaries → `3rdparty` as `exclude_dirs`; §9.2/§9.4 test roots as `contract_test_dirs` | `REPOSITORY_PROFILE.md` §1 |
| `AGENTS.local.md` §6 invocation note (run from the case dir; slashes break `tee`) | `REPOSITORY_PROFILE.md` §2 (script-generic, not host-specific) |
| `run_triton.sh` / contract untracked-excluded status | `REPOSITORY_PROFILE.md` §3 (restore-from-user rule on fresh clones) |
| `AGENTS.local.md` §1 Environment Ownership, §2 CANN, §5 Accelerator, §6 capability framework, §7 policy scaffold, §8 machine capacity (256 cores / 503 GiB / 8 GiB swap), §9 notes scaffold, §6 toolkit base dirs + version listing + snapshot | `contracts/hosts/tbe/AGENTS.local.md` (new shared machine layer; `host.json` with hostname `tbe`) |
| `AGENTS.local.md` §3 LLVM (`LLVM_SYSPATH=llvm4tritonascend`), §4 Python/Conda (`s00653124_mk`), §8 setup.py parallelism + OOM evidence + MAX_JOBS policy, §6 `run_triton.sh` mechanics + stale-PATH export, §7 two approved workarounds | `TritonDistributed-Ascend-Dev/hosts/tbe/AGENTS.local.md` (profile delta) |
| E2E example command (identical in `AGENTS.md` §9.3 and `AGENTS.local.md` §6) | kept once, in the carried contract §9.3; the delta references it |

### Deployment (human steps)

```sh
# Triton-distributed-ascend (tbe): the worktree files are unmanaged copies of
# the absorbed content. Verify nothing unique is lost (the harness sources
# carry it all), delete the local copies, then materialize the managed overlay:
rm <target>/AGENTS.md <target>/AGENTS.local.md
node <harness>/scripts/prepare-workspace.mjs <target>
# note: run_triton.sh must be carried to new clones manually (it stays
# untracked); it is NOT deleted here.

# AscendNPU-IR-Dev worktrees: re-run preparation to pick up the shared-layer
# split; the managed overlay updates in place (or --check first to preview).
node <harness>/scripts/prepare-workspace.mjs [--check] <target>
```

Keeping a local `AGENTS.md` in the Triton worktree is possible (the loader
reads it first and the overlay refines it) but duplicates the same knowledge;
deletion after verifying the materialized overlay is recommended.
