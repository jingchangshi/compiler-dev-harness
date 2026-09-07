# AscendNPU IR Repository Contract

> Centralized tracking copy managed in `compiler-dev-harness/contracts/AscendNPU-IR-Dev/`.
> Base: `AscendNPU-IR-Dev/AGENTS.md` (snapshot 2026-09-07). Integrates the
> user-approved Source-context boundaries and contract proposals 1 and 4 from
> `analysis/contract-proposals-2026-09-06.md`. Applying changes to the target
> repository is a human decision; see `contracts/README.md`.

This file defines the stable repository-level contract for coding agents working in `AscendNPU-IR`.

Machine-specific toolchain paths, Python environments, accelerator availability, and server-specific workarounds belong in `AGENTS.local.md`.

Treat this file as authoritative operational knowledge.

Do not rediscover documented build or verification procedures from CMake, CI, shell scripts, or submodules unless:

- the documented procedure fails at the point of use;
- the current task explicitly concerns that infrastructure;
- or the user explicitly requests the investigation.

Use the smallest task-relevant repository exploration required for the current task.

---

# 1. Repository Scope

Repository root:

```text
AscendNPU-IR-Dev
```

Main repository-owned areas:

```text
bishengir/     compiler implementation
third-party/   pinned external dependencies/submodules
```

Do not attempt to understand the whole repository before starting a task.

Start from task-provided files, symbols, errors, or tests and expand only when required by unresolved evidence.

## Source-context boundaries

Generic repository-context tools such as compiler_inspect / Ripwire must exclude large vendored, generated, and build trees from the primary source corpus.

Source-context exclusions:

```text
third-party
build
build-*
out
```

The primary compiler source corpus is the project-owned source tree.

Vendored/submodule code should only be inspected when the task explicitly requires it.

When invoking `compiler_inspect`, reuse these exclusions consistently rather than rediscovering repository boundaries.

## hivmc/ A5 mirror tree

- `bishengir/hivmc/` mirrors `bishengir/lib` and `bishengir/include` for the A5 image tree.
- Any change under `bishengir/lib` or `bishengir/include` must state whether the hivmc mirror needs the same change; if it does, apply it or explicitly report the deferred mirror edit.

---

# 2. Build Environment

Before any compilation, CMake reconfiguration, native build, wheel build, or build-dependent test, first enter the docker

```
docker exec -it \
  -u shijingchang \
  -e HOME=/home/shijingchang \
  -w /home/shijingchang \
  s00653124_build \
  /bin/bash
```

Then enter the the repository root and run:

```bash
cd $HOME/workspace/AscendNPU-IR-Dev
source set_docker_env.sh
```

The host must already have the external toolchains prepared by the user.

Required environment variables:

```text
ASCEND_HOME_PATH
```

Require python3 version at least 3.8.
Require cmake version at least 3.28.0.
Require ninja version at least 1.12.0.
Require clang version at least 13.

Before build-dependent work, validate:

```bash
: "${ASCEND_HOME_PATH:?CANN environment is not configured. Prepare the host environment first.}"
```

- python3 version at least 3.8
- cmake version at least 3.28.0
- ninja version at least 1.12.0
- clang and clang++ version at least 13

If either variable is missing:

1. Stop the build-dependent operation.
2. Report the missing prerequisite.
3. Ask the user to prepare the host environment.
4. Do not search the filesystem for another CANN or LLVM installation.
5. Do not guess, hard-code, or automatically switch toolchains.

Machine-specific setup commands are defined in `AGENTS.local.md`.

---

# 3. Build Root

The build root is:

```text
./
```

---

# 4. Canonical Build

From the repository root:

```bash
docker exec -it \
  -u shijingchang \
  -e HOME=/home/shijingchang \
  -w /home/shijingchang \
  s00653124_build \
  /bin/bash

cd $HOME/workspace/AscendNPU-IR-Dev
source set_docker_env.sh

: "${ASCEND_HOME_PATH:?CANN environment is not configured. Prepare the host environment first.}"

bash ./build-tools/build.sh   \
  --c-compiler clang --cxx-compiler clang++   \
  '--add-cmake-options=-DLLVM_ENABLE_LLD=ON'   \
  --build-type Release \
  --enable-assertion   \
  -t --bisheng-compiler $HOME/workspace/ccec-toolkits/default/ccec_compiler/bin \
  --disable-werror --disable-bishengir-werror \
  --build-triton \
  --build-shmem-template \
  --build ./build --fast-build \
  -j 64 \
  2>&1 | tee build.log

ninja -C build -j 64 bishengir-opt bishengir-compile
```

This is the canonical full compiler build unless the user explicitly supplies another command for the current task.

Do not derive or substitute another full build procedure by inspecting CMake or CI.

Note:

- it is possible that `--build-type Debug` may be required to debug cases
- `--enable-assertion` is required to enable `bishengir-compile -debug` so that we can dump the Pass log.
  But this option results in longer compilation time of `bishengir-compile`.
- `--build-triton` depends on `bishengir/triton` directory
- `--build-shmem-template` depnds on `third-party/shmem` submodule

Build policy:

```text
CANN              use ASCEND_HOME_PATH
```

Do not hard-code machine-specific toolchain paths.

---

# 5. Incremental Build

Use the repository's standard incremental build for native compiler changes:

```bash
ninja -C build -j 64 bishengir-opt bishengir-compile
```

`ninja` does not read `MAX_JOBS` and defaults to `nproc` jobs; under memory pressure
append `-j 64` to match the Section 4 build-parallelism policy.

Do not spend substantial time reverse-engineering smaller Ninja targets unless:

- the current task explicitly requires one;
- or a smaller target is already documented.

---

# 6. Submodule Policy

`third-party/` contains pinned external dependencies and submodules.

Default rules:

1. Treat submodules as external/pinned dependencies.
2. Read-only inspection is allowed when required for task-relevant semantics.
3. Modify a submodule only when the task genuinely requires a change there and there is direct evidence supporting it.
4. Do not update submodule revisions merely to make an unrelated build/test pass.
5. Do not run broad reset/clean operations inside submodules.
6. Never discard pre-existing user modifications.
7. Builds may create or modify generated files inside submodules; distinguish generated artifacts from user changes before cleanup.
8. If a failure appears caused by submodule/toolchain version skew, treat it as an environment/pre-existing blocker unless repairing that dependency is part of the task.

In particular:

```text
third-party/llvm-project
    pinned LLVM & MLIR dependency
```

Do not cross these boundaries merely because related code exists there.

---

# 7. Working Tree Safety

Before editing:

```bash
git status --short
```

Preserve all existing user changes.

Do not use destructive repository-wide commands such as:

```text
git reset --hard
git clean -fd
git checkout -- .
git restore <unrelated-user-file>
```

A narrowly scoped temporary stash may be used only for a necessary control experiment and must be restored immediately.

---

# 8. Git History Policy

When the user asks to understand the latest `N` commits, treat `N` as a history search horizon rather than an instruction to read all commits completely.

Prefer:

```bash
git log --oneline -N
git log -N -- <relevant-path>
git log -S'<symbol>' -- <relevant-path>
git log -G'<pattern>' -- <relevant-path>
git show <commit> -- <relevant-paths>
```

Inspect a full commit only when cross-file design intent requires it.

Ignore unrelated changes.

---

# 9. Verification Matrix

Use the smallest reliable verification first.

## 9.1 MLIR / FileCheck / lit tests

Use for:

```text
Dialect changes
conversion/lowering
memory effects
canonicalization
pass behavior
IR regressions
```

Test roots:

```text
bishengir/test # pinned backend's lit suite, wired by the top-level CMakeLists
```

Canonical optimizer / lit command:

```text
Test runner: llvm-lit
IR checker: FileCheck
Optimizer(s): use the tool specified by the test RUN line
```

The test suite runs every `*.mlir` with a `// RUN:` line through the
repository-local `bishengir-opt` or `bishengir-compile` driver.

```bash
# whole mlir test suite
ninja -C build -j 64 check-bishengir 2>&1 | tee check.log

# single test
[USER MAY PROVIDE]
```

New MLIR regressions are added by dropping a mlir test case file under `bishengir/test` carrying a `// RUN:` line;
lit discovers them automatically.

Prefer repository-local lit tests and existing RUN lines rather than inventing new test invocations.

Do not hard-code absolute paths to `llvm-lit`, `FileCheck`, or MLIR optimizer binaries in repository-level instructions. Resolve their host-specific paths from `AGENTS.local.md` or the prepared environment.

Requires Ascend device:

```text
No
```

## 9.2 Ascend device / E2E tests

Use for:

```text
kernel launch
device execution
torch_npu integration
hardware-dependent runtime behavior
performance/profiling
```

Requires real Ascend hardware:

```text
Yes
```

Canonical commands:

```text
[USER MAY PROVIDE]
```

---

# 10. Verification Selection

Use approximately:

```text
MLIR/C++ change
    -> targeted textual/unit test
    -> incremental native build
    -> full wheel build when appropriate

device-runtime change
    -> host-side validation where possible
    -> device test only when the host supports it
```

Do not run every available test after every change.

---

# 11. Verification Failure Policy

Classify verification failures as:

```text
PATCH-CAUSED
ENVIRONMENT
PRE-EXISTING
UNKNOWN
```

If an environment/pre-existing failure is suspected, perform at most one focused control experiment needed to determine whether the failure reproduces independently of the patch.

Once reproduced independently:

1. Record the blocker.
2. Record the evidence.
3. State what verification it prevents.
4. Continue unaffected verification.
5. Stop investigating the unrelated blocker.

Do not spend extended effort repairing unrelated:

```text
submodule skew
toolchain versions
stale build trees
missing optional dependencies
device availability
CI configuration
third-party source failures
```

unless solving that problem is explicitly part of the task.

---

# 12. Formatting

Only format files or regions touched by the task.

Python formatter/linter:

```text
[DSH MAY DISCOVER AND PROPOSE]
```

C/C++ formatting mechanism:

```text
[DSH MAY DISCOVER AND PROPOSE]
```

MLIR/TableGen conventions:

```text
[DSH MAY DISCOVER AND PROPOSE]
```

Discover the repository's actual formatting convention if needed.

---

# 13. Repository-Specific Knowledge

Detailed repository architecture knowledge may be maintained under:

```text
.dsh/skills/ascendnpu-ir-expert
```

Use repository-specific Skills only when relevant.

Do not duplicate environment/build instructions from this file into those Skills.

Current task-specific behavior must still be verified against current source.

---

# 14. Do Not Rediscover

Unless the documented procedure fails or the current task explicitly concerns it, do not rediscover:

- environment initialization;
- canonical build root;
- canonical wheel build;
- LLVM selection mechanism;
- CANN selection mechanism;
- ccache/linker/Proton policy;
- incremental build command;
- submodule policy;
- canonical test commands once confirmed;
- device requirements once documented.

Repository exploration should focus on the engineering task.

---

# 15. Compile Pipeline Log Forensics

Issue workspaces (`~/workspace/issues/<case>/`) hold `bishengir-compile` pipeline logs (`--mlir-print-ir-after-all`) and their `.bcmlir` inputs.

- A pipeline log is organized by dump markers:
  `// -----// IR Dump After <PassName> (<pass-flag>) //-----`.
- Prefer `compiler_inspect` with `log_files` + `log_passes` for pass-indexed navigation, occurrence-addressed dump slices, and two-log pass-sequence diffs. Do not stream raw log sections into context; extract bounded line ranges (`grep -n` the marker, then `sed -n` a window, or awk NR ranges).
- When two logs must be compared (e.g. one flag toggled), diff the pass sequence first; the first divergence and per-pass count deltas usually localize the behavioral difference before any IR reading.

This section also governs the manual discipline to follow when `compiler_inspect` is not used.

---

# 16. Updating This Contract

This file is human-owned repository knowledge.

Agents may propose changes but must not silently rewrite operational facts.

For a proposed update, report:

```text
Current contract:
Observed evidence:
Suggested change:
Reason:
```

The human decides whether the change becomes authoritative.

