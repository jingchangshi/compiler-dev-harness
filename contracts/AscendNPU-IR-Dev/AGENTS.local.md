# Local Host Environment

> Centralized tracking copy managed in `compiler-dev-harness/contracts/AscendNPU-IR-Dev/`.
> Base: `AscendNPU-IR-Dev/AGENTS.local.md` (snapshot 2026-09-07). Integrates
> contract proposal 2 (toolchain paths and standard repair, Section 3) from
> `analysis/contract-proposals-2026-09-06.md`; proposal 3 is Triton-distributed-ascend
> only and is intentionally not tracked here. See `contracts/README.md`.

This file defines machine-specific configuration for the current server.

It supplements `AGENTS.md`.

Repository-wide build/test semantics belong in `AGENTS.md`; only host-specific facts belong here.

---

# 1. Environment Ownership

CANN, LLVM, Python/Conda, and other machine-specific toolchains are selected and prepared by the user.

The agent may validate the resulting environment but must not independently discover, install, replace, or switch toolchains unless explicitly requested.

---

# 2. CANN

## Required user configuration

CANN setup command:

```bash
$HOME/CANN/cann/set_env.sh
```

Expected validation:

```bash
test -n "$ASCEND_HOME_PATH"
```

The agent may report the active `ASCEND_HOME_PATH` and detected version after setup, but must not select another CANN installation automatically.

---

# 3. Toolchain Paths and Standard Repair (this host)

- CMake:  `/opt/cmake/bin/cmake`  (check: `cmake --version`)
- Ninja:  `/usr/local/bin/ninja`  (check: `ninja --version`; a stale symlink may point into another user's home after container resets)
- ccache: `/usr/bin/ccache`       (check: `ccache --version`)

After a container/host reset, validate all three BEFORE configuring; if a build fails with "file not found" from CMake-generated files, repair the toolchain path first, then delete the affected generated files rather than editing them in place, then rebuild incrementally.

Removing the ccache launcher invalidates object caching and forces a near-full rebuild (~4600 targets); treat that cost as a decision, not an accident.

---

# 4. Python / Conda

Preferred Python environment:

- inside docker `s00653124_build`, use `python3` under conda's `triton-py311`
  Activation command: `conda activate triton-py311`
- inside host, use `/usr/bin/python3`
  Directly call `python3`

The agent may automatically report:

```text
python3 --version
which python3
```

after activation.

---

# 5. Accelerator Availability

DSH may determine current availability using:

```bash
command -v npu-smi >/dev/null && npu-smi info
```

Detected state:

```text
[DSH MAY DETECT AT SESSION TIME]
```

Optional expected device type:

```text
Ascend950PR
```

Policy:

- If `npu-smi` and the expected device/runtime are available, device tests may be run according to `AGENTS.md`.
- If unavailable, report device-dependent tests as unavailable.
- Do not fake or override accelerator detection merely to execute device tests.

---

# 6. Host Verification Capabilities

DSH may infer the current capability set from the prepared environment and report it at point of use.

Typical host-only capabilities may include:

```text
MLIR/FileCheck tests
native compilation
```

Typical device-dependent capabilities include:

```text
Ascend kernel execution
device E2E tests
performance tests
hardware profiling
```

To run E2E tests, run the following cmds:

```text
[USER MAY PROVIDE]
```

E2E tests require AsendNPU IR compiler `bishengir-compile` and BiSheng compiler `bisheng`.
Both versions of `bishengir-compile` and `bisheng` may evolve as AscendNPU IR repo evolves.

### bishengir-compile / bisheng toolkits (per-run version selection)

The E2E compiler toolkits live outside the repo and change independently of it; which
version to use is a per-run decision and must NOT be recorded as a fixed requirement.

Base directories on this host:

```text
bishengir-compile toolkits: /home/shijingchang/workspace/bisheng-toolkits/dev/bin
bisheng (ccec) compiler:    /home/shijingchang/workspace/ccec-toolkits/default/ccec_compiler/bin
```

Do not duplicate the full repository test matrix here.

This section only records server-specific exceptions.

---

# 7. Approved Local Workarounds

Only list stable, intentionally approved machine-specific workarounds.

## PYTHONPATH

```text
NONE
```

## Device detection

```text
NONE
```

## Built-package overlay

```text
NONE
```

## Other

An agent-discovered workaround is not automatically approved.

If a new workaround is needed, report it to the user and suggest adding it here.

---

# 8. Optional Local Notes

Machine-specific facts that materially affect development:

```text
NONE
```

Examples:

```text
specific filesystem limitation
known unavailable system package
local proxy requirement
special compiler cache location
server-specific device limitation
```

Keep this section short.

