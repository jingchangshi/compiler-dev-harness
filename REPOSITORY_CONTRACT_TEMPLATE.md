# Repository Contract

Human-authored operational knowledge for this repository. Keep commands and constraints current. `compiler-dev` treats completed fields as authoritative and validates them only when used.

## Repository identity

- Repository / primary branches:
- Primary compiler subsystems:

## Environment initialization

- Required shell initialization:
- Required Python / conda environment:
- Required toolchain or device setup:

## Build

### Canonical build

```sh
# Human-provided command
```

### Incremental build

```sh
# Human-provided command
```

## Verification

### Fast/default verification

```sh
# Human-provided command
```

### Python tests

### MLIR / lit / FileCheck tests

### C++ tests

### Host-only tests

### Accelerator-required tests

## Formatting / linting

## Repository boundaries

- Directories that must not be modified or broadly explored:
- Generated or vendored directories:

### Source-context exclusions

Directories the generic source-context retrieval must exclude. List them here once and pass the SAME list as `compiler_inspect` `exclude_dirs` in every call of a session — the backend uses them verbatim (the Ripwire provider maps each entry to a crawl prune; the legacy rg path appends them to its default exclusions).

- Build/output trees:
- Vendored / submodule trees:
- Generated trees:
- Any other directory generic retrieval must exclude:

Notes:
- Spell names exactly as they appear in the repository, including hyphenation: a vendored `third-party/` (hyphen) is NOT covered by built-in defaults that know `third_party` (underscore), and it can be large enough to make un-excluded retrieval impractically slow or expensive.
- An anchor inside an excluded tree is reported as outside the retrieval corpus ("not retrieved"), never as evidence that the code does not exist; read such files directly when needed.
- Do not list build/cache noise that the tools already exclude by default (`.git`, `build`, `out`, `dist`, `target`, `node_modules`, `.cache`, `__pycache__`, …) unless this repository uses an unusual spelling for it.

## Submodules

- Required initialization and modification policy:

## Known environment constraints

## Known supported workarounds

## Do-not-rediscover rules

- Facts the agent must reuse rather than derive from build files, CI, or scripts:
