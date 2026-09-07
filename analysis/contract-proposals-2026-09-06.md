# 契约更新提案（2026-09-06，来自 9 个生产 case 的反馈分析）

> 依据：`analysis/2026-09-06-case-feedback-analysis.md` Part 5 的 M5/M6 项。
> 契约是人类拥有的操作知识；以下为**提案文本**，由你审阅、修改后自行粘贴进
> 对应仓库的 `AGENTS.md` / `AGENTS.local.md`。agent 不会自行写入这些文件。

## 提案 1 — AscendNPU-IR / AscendNPU-IR-Dev：编译日志取证（M5-①）

依据 case：C4（142 条 grep 类命令）、C5（293 条、46MB–2.8M 行日志二分）、C9（64 条）。

建议加入 `AGENTS.md`（新增一节，或并入 Verification 矩阵）：

```markdown
# N. Compile Pipeline Log Forensics

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
```

（若使用 v1.2 `compiler_inspect`，`log_files`/`log_passes` 已内建上述能力；
此节同时约束不使用该工具时的手工纪律。）

## 提案 2 — AscendNPU-IR-Dev：本服务器 toolchain 路径与腐坏修复（M5-②）

依据 case：C4 T4 S65–S95（cmake/ninja/ccache 死链，30 步环境抢修 + 全量重编）。

建议加入 `AGENTS.local.md`（机器专属事实）：

```markdown
# Toolchain Paths and Standard Repair (this host)

- CMake:   /opt/cmake/bin/cmake   (check: cmake --version)
- Ninja:   /usr/local/bin/ninja   (check: ninja --version; a stale symlink may
           point into another user's home after container resets)
- ccache:  /usr/bin/ccache        (check: ccache --version)
- After a container/host reset, validate all three BEFORE configuring;
  if a build fails with "file not found" from CMake-generated files, repair
  the toolchain path first, then delete the affected generated files rather
  than editing them in place, then rebuild incrementally.
- Removing the ccache launcher invalidates object caching and forces a
  near-full rebuild (~4600 targets); treat that cost as a decision, not an
  accident.
```

## 提案 3 — Triton-distributed-ascend：按-HEAD 跑 E2E 的批准程序（M5-③）

依据 case：C6（树内陈旧 untracked `libtriton.so`，8–9 步取证）；
该条目 agent 已在 `REBASE_REVIEW.md` §7 自提，此处为其定稿提案。

建议加入 `AGENTS.local.md`（替换/充实 `Approved Local Workarounds` 的相关部分）：

```markdown
# Running E2E against a given checkout HEAD

The wheel in site-packages may lag or diverge from the checkout (hotfixes).
To verify checkout-authoritative behavior:

1. Build first: incremental build per AGENTS.md §5, then confirm
   `python/triton/_C/*.so` mtimes are newer than the sources you intend to
   test (`ls -la python/triton/_C/`); stale untracked artifacts must be
   refreshed before any E2E run.
2. Run with the checkout imported first:
   `PYTHONPATH=<repo>/python python3 <test>`, accepting that this tree-local
   path is approved for verification runs (supersedes the blanket
   "PYTHONPATH: NONE" wording above).
3. State in the report which artifact (wheel vs checkout) the result
   attests to.
```

## 提案 4 — AscendNPU-IR：hivmc/ A5 镜像树约定（M6）

依据 case：C4 结尾自行披露「`bishengir/hivmc/` A5 镜像树的 MarkMultiBuffer/Passes.td
未同步改动」。

建议加入 `AGENTS.md`（Do Not Rediscover 或 Repository Scope 一节）：

```text
- bishengir/hivmc/ mirrors bishengir/lib|include for the A5 image tree.
  Any change under bishengir/lib or bishengir/include must state whether the
  hivmc mirror needs the same change; if it does, apply or explicitly report
  the deferred mirror edit.
```

## 提案 5（可选，非契约）— preset 侧已生效、无需你操作的部分

以下已在本次实现中落地，列出仅供核对：`compiler_inspect` v1.2
（schema 边界 + 钳制、C/C++ 定义形、vendored 放宽、`log_files` 日志取证）、
核心策略第 5/7/8/9 条修订、skill 锚点与 checkpoint 节更新、
`analysis/feedback/*.json` 五条知识层反馈工件（已过
`mlir_repomap.feedback.validate_feedback` 校验）。
