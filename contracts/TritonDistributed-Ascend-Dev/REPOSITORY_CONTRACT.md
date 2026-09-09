# Triton-distributed-ascend Repository Contract

> Harness-carried contract (`contracts/TritonDistributed-Ascend-Dev/REPOSITORY_CONTRACT.md`).
> The team repository (`gitcode.com/Ascend/Triton-distributed-ascend`) does not
> track this file upstream — the worktree copy was local-only, excluded via the
> repository's `info/exclude`. It was absorbed here on 2026-09-09 so the
> contract travels with the harness across servers and fresh clones; the
> harness materializes it inside the managed `AGENTS.local.md` overlay and
> never writes a target `AGENTS.md`. Edit this harness source, then re-run
> preparation; agents propose changes, the human decides (Section 15).

This file defines the stable repository-level contract for coding agents working in `Triton-distributed-ascend`.

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
Triton-distributed-ascend
```

Main repository-owned areas:

```text
python/triton_dist/    Python/compiler implementation
lib/                   C++ / MLIR implementation
include/               C++ / TableGen headers and definitions
unittest/              repository-local regression/unit tests
3rdparty/               pinned external dependencies/submodules
```

Do not attempt to understand the whole repository before starting a task.

Start from task-provided files, symbols, errors, or tests and expand only when required by unresolved evidence.

---

# 2. Build Environment

Before any compilation, CMake reconfiguration, native build, wheel build, or build-dependent test, from the repository root run:

```bash
source set_env.sh
```

The host must already have the external toolchains prepared by the user.

Required environment variables:

```text
ASCEND_HOME_PATH
LLVM_SYSPATH
```

Before build-dependent work, validate:

```bash
: "${ASCEND_HOME_PATH:?CANN environment is not configured. Prepare the host environment first.}"
: "${LLVM_SYSPATH:?LLVM_SYSPATH is not configured. Prepare the host environment first.}"
```

If either variable is missing:

1. Stop the build-dependent operation.
2. Report the missing prerequisite.
3. Ask the user to prepare the host environment.
4. Do not search the filesystem for another CANN or LLVM installation.
5. Do not guess, hard-code, or automatically switch toolchains.

Machine-specific setup commands are defined in `AGENTS.local.md`.

---

# 3. Python Build Root

The Python package build root is:

```text
./python
```

For Python package or wheel builds:

```bash
cd ./python
```

Do not run the canonical wheel build from the repository root.

---

# 4. Canonical Python Wheel Build

From the repository root:

```bash
source set_env.sh

: "${ASCEND_HOME_PATH:?CANN environment is not configured. Prepare the host environment first.}"
: "${LLVM_SYSPATH:?LLVM_SYSPATH is not configured. Prepare the host environment first.}"

cd ./python

MAX_JOBS=32 \
TRITON_BUILD_WITH_CCACHE=true \
TRITON_BUILD_WITH_CLANG_LLD=true \
TRITON_BUILD_PROTON=OFF \
TRITON_APPEND_CMAKE_ARGS="-DTRITON_BUILD_UT=OFF" \
python3 setup.py bdist_wheel 2>&1 | tee build.log
```

This is the canonical full compiler/wheel build unless the user explicitly supplies another command for the current task.

Do not derive or substitute another full build procedure by inspecting CMake or CI.

Build policy:

```text
LLVM              use LLVM_SYSPATH
CANN              use ASCEND_HOME_PATH
CCache            TRITON_BUILD_WITH_CCACHE=true
Linker            TRITON_BUILD_WITH_CLANG_LLD=true
Proton            TRITON_BUILD_PROTON=OFF
Build jobs        MAX_JOBS=32 (see build-parallelism policy below)
```

Build-parallelism policy:

`MAX_JOBS=32` is mandatory on many-core hosts. `python/setup.py` defaults build
parallelism to `2 × cpu_count` (512 concurrent clang++ jobs on a 256-core machine),
which exhausts RAM/swap and OOM-kills compilation units (SIGKILL, exit code 137).
Do not raise it without first checking host memory.

Do not hard-code machine-specific toolchain paths.

---

# 5. Incremental Build

Use the repository's standard incremental build for native compiler changes:

```bash
cd ./python

BUILD_DIR="build/cmake.$(
python3 - <<'PY'
import sysconfig
print(
    sysconfig.get_platform()
    + "-cpython-"
    + str(sysconfig.get_python_version()).replace(".", "")
)
PY
)"

ninja -C "$BUILD_DIR" \
  triton_distributed \
  triton \
  triton-opt \
  triton-mlir-opt \
  libentryC.so
```

`ninja` does not read `MAX_JOBS` and defaults to `nproc` jobs; under memory pressure
append `-j 32` to match the Section 4 build-parallelism policy.

Do not spend substantial time reverse-engineering smaller Ninja targets unless:

- the current task explicitly requires one;
- or a smaller target is already documented.

---

# 6. Submodule Policy

`3rdparty/` contains pinned external dependencies and submodules.

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
3rdparty/triton-ascend
    pinned Ascend backend dependency

nested AscendNPU-IR / BiShengIR sources
    external compiler dependency; prefer read-only inspection
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

## 9.1 Python syntax / lightweight validation

For pure Python changes:

```bash
python3 -m py_compile <changed-python-files>
```

Requires Ascend device:

```text
No
```

## 9.2 Python host-side tests

Use targeted pytest tests for scheduler, scoreboard, code-generation helpers, and other device-independent Python logic.

Canonical test roots and commands may be discovered from the current repository once and proposed for inclusion here.

User confirmation is required before treating newly discovered commands as canonical.

Canonical command:

```text
# host-only pytest suite (scheduler / scoreboard logic, CPU tensors, no NPU)
pytest -q python/triton_dist/mega_triton_kernel/test/core/

# bare `pytest` from ./python runs the same tree via pytest.ini testpaths
pytest
```

`python/pytest.ini` configures the suite: `testpaths = triton_dist/mega_triton_kernel/test`
and `pythonpath = .` (tests import this checkout's sources, not the installed wheel).
`import torch` requires the CANN runtime environment (torch_npu loads `libhccl.so`);
host-specific activation is in `AGENTS.local.md`.

Known host-runnable tests:

```text
python/triton_dist/mega_triton_kernel/test/core/
    test_scheduler_core_affine.py, test_scoreboard_layout.py (pytest-style)
```

Known device-only tests:

```text
python/triton_dist/test/ascend/                  # pytest -m dist, see its README.md
python/triton_dist/mega_triton_kernel/test/ops/  # __main__ scripts, run via run_triton.sh (9.3)
python/triton_dist/mega_triton_kernel/test/models/
python/triton_dist/mega_kernel_ascend/test/ops/  # __main__ scripts, run via run_triton.sh (9.3)
```

## 9.3 Ascend device / E2E tests

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
# example test cmd
bash run_triton.sh <AscendNPU IR version> python/triton_dist/mega_kernel_ascend/test/ops/test_mlp_layer.py python3
# example of AscendNPU IR version is ascendnpuir_20260903_5671889a3
```

`<AscendNPU IR version>` selects the `bishengir-compile` toolkit for that run and
changes as the toolkits evolve; it is a per-run decision and is never fixed here.
Resolve the toolkit base directory, the currently recommended version, and any
runtime-library notes from `AGENTS.local.md`.

`EXE` is `python3` for the `__main__`-style ops scripts; `pytest -sv` only applies to
pytest-style files (the ops scripts collect zero tests under pytest).
A per-case guide (env prep, self-checks, run notes) is
`python/triton_dist/mega_kernel_ascend/test/ops/README.md`.

Whether the current server can run them is defined in `AGENTS.local.md`.

`run_triton.sh` is a script to help run E2E tests which is described in `AGENTS.local.md`.

`TRITON_DEBUG`, `TRITON_CACHE_DIR`, `TRITON_DUMP_DIR`, `ENABLE_PRINT_UB_BITS`, `TRITON_PRINT_AUTOTUNING` may be used to help debug E2E tests.
All these envs are already in `run_triton.sh`.

## 9.4 MLIR / FileCheck / lit tests

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
unittest/                        # megakernel lit suite: *.mlir files with // RUN: lines
3rdparty/triton-ascend/unittest  # pinned backend's lit suite, wired by the top-level CMakeLists
```

Canonical optimizer / lit command:

```text
Test runner: llvm-lit
IR checker: FileCheck
Optimizer(s): use the tool specified by the test RUN line
```

The megakernel suite runs every `unittest/*.mlir` with a `// RUN:` line through the
repository-local `megakernel-opt` driver (built by `unittest/CMakeLists.txt` together
with the wheel; it registers the distributed / dtile dialects and
`--convert-triton-distributed-to-hivm`). With `$BUILD_DIR` from section 5:

```bash
# whole megakernel suite
ninja -C "$BUILD_DIR" check-megakernel-mlir-tests

# single test
llvm-lit -sv "$BUILD_DIR/unittest/distributed_to_hivm.mlir"
```

New MLIR regressions are added by dropping a `unittest/*.mlir` carrying a `// RUN:` line;
lit discovers them automatically.

Prefer repository-local lit tests and existing RUN lines rather than inventing new test invocations.

Do not hard-code absolute paths to `llvm-lit`, `FileCheck`, or MLIR optimizer binaries in repository-level instructions. Resolve their host-specific paths from `AGENTS.local.md` or the prepared environment.

## 9.5 Full native/wheel verification

For changes affecting:

```text
C++
MLIR/TableGen
CMake
native bindings
compiler registration
linking
native code generation
```

use the canonical wheel build from Section 4 unless the documented incremental build provides sufficient coverage.

---

# 10. Verification Selection

Use approximately:

```text
Python-only change
    -> py_compile
    -> targeted host pytest
    -> native build only when required

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

Do not treat `clangd` itself as a formatter command; discover the repository's actual formatting convention if needed.

---

# 13. Repository-Specific Knowledge

Detailed repository architecture knowledge may be maintained under:

```text
.dsh/skills/triton-distributed-ascend/
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

# 15. Updating This Contract

This contract is human-owned repository knowledge, carried by compiler-dev-harness.

Agents may propose changes but must not silently rewrite operational facts. Proposals edit the harness source (`contracts/TritonDistributed-Ascend-Dev/REPOSITORY_CONTRACT.md`); the change reaches the worktree when preparation is re-run.

For a proposed update, report:

```text
Current contract:
Observed evidence:
Suggested change:
Reason:
```

The human decides whether the change becomes authoritative.
