# Local Host Environment (Triton-distributed-ascend)

> Profile-specific host-facts delta, owned by compiler-dev-harness
> (`contracts/TritonDistributed-Ascend-Dev/hosts/tbe/AGENTS.local.md`). It is
> composed with the shared machine layer
> (`contracts/hosts/tbe/AGENTS.local.md`), the carried repository contract,
> and the repository profile by `scripts/prepare-workspace.mjs` into the
> target's `AGENTS.local.md`; edit this source, never the materialized copy,
> and re-run preparation after editing.
>
> Machine-level facts (CANN setup, machine capacity, accelerator, E2E
> toolkit inventory, workaround policy) live in the shared machine layer;
> only facts scoped to the Triton-distributed-ascend workflow on this server
> belong here.

---

# 1. LLVM

## Required user configuration

LLVM build to use:

```text
/home/s00653124/workspace/llvm4tritonascend
```

Setup command:

```bash
export LLVM_SYSPATH="/home/s00653124/workspace/llvm4tritonascend"
```

Expected validation:

```bash
test -n "$LLVM_SYSPATH"
test -d "$LLVM_SYSPATH"
```

Optional expected LLVM revision/version:

```text
$LLVM_SYSPATH/include/llvm/Support/VCSRevision.h records LLVM_REVISION "f6ded0be897e2878612dd903f7e8bb85448269e5"
```

The agent may inspect the configured LLVM version after setup but must not search for or select an alternative LLVM installation.

---

# 2. Python / Conda

Preferred Python environment:

```text
python3 under conda's s00653124_mk
```

Activation command:

```bash
conda activate s00653124_mk
```

The agent may automatically report:

```text
python3 --version
which python3
```

after activation.

---

# 3. Build Parallelism (MAX_JOBS)

`python/setup.py` default build parallelism on this host: `2 x cpu_count = 512 jobs` (machine capacity: shared machine layer, `contracts/hosts/tbe/`).

Observed evidence (2026-09-03, fresh wheel build):

```text
Uncapped:    many clang++ units SIGKILLed (exit 137), swap 100% used, build failed.
MAX_JOBS=32: clean build, 0 failures, ~326 GiB RAM still available.
```

Policy:

```text
Canonical wheel build:   MAX_JOBS=32 (mandatory; repository contract section 4)
Incremental ninja build: append -j 32 under memory pressure (ninja ignores MAX_JOBS)
```

---

# 4. E2E Run Mechanics on This Host

Canonical E2E commands are defined by the repository contract (section 9.3);
this section records only the host-specific mechanics of `run_triton.sh`.

E2E tests require the AscendNPU IR compiler `bishengir-compile` and the
BiSheng compiler `bisheng`. Both versions evolve as triton-ascend-distributed
evolves; which version to use is a per-run decision, resolved from the
shared toolkit inventory (`contracts/hosts/tbe/`, E2E compiler toolkit
inventory).

`run_triton.sh` sets up the `PATH` of `bishengir-compile` and `bisheng` for
the run, and pre-sets `TRITON_DEBUG`, `TRITON_CACHE_DIR`, `TRITON_DUMP_DIR`,
`ENABLE_PRINT_UB_BITS`, `TRITON_PRINT_AUTOTUNING` to help debug E2E tests.

`run_triton.sh`'s built-in `${HOME}/bishengir-toolkits/A5/...` and
`${HOME}/ccec-toolkits/...` PATH entries are stale on this host; pre-set
`PATH` with the real toolkit `bin` dirs before invoking it:

```bash
export PATH="/home/s00653124/workspace/bishengir-toolkits/<AscendNPU IR version>/bin:/home/s00653124/workspace/ccec-toolkits/20260814_CI/ccec_compiler/bin:$PATH"
```

---

# 5. Approved Local Workarounds (profile)

Only list stable, intentionally approved workarounds for this repository's
workflow on this host (machine-level workarounds: shared machine layer).

1. Build parallelism cap: `MAX_JOBS=32` for wheel builds, `-j 32` for
   incremental ninja builds (user-requested 2026-09-03; evidence in the
   build-parallelism section above).
2. E2E toolkit `PATH` pre-set before `run_triton.sh`, because its built-in
   toolkit paths are stale on this host (see the E2E run-mechanics section;
   temporary until `run_triton.sh` resolves toolkit locations itself).

An agent-discovered workaround is not automatically approved.

If a new workaround is needed, report it to the user and suggest adding it here (to this harness source, not to a materialized copy).
