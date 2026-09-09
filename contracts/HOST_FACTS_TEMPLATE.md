# Host Facts Template (minimal required information)

Per-server facts can never be generated: they are **your** configuration of
that machine (CANN setup, toolchain paths, Python environment, accelerator,
E2E toolkit locations). This template is the minimal set you provide; the
harness materializes it verbatim and never invents values.

Facts come in two layers (see `contracts/README.md`):

- **Shared machine layer** — `contracts/hosts/<host-id>/AGENTS.local.md`:
  true for every repository on that server. Copy this first.
- **Profile delta** — `contracts/<Profile>/hosts/<host-id>/AGENTS.local.md`:
  only what one repository's workflow adds on that server (Python env, build
  container, per-repo build commands, repo-coupled workarounds). Copy the
  delta scaffold only when needed; machine-level content is never duplicated
  into a delta.

## New-server onboarding

1. Copy the **machine layer** part of this file to
   `contracts/hosts/<host-id>/AGENTS.local.md`
   (`<host-id>` is usually the server hostname; run `hostname` there).
2. Replace **every** line marked `REQUIRED:` with the actual value — or the
   literal `NONE` when the machine has no such thing. Do not leave any
   `REQUIRED:` marker; preparation refuses to materialize an incomplete file.
   Placeholders marked `[USER MAY PROVIDE]` / `[DSH MAY DETECT AT SESSION
   TIME]` are legal to keep.
3. Add `contracts/hosts/<host-id>/host.json`:

   ```json
   { "host": "<host-id>", "hostnames": ["<hostname>", "<alias-or-container-hostname>"] }
   ```

   `hostnames` selects the source automatically (matched against the current
   machine's hostname, across the shared and profile layers); include
   container hostnames if you also start DSH inside a container on this
   server. Host identity is declared here once — profile deltas inherit it.
4. If a profile needs workflow-scoped facts on this server, copy the
   **profile delta** part of this file to
   `contracts/<Profile>/hosts/<host-id>/AGENTS.local.md` and fill it (same
   `REQUIRED:` discipline).
5. Re-run `scripts/prepare-workspace.mjs` in the target worktree.

Alternative (propose-not-persist): start a DSH session on the new server and
ask the agent to detect the environment and draft these files from the
template; **you** review, correct, and commit them. An agent never writes
these facts silently.

## Minimal required set

Machine layer (always):

| Field | Why the human must provide it |
|---|---|
| CANN setup command + validation | toolchain ownership: user selects, agent only validates |
| CMake / Ninja / ccache paths | machine-specific install locations |
| Expected accelerator device type (or NONE) | decides device-test eligibility |
| E2E toolkit base directories (or NONE) | external, evolving, host-specific |

Profile delta (when that repository's workflow needs them):

| Field | Why the human must provide it |
|---|---|
| Python / conda environment + activation | user-owned environment choice, often per-project |
| LLVM / extra toolchain setup (or NONE) | per-project toolchain pinning |
| Build container entry + per-repo build commands (or NONE) | workflow-scoped, repository-coupled |

Everything else has safe defaults (`NONE`, generic policy text).

---

# Shared Machine Layer (<host-id>) — COPY TO contracts/hosts/<host-id>/AGENTS.local.md

> Machine-level overlay source, owned by compiler-dev-harness. Shared by
> every repository profile on this server and composed by
> `scripts/prepare-workspace.mjs` into each target's `AGENTS.local.md`; edit
> this source, never a materialized copy, and re-run preparation after
> editing.

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
REQUIRED: (e.g. $HOME/CANN/cann/set_env.sh)
```

Expected validation:

```bash
test -n "$ASCEND_HOME_PATH"
```

The agent may report the active `ASCEND_HOME_PATH` and detected version after setup, but must not select another CANN installation automatically.

(A profile whose workflow requires a different CANN than the server default records that in its delta.)

---

# 3. Toolchain Paths and Standard Repair (this host)

- CMake:  REQUIRED: (absolute path + check command, e.g. `cmake --version`)
- Ninja:  REQUIRED: (absolute path + check command; note stale-symlink risks after container resets if relevant)
- ccache: REQUIRED: (absolute path + check command, or NONE)

After a container/host reset, validate all three BEFORE configuring; if a build fails with "file not found" from CMake-generated files, repair the toolchain path first, then delete the affected generated files rather than editing them in place, then rebuild incrementally.

Removing the ccache launcher invalidates object caching and forces a near-full rebuild; treat that cost as a decision, not an accident. (Per-repository rebuild scales, if notable, belong in the profile deltas.)

---

# 4. Machine Capacity (if measured)

```text
REQUIRED: (e.g. 256 CPU cores, 503 GiB RAM, 8 GiB swap — or NONE)
```

Build-parallelism decisions that follow from this capacity are recorded per repository (they depend on each build system's default parallelism), not here.

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
REQUIRED: (e.g. Ascend950PR, or NONE)
```

Policy:

- If `npu-smi` and the expected device/runtime are available, device tests may be run according to the target repository's contract.
- If unavailable, report device-dependent tests as unavailable.
- Do not fake or override accelerator detection merely to execute device tests.

---

# 6. Host Verification Capabilities (framework)

DSH may infer the current capability set from the prepared environment and report it at point of use. Which capabilities a repository actually needs is defined by that repository's contract; this section only frames what the machine can contribute.

Typical host-only capabilities may include:

```text
syntax/lint checks
host-side unit tests
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

# 7. E2E Compiler Toolkit Inventory (this server)

The E2E compiler toolkits live outside any repository and change independently of them; which version to use is a per-run decision and must NOT be recorded as a fixed requirement. How a repository invokes them is defined by that repository's contract or profile delta.

Base directories on this server:

```text
REQUIRED: (per-toolkit base directories, or NONE when unavailable)
```

Do not duplicate the full repository test matrix here.

---

# 8. Approved Local Workarounds (machine level)

Only stable, intentionally approved machine-specific workarounds belong here; repository-coupled workarounds live in the per-profile deltas.

```text
NONE
```

An agent-discovered workaround is not automatically approved.

If a new workaround is needed, report it to the user and suggest adding it here (to this harness source, not to a materialized copy).

---

# 9. Optional Local Notes (machine level)

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

---

# Profile Delta (<Profile>, <host-id>) — COPY TO contracts/<Profile>/hosts/<host-id>/AGENTS.local.md (only if needed)

> Profile-specific host-facts delta, owned by compiler-dev-harness. Composed
> with the shared machine layer (`contracts/hosts/<host-id>/`), the carried
> repository contract (if any), and the repository profile by
> `scripts/prepare-workspace.mjs`; edit this source, never a materialized
> copy, and re-run preparation after editing. Machine-level facts live in the
> shared machine layer; only this repository's workflow-scoped facts belong
> here.

---

# 1. Python / Conda

Preferred Python environment:

REQUIRED: (environment name and activation command, e.g. `conda activate <env>` inside docker `<container>`, or `/usr/bin/python3` on the host)

The agent may automatically report:

```text
python3 --version
which python3
```

after activation.

---

# 2. Extra Toolchain Setup (if this repository needs one beyond the shared layer)

```text
REQUIRED: (e.g. LLVM build + `export LLVM_SYSPATH=...`, or NONE)
```

---

# 3. Build Container Entry (if this repository uses one)

```text
REQUIRED: (docker exec command + in-container environment setup, or NONE)
```

---

# 4. Canonical / Incremental Build Commands (if this repository records them host-side)

```text
REQUIRED: (commands, or NONE when the repository contract owns them)
```

---

# 5. E2E Invocation Notes (if this repository needs host-specific mechanics)

```text
REQUIRED: (host-specific mechanics of this repository's E2E runner, or NONE)
```

---

# 6. Approved Local Workarounds (profile)

Only stable, intentionally approved workarounds for this repository's workflow on this host.

```text
NONE
```

An agent-discovered workaround is not automatically approved.

If a new workaround is needed, report it to the user and suggest adding it here (to this harness source, not to a materialized copy).

---

# 7. Optional Local Notes (profile)

```text
NONE
```

Keep this section short.
