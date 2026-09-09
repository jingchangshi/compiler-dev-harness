# Local Host Environment (AscendNPU-IR)

> Profile-specific host-facts delta, owned by compiler-dev-harness
> (`contracts/AscendNPU-IR-Dev/hosts/user12364/AGENTS.local.md`). It is
> composed with the shared machine layer
> (`contracts/hosts/user12364/AGENTS.local.md`) and the repository profile by
> `scripts/prepare-workspace.mjs` into the target's `AGENTS.local.md`; edit
> this source, never the materialized copy, and re-run preparation after
> editing.
>
> Machine-level facts (CANN setup, CMake/Ninja/ccache paths, accelerator,
> E2E toolkit inventory, workaround policy) live in the shared machine layer;
> only facts scoped to the AscendNPU-IR workflow on this server belong here.

---

# 1. Python / Conda

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

# 2. ccache Rebuild Cost (canonical build)

Removing the ccache launcher invalidates object caching and forces a
near-full rebuild of the AscendNPU-IR build tree (~4600 targets); treat that
cost as a decision, not an accident. (Toolchain paths and repair policy:
shared machine layer, `contracts/hosts/user12364/`.)

---

# 3. E2E Tests via bishengir-compile / bisheng

To run E2E tests, run the following cmds:

```text
[USER MAY PROVIDE]
```

E2E tests require the AscendNPU IR compiler `bishengir-compile` and the
BiSheng compiler `bisheng`. Both evolve as the AscendNPU IR repository
evolves; which version to use is a per-run decision.

Toolkit base directories on this server are recorded once in the shared
machine layer (`contracts/hosts/user12364/`, E2E compiler toolkit inventory);
this profile does not duplicate them.

---

# 4. Build Container Entry (this host)

Before any compilation, CMake reconfiguration, native build, wheel build, or
build-dependent test, first enter the build container:

```bash
docker exec -it \
  -u shijingchang \
  -e HOME=/home/shijingchang \
  -w /home/shijingchang \
  s00653124_build \
  /bin/bash
```

Then, at the repository root inside the container, set up the environment:

```bash
cd $HOME/workspace/AscendNPU-IR-Dev
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH=/usr/local/bin:/opt/cmake/bin:$PATH
source /opt/miniconda3/etc/profile.d/conda.sh
conda activate triton-py311
```

Validate CANN is configured before build-dependent work (CANN setup itself:
shared machine layer, `contracts/hosts/user12364/`):

```bash
: "${ASCEND_HOME_PATH:?CANN environment is not configured. Prepare the host environment first.}"
```

---

# 5. Canonical / Incremental Build (this host)

Canonical full compiler build from the repository root (inside the container
entered per the build-container entry above), unless the user explicitly
supplies another command for the current task. Do not derive or substitute
another full build procedure by inspecting CMake or CI.

```bash
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
```

Notes:

- `--build-type Debug` may be required to debug cases.
- `--enable-assertion` is required for `bishengir-compile -debug` (Pass log
  dumps), at the cost of a longer `bishengir-compile` build time.
- `--build-triton` depends on the `bishengir/triton` directory.
- `--build-shmem-template` depends on the `third-party/shmem` submodule.
- The `--bisheng-compiler` toolkit path follows the shared toolkit inventory
  (`contracts/hosts/user12364/`); `$HOME/workspace/ccec-toolkits/default/...`
  is this server's default, not a fixed requirement.

Standard incremental build for native compiler changes:

```bash
ninja -C build -j 64 bishengir-opt bishengir-compile
```

`ninja` does not read `MAX_JOBS` and defaults to `nproc` jobs; under memory
pressure append `-j 64` to match the canonical build's parallelism. Do not
spend substantial time reverse-engineering smaller Ninja targets unless the
task explicitly requires one or a smaller target is already documented.
