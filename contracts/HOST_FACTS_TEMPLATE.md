# Host Facts Template (minimal required information)

Per-server facts can never be generated: they are **your** configuration of
that machine (CANN setup, toolchain paths, Python environment, accelerator,
E2E toolkit locations). This template is the minimal set you provide; the
harness materializes it verbatim and never invents values.

## New-server onboarding

1. Copy this file to
   `contracts/<Profile>/hosts/<host-id>/AGENTS.local.md`
   (`<host-id>` is usually the server hostname; run `hostname` there).
2. Replace **every** line marked `REQUIRED:` with the actual value — or the
   literal `NONE` when the machine has no such thing. Do not leave any
   `REQUIRED:` marker; preparation refuses to materialize an incomplete file.
   Placeholders marked `[USER MAY PROVIDE]` / `[DSH MAY DETECT AT SESSION
   TIME]` are legal to keep.
3. Add `contracts/<Profile>/hosts/<host-id>/host.json`:

   ```json
   { "host": "<host-id>", "hostnames": ["<hostname>", "<alias-or-container-hostname>"] }
   ```

   `hostnames` selects the source automatically (matched against the current
   machine's hostname); include container hostnames if you also start DSH
   inside a container on this server.
4. Re-run `scripts/prepare-workspace.mjs` in the target worktree.

Alternative (propose-not-persist): start a DSH session on the new server and
ask the agent to detect the environment and draft this file from the template;
**you** review, correct, and commit it. An agent never writes these facts
silently.

## Minimal required set

| Field | Why the human must provide it |
|---|---|
| CANN setup command + validation | toolchain ownership: user selects, agent only validates |
| CMake / Ninja / ccache paths | machine-specific install locations |
| Python / conda environment + activation | user-owned environment choice |
| Expected accelerator device type (or NONE) | decides device-test eligibility |
| E2E toolkit base directories (or NONE) | external, evolving, host-specific |

Everything else has safe defaults (`NONE`, generic policy text).

---

# Local Host Environment (<profile>) — COPY FROM HERE

> Host-local overlay source for host `<host-id>`, owned by
> compiler-dev-harness. Materialized into target repositories as
> `AGENTS.local.md` by `scripts/prepare-workspace.mjs`; edit this source, never
> the materialized copy, and re-run preparation after editing.

This file defines machine-specific configuration for the current server.

It supplements the target repository's team-owned `AGENTS.md`; repository-wide
build/test semantics stay there, only host-specific facts belong here.

---

# 1. Environment Ownership

CANN, LLVM, Python/Conda, and other machine-specific toolchains are selected and prepared by the user.

The agent may validate the resulting environment but must not independently discover, install, replace, or switch toolchains unless explicitly requested.

---

# 2. CANN

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

---

# 3. Toolchain Paths and Standard Repair (this host)

- CMake:  REQUIRED: (absolute path + check command, e.g. `cmake --version`)
- Ninja:  REQUIRED: (absolute path + check command; note stale-symlink risks after container resets if relevant)
- ccache: REQUIRED: (absolute path + check command, or NONE)

After a container/host reset, validate all three BEFORE configuring; if a build fails with "file not found" from CMake-generated files, repair the toolchain path first, then delete the affected generated files rather than editing them in place, then rebuild incrementally.

Removing the ccache launcher invalidates object caching and forces a near-full rebuild; treat that cost as a decision, not an accident.

---

# 4. Python / Conda

Preferred Python environment:

REQUIRED: (environment name and activation command, e.g. `conda activate <env>` inside docker `<container>`, or `/usr/bin/python3` on the host)

The agent may automatically report `python3 --version` and `which python3` after activation.

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

- If `npu-smi` and the expected device/runtime are available, device tests may be run according to the team `AGENTS.md`.
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

E2E tests typically require the target repository's compiler driver and the companion production compiler; both evolve independently of the repository.

Base directories on this host:

```text
REQUIRED: (per-toolkit base directories, or NONE when unavailable)
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

If a new workaround is needed, report it to the user and suggest adding it here (to this harness source, not to a materialized copy).

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
