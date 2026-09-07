# AscendNPU-IR Repository Profile (harness-owned)

This file belongs to **compiler-dev-harness**, not to the AscendNPU-IR team
repository. It holds personal harness policy scoped to one target repository:
how harness tools observe this repository, and repository conventions the team
does not track. The team's tracked `AGENTS.md` inside the target repository is
the upstream operational truth for build, test, environment, and process rules;
this profile never materializes as `AGENTS.md` and never modifies it.

Effective repository operating context = the team's `AGENTS.md` (loaded as the
base project instructions) + the materialized `AGENTS.local.md` overlay
(rendered after the base files, additively, per the DeepSeek Harness
agent-instructions loader). More-specific overlay guidance refines the team
contract; the overlay never claims team-owned operational authority.

## 1. Source-context boundaries (compiler_inspect / Ripwire)

Generic repository-context tools must exclude large vendored, generated, and
build trees from the primary source corpus. Pass these contract parameters on
every `compiler_inspect` call in this repository, and reuse them consistently
within a session rather than rediscovering repository boundaries:

```text
exclude_dirs:
- third-party
- build
- build-*
- out

contract_test_dirs:
- bishengir/test
```

The primary compiler source corpus is the project-owned source tree
(`bishengir/`). Vendored/submodule code (`third-party/`) is inspected only when
the task explicitly requires it. Note the spelling: this repository uses
`third-party` (hyphen); built-in defaults that know `third_party` (underscore)
do not cover it.

## 2. hivmc/ A5 mirror tree

- `bishengir/hivmc/` mirrors `bishengir/lib` and `bishengir/include` for the A5 image tree.
- Any change under `bishengir/lib` or `bishengir/include` must state whether the hivmc mirror needs the same change; if it does, apply it or explicitly report the deferred mirror edit.

## 3. Compile pipeline log forensics

Issue workspaces (`~/workspace/issues/<case>/`) hold `bishengir-compile`
pipeline logs (`--mlir-print-ir-after-all`) and their `.bcmlir` inputs.

- A pipeline log is organized by dump markers:
  `// -----// IR Dump After <PassName> (<pass-flag>) //-----`.
- Prefer `compiler_inspect` with `log_files` + `log_passes` for pass-indexed
  navigation, occurrence-addressed dump slices, and two-log pass-sequence
  diffs. Do not stream raw log sections into context; extract bounded line
  ranges (`grep -n` the marker, then `sed -n` a window, or awk NR ranges).
- When two logs must be compared (e.g. one flag toggled), diff the pass
  sequence first; the first divergence and per-pass count deltas usually
  localize the behavioral difference before any IR reading.

## 4. Repository-specific knowledge pointers

- Detailed repository architecture knowledge is maintained under
  `.dsh/skills/ascendnpu-ir-expert` in the target repository. Use
  repository-specific Skills only when relevant; do not duplicate
  environment/build instructions from the team `AGENTS.md` into them.
