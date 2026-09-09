# Shared Host Facts (tbe)

> Machine-level overlay source, owned by compiler-dev-harness
> (`contracts/hosts/tbe/AGENTS.local.md`). It is shared by every repository
> profile on this server and composed by `scripts/prepare-workspace.mjs` into
> each target's `AGENTS.local.md`; edit this source, never a materialized
> copy, and re-run preparation after editing.
>
> Facts scoped to one repository's workflow on this machine (LLVM builds,
> Python environments, per-repo build commands, repo-specific workarounds)
> live in the per-profile deltas under `contracts/<Profile>/hosts/tbe/`.

This file defines machine-specific configuration of this server that does not
depend on which target repository is being worked on.

It supplements the target repository's own contract; repository-wide
build/test semantics stay there, only machine-level facts belong here.

---

# 1. Environment Ownership

CANN, LLVM, Python/Conda, and other machine-specific toolchains are selected and prepared by the user.

The agent may validate the resulting environment but must not independently discover, install, replace, or switch toolchains unless explicitly requested.

---

# 2. CANN (this server)

## Required user configuration

CANN setup command:

```bash
/data/pri/cann-9.1.0/set_env.sh
```

Expected validation:

```bash
test -n "$ASCEND_HOME_PATH"
```

The agent may report the active `ASCEND_HOME_PATH` and detected version after setup, but must not select another CANN installation automatically.

---

# 3. Machine Capacity

```text
256 CPU cores, 503 GiB RAM, 8 GiB swap
```

Build-parallelism decisions that follow from this capacity are recorded per repository (they depend on each build system's default parallelism), not here.

---

# 4. Accelerator Availability

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

- If `npu-smi` and the expected device/runtime are available, device tests may be run according to the target repository's contract.
- If unavailable, report device-dependent tests as unavailable.
- Do not fake or override accelerator detection merely to execute device tests.

---

# 5. Host Verification Capabilities (framework)

DSH may infer the current capability set from the prepared environment and report it at point of use. Which capabilities a repository actually needs is defined by that repository's contract; this section only frames what the machine can contribute.

Typical host-only capabilities may include:

```text
Python syntax checks
host-side pytest
MLIR/FileCheck tests
native compilation
wheel builds
```

Typical device-dependent capabilities include:

```text
Ascend kernel execution
device E2E tests
performance tests
hardware profiling
```

Do not duplicate the full repository test matrix here; per-profile deltas and the repository contract record the repository-specific parts. This layer only records machine-level facts and server-specific exceptions.

---

# 6. E2E Compiler Toolkit Inventory (this server)

The E2E compiler toolkits live outside any repository and change independently of them; which version to use is a per-run decision and must NOT be recorded as a fixed requirement. How a repository invokes them is defined by that repository's contract or profile delta.

Base directories on this server:

```text
bishengir-compile toolkits: /home/s00653124/workspace/bishengir-toolkits
bisheng (ccec) compiler:    /home/s00653124/workspace/ccec-toolkits/20260814_CI/ccec_compiler/bin
```

List available AscendNPU IR versions:

```bash
ls -1 /home/s00653124/workspace/bishengir-toolkits | grep '^ascendnpuir_'
```

Version snapshot (2026-09-03): newest is `ascendnpuir_20260903_5671889a3`

---

# 7. Approved Local Workarounds (machine level)

Only stable, intentionally approved machine-specific workarounds belong here; repository-coupled workarounds live in the per-profile deltas.

```text
NONE
```

An agent-discovered workaround is not automatically approved.

If a new workaround is needed, report it to the user and suggest adding it here (to this harness source, not to a materialized copy).

---

# 8. Optional Local Notes (machine level)

Machine-specific facts that materially affect development on this server:

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
