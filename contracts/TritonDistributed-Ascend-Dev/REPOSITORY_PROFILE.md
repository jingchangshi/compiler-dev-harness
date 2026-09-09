# Triton-distributed-ascend Repository Profile (harness-owned)

This file belongs to **compiler-dev-harness**, not to the
Triton-distributed-ascend team repository. It holds personal harness policy
scoped to one target repository: how harness tools observe this repository,
and repository conventions the team does not track.

Effective repository operating context for this profile:

- The team repository does **not** track an upstream `AGENTS.md`; the
  repository operating contract is carried by this profile
  (`REPOSITORY_CONTRACT.md`) and reaches the worktree inside the managed
  `AGENTS.local.md` overlay. This profile never materializes as `AGENTS.md`
  and never writes one.
- The overlay is rendered additively by the DeepSeek Harness
  agent-instructions loader; if a local (untracked) `AGENTS.md` is also
  present in the worktree it loads first and the overlay refines it — after
  absorbing the contract, keeping both would duplicate the same knowledge,
  so the local copy should be removed by the human.

## 1. Source-context boundaries (compiler_inspect / Ripwire)

Generic repository-context tools must exclude the pinned external dependency
tree from the primary source corpus. Pass these contract parameters on every
`compiler_inspect` call in this repository, and reuse them consistently
within a session rather than rediscovering repository boundaries:

```text
exclude_dirs:
- 3rdparty

contract_test_dirs:
- unittest
- python/triton_dist/mega_triton_kernel/test
```

- `3rdparty/` (hyphenless) is the pinned submodule tree (`triton-ascend`,
  `shmem`, nested AscendNPU-IR / BiShengIR sources). The generic vendored
  default already de-prioritizes `3rdparty`, but the contract's submodule
  policy (§6) wants it outside the primary corpus entirely, so it is
  declared here explicitly. Inspect it only when the task explicitly
  requires those semantics (read-only).
- Root-level build/output noise (`build/`, `dist/`, `__pycache__/`, including
  `python/build` and `python/dist` wheel-build outputs) is covered by the
  built-in defaults and is not redeclared here.
- `contract_test_dirs` are the repository's own regression tests likely to
  reference touched symbols: the megakernel lit suite (`unittest/*.mlir`
  with `// RUN:` lines) and the host-side pytest tree. Device-only test
  roots (`python/triton_dist/test/ascend/`, the ops/scripts trees) are
  intentionally not listed; they run through `run_triton.sh` per the
  contract §9.3, not through symbol retrieval.

## 2. Build and E2E log forensics

Two log families dominate verification here; both are read bounded, never
streamed wholesale into context:

- `build.log` — the canonical wheel build's `tee` target (contract §4).
  Grep for the first `error:` / `ninja: build stopped` line and read a
  bounded window around it; pair with the failing translation unit.
- `run_triton.sh` case logs — the script derives its `tee` log name from
  `${CASENAME%%.*}`; for a case path that still contains slashes this
  breaks `tee` (exit code 1 even when the test passes, no log written).
  Run from the case's directory with a bare file name:

  ```bash
  cd python/triton_dist/mega_kernel_ascend/test/ops
  bash ../../../../../run_triton.sh ascendnpuir_20260903_5671889a3 test_mlp_layer.py python3
  ```

  The `<AscendNPU IR version>` argument is a per-run toolkit selection
  resolved from the host's shared machine facts (E2E compiler toolkit
  inventory), never a fixed requirement.

- Per-case E2E guide: `python/triton_dist/mega_kernel_ascend/test/ops/README.md`.
  Debug env vars (`TRITON_DEBUG`, `TRITON_CACHE_DIR`, `TRITON_DUMP_DIR`,
  `ENABLE_PRINT_UB_BITS`, `TRITON_PRINT_AUTOTUNING`) are pre-set by
  `run_triton.sh` per the contract §9.3.

## 3. Repository-local files that Git does not track

`run_triton.sh` (E2E helper) and this repository's contract are excluded
from Git via the worktree's `info/exclude`. After a fresh clone on a new
server, `run_triton.sh` will be absent: ask the user to restore it from
their previous worktree — do not reinvent it, and do not "fix" the repo by
committing it. The contract itself needs no restore; preparation
materializes it inside `AGENTS.local.md`.

## 4. Repository-specific knowledge pointers

- Detailed repository architecture knowledge may be maintained under
  `.dsh/skills/triton-distributed-ascend/` in the target repository
  (contract §13). Use repository-specific Skills only when relevant; do not
  duplicate environment/build instructions from the carried contract into
  them.
