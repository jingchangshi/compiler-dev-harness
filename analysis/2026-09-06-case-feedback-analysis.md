# CompilerDev Case Feedback Analysis Report（案例反馈分析）

> 数据基线：9 个真实生产会话（2026-09-05/06 导出，全部经 `compiler-dev` preset，模型路由
> `huawei-api-bundle/GLM-5.3-Flash`，contextWindow 1,000,000）。分析材料：`cases/*.zip`
> （会话日志全量解析）、preset 源文件逐行核对、`mlir-compiler-harness` 侧
> `adapters/compiler-dev` 消费契约（Phase 20，2026-09-06 完成）。
> 本文只做分析与建议，不修改任何代码。数字可由 Appendix A 的方法重放。

---

## Part 1 — Current architecture summary（当前架构摘要）

CompilerDev Harness 是一个 **agent-plane preset**（`agent.cordis.yml`，307 行），在标准编码
agent 之上为 MLIR/LLVM/Triton 类编译器仓库工程增加四层机制。以下已对照源码逐条核实：

### 1.1 组成挂载（三种归属模式）

| 层 | 内容 | 归属逻辑 |
|---|---|---|
| identity | `persona`、`agent-instructions`（64KB 上限） | preset 覆盖默认人设 |
| 基础工具 | `tool-bash`/`tool-pwsh`（平台二选一）、`tool-fs`、`tool-fs-search`、`tool-jobs`、`tool-skill`、`tool-goal`、`tool-ask-user`、`tool-todo`、`tool-web`（fetch 关闭） | 只注册 model-facing 工具；服务与注册表留 host |
| plan mode | `planning` group（isolate `planMode`） | 计划状态天然 per-agent |
| compaction | `compaction-basic`（6 条 1M 路由 `thresholdRatio: 0.2` ≈200K 触发，retain 65536）+ `command-compact` + `tool-result-pruner`（8192/4096/1024） | 同一 isolate realm；`tokenMeter` 留 host |
| delegation | `tool-subagent`/`fork`/`list-agents`、`tool-workflow`、`tool-ralph`；codex/claude 行 disabled | isolate `workflowEngine` |
| compiler | `compiler-inspect` → `compiler-inspect-v3-1.cjs`（driver 经 `?v=1.1` in-process import） | 无 realm：只注册提示段 + 工具 |
| skills | `skill-filesystem`（`customSkillDirs` → `PRESET/skills/`）+ `tool-skill` | preset 本地 skill 目录随安装位置解析 |

### 1.2 Always-on 核心策略（system prompt 段，order 114）

十条不变量：①契约权威；②不重发现文档化流程；③只建任务相关架构模型；④「最近 N commit」是
历史搜索地平线；⑤**锚点任务第一步调 `compiler_inspect`**（skip：单文件可答 / 纯契约命令执行 /
用户明确不用；不适用于构建环境类工作）；⑥语义最小补丁；⑦有界验证（失败四分类 + 一次对照实验
止损）；⑧大输出重定向；⑨checkpoint（`Decision; Evidence; Uncertainty; Patch implication`，
三个时机：设计敏感编辑前 / 大型发现后 / 长验证前）；⑩Creator-mode 域边界。
设计依据：模型不总先加载 skill，最小不变量集必须每步在场。

### 1.3 `compiler_inspect` v1.1（检索契约）

单次调用、一次往返、硬预算 20000 字符（超限按 References→History→Tests→Definitions 优先级对半裁剪）：
git 状态、锚点（文件存在性校验 + 符号≤12）、定义检索（关键字声明形 + `name\s*[:=]` 两遍正则，
每条≤280 字符、2 行上下文、≤10 条，锚点文件内 match 行优先）、引用检索（≤12 条）、vendored 回退
（**仅当**非 vendored 树零匹配时，≤4 条）、测试匹配（`contract_test_dirs` 优先，否则默认 glob）、
工作树 `diff --stat`、path/symbol-scoped git log + pickaxe（窗口默认 6；**插件侧校验 1–30，
越界直接抛错**；JSON Schema 只标 `type: integer`，无 min/max）、unresolved 诊断。
**边界**：只取确定性代码事实；不理解 MLIR 实体语义（dialect/pass/pipeline 不是一等实体）；
默认不搜 vendored 树；不覆盖仓库外的任务工件（编译日志等）。

### 1.4 Repository Contract（人在回路，目标仓库侧）

三个目标仓库均已建成成熟契约（`AGENTS.md` + `AGENTS.local.md`）：docker/环境初始化、规范与增量
构建、验证矩阵（lit/pytest/E2E + 设备要求）、失败四分类政策、仓库边界（`3rdparty` vendored）、
已批准 workaround（含证据）、do-not-rediscover 清单、契约更新提案格式（agent 不静默持久化）。
契约经两个参数通道进入检索：`contract_test_dirs`、`exclude_dirs`。

### 1.5 preset 本地 skill 与观测

`compiler-development` skill（37 行，约 4KB）承载判断细节（锚点工作法、契约权威次序、checkpoint
语义、验证分类、混合/域外工作），不重复不变量。`scripts/analyze-session.mjs` 提供离线观测
（本报告的量化基线即由其扩展）。

### 1.6 对接面现状（mlir-compiler-harness 侧）

`adapters/compiler-dev/`（Phase 20，**已落地**）定义：四个可依赖查询（`review`、`finding-impact`、
`pipeline-stages`、`evidence`）、按任务类型的只读查询序列（workflow-contract.md：pass review /
Python pipeline audit / finding 复核）、以及**反馈工件 JSON schema**（feedback-schema.md，
`possible_gap.category ∈ {query-coverage, evidence-location, workflow, documentation, other}`，
由 `mlir_repomap.feedback.validate_feedback` 校验）。本报告 Category D 输出按该 schema 落点
（Appendix B）。**本批 9 个 case 中 repomap 查询调用数为 0**——preset 侧尚无任何入口指向它们。

---

## Part 2 — Case analysis（逐案例分析）

> 编号 C1–C9；引用格式 T<turn> S<step>；完整逐 case 报告见
> `/tmp/case-analysis/reports/`（C3/C4/C5/C6 为并行分析代理产出，其余为主分析直读）。

### Case C1 — d6dd5584：单函数行为修正（dump 去重）

- **Task**：`model_builder.py` 的 `_dump_dsl_src` 同时写 cwd 与 triton cache dir，要求只写 cache dir。
- **Workflow**：git status → grep 锚点 → read 目标区段 → edit → py_compile + 全 `python/` 引用复查 → git diff 自检。6 步完成，峰值 17K tokens。
- **Reasoning**：明确援引策略第 5 条 skip 条款（「one already-known file answers the task」），正确跳过 `compiler_inspect`。
- **成功**：最小补丁、窄验证（py_compile + 调用方 grep）、零人工干预、零错误调用。
- **Category**：无摩擦。证明 preset 对「已知单文件小修」零额外开销。

### Case C2 — 00d12d87：为最新 commit 生成中文 PR 描述

- **Task**：给 `dev-noflatteni1` 最新 commit（HFusion Flatten i1 修复，8 文件 +217/−9）写中文 PR 描述供检视。
- **Workflow**：加载 `ascendnpu-ir-expert`（**49.3KB**）→ `compiler_inspect`（**无锚点**，仅 history 节 746 字符）→ `git show` 全量 diff（21.2KB 进上下文）→ grep/sed 定位 pipeline 调用点 → 发现本地 `bishengir-opt` 晚于 commit 构建 → 实跑两个新 lit 测试（PASS）→ ninja 重建遇 `verify_globs` exit 127 → 一次对照实验归类 ENVIRONMENT/pre-existing → 写 `PR_778afd576_zh.md` + 内联五节摘要（含「检视要点」：`contains("_fused")` 子串误判风险等）。
- **成功**：验证真实（实跑 lit）；失败四分类落地；产出质量高。
- **摩擦**：①无锚点 CI 调用近乎空转（策略第 5 条对 commit 描述类任务无 skip 依据）；②21KB `git show` 直接进上下文（第 8 条精神：应先 `--stat` 再取切片）；③skill 首步整读 49KB，仅一处（P18 pattern）被引用。
- **Category**：B（第 5 条任务适用性）+ C（skill 整读机制）。

### Case C3 — 414861e7：FlattenOps i1 守卫 + VecFuncSuffix 重构（两轮）

- **Task**：T1——`calledByUnsupportedKernel`（cumprod 检测）改为「VF 中有操作 i1 的 Op 即退出 Pass」+ MLIR 看护用例 + 自验；T2——消除 `_fused_` 魔法字符串，`util::VecFuncSuffix` 两边共用。**人类在两回合之间并行写入了 agent 不知情的 WIP**（FlattenStage 枚举/选项/接线/新测试）。
- **Workflow**：双 skill（T1 S1）→ CI@T1 S2（**contract_test_dirs=['bishengir/test'] 正确传入**）→ 侦察 → **checkpoint@T1 S15/S16（edit 前）**→ edit ×2 → docker 增量构建（发现 `set_docker_env.sh` 不设 `ASCEND_HOME_PATH`，按 AGENTS.local.md 补 source）→ 候选 IR 探测发现守卫未触发（测试名不满足未成文的 `_fused_` 启发式）→ 插桩→重建→修正→去插桩闭环 → 正式 lit + 定向 13 例 + 全量 `check-bishengir`（989 例 0 fail）+ `check-mlir`（2295 例 0 fail）。T2：CI@S1（**未传契约参数**，Tests/Changes 返回 none）→ 通读用户 WIP → **checkpoint@S5** → 三文件 edit → 1 例失败 = 用户 WIP → **一次控制实验**证明 pre-existing → **ask_user_question（S30，三选项）**→ 用户选「只实现 flattenStage」（**否决了模型的 Recommended「实现两者」**）→ 实现 + 修正 WIP 测试期望 → 双套件全绿。
- **成功**：CI 双回合均为本回合首个仓库检视动作；checkpoint 在正确时机出现两次；ask_user 前有控制实验背书；主动保护用户并行 WIP；顺手识别 latent bug（producer `+"_fused"` vs consumer `contains("_fused_")` 本就不一致）与第三处魔串（AutoVectorizeV2.cpp:1322）但克制不越权修改。
- **摩擦**：①守卫首次未触发（5 步 + 2 次重建，测试命名未应用已获得的领域事实）；②T1 S52 产生 **49,999B** bash 结果（`grep -m2 … build/build.ninja | head -2`——head 限行不限字节，单条 phony 行 ~28KB），模型 S53 自我标记违例，pruner 兜底；③4 次 edit 读态错误；④CANN 环境引导分散（2 步试探 + 1 次无效后台构建）；⑤FileCheck 正则两连错（3 步）。
- **Category**：A（测试命名未对齐启发式）+ B（CANN 引导契约缺口）+ C（edit 读态摩擦）。
- **D 信号**：VF 身份判定是 pass 内部启发式（private + `_fused_` 子串）而非文档化契约——`documentation` 类 feedback。

### Case C4 — 6adf0663：multi-buffer 性能根因 → MarkMultiBuffer 判据增强（四轮）

- **Task**：T1——对比 `--enable-auto-multi-buffer` 开/关两份 ~10MB pipeline 日志（multibuffer=1 慢 25%），定位根因并提修复方案；T2 被用户 2 秒内 abort（误发半截消息，0 步）；T3——人类再定向「在你的方案之外，考虑增强 MarkMultiBuffer 对 autoblockify.subloop 的 scf.for 中只访存一次 GM 的 UB buffer 放弃标记」；T4——按方案实现，`skipOncePerSubloopGMAccess` 默认 True（推翻模型的 opt-in 设计，用户拥有默认值决策权）。
- **Workflow**：双 skill（T1 S1）→ T1 纯日志 diff（**零编辑**）→ **checkpoint@T1 S22 → CI（首次 repo 检查，规则 5 合规；brief 的「edit 先于 CI」是按轮编号拼接假象，T1 零编辑，首次 edit 在全局第 96 步 = T4 S21）** → 源码机制链（PlanMemory/PointerLikeInfo/旋转求解）→ smoking gun：编译器自警 `may stall pipe` → 根因报告。T3 九步完成设计评估。T4：五文件 edit → **compaction@S40** → LIT 测试 → clang-format 事故与修复（20 步）→ 构建环境抢修（cmake/ninja/ccache 死链，30 步）→ 编译错误两轮 → LIT 调试 + func-arg 追踪修复 → **陈旧二进制弯路（只重链 bishengir-opt，e2e 仍走旧 bishengir-compile，~23 步误判「门控在真管线不生效」至 S158）** → 干净重建 + 最终 e2e → 全量 UT（2294+872 全绿）→ commit `d00398bd9` 推 fork。
- **成功**：根因量化（UB 1,377,024→1,836,032 bits；固定 `wait_flag[MTE3,MTE2]` 串行化）；三级验证齐全；clang-format 违例自我发现并 revert 重做（最终 diff 仅 6 行删除）；分析轮零编辑边界感好。
- **摩擦**：①CI 首调 `history_window=40` 越界报错（合法域 1–30；schema 未标）；②CI `files` 锚点两次未命中（unresolved 明示 not found，模型未修正，靠 symbols 补救）；③**两条 50,000B bash 结果**（build.ninja/CMakeFiles glob 洪泛），各 ~12.5K tokens 滞留 ~75 步，峰值 199,432 与之直接相关；④clang-format 过宽 + 4 次 edit 读态错误；⑤9 次 sleep 轮询 + 9 个后台 ninja 作业（job_output 仅显式 3 次）；⑥`bishengir/hivmc/` A5 镜像树未同步改动（结尾自行披露）——契约未覆盖该仓库特有约定。
- **Category**：A（陈旧产物验证纪律、格式化返工）+ B（镜像树契约缺口）+ C（schema、files 锚点、bash 洪泛护栏）。
- **D 信号**（强）：pipeline 日志逐 pass IR 对比取证全程手工（142 条 grep 类命令）——`query-coverage` 类 feedback。

### Case C5 — 77275327：sparse-attn GM→L1 分析 → L1 半块写入全链实现（六轮，最大 case）

- **Task**（递进链）：T1 解释 B 操作数 GM→AIV-UB→cbuf 绕行成因；T2 结合 `tmp_L1CacheAgg.md` 与 4 组 PR commits 分析本用例未按预期转换的原因；T3「8 行 bf16 vs 16 对齐」是硬件限制还是可 padding 规避；T4 拍板「L1 半块写入（配对页写另一半）」全链实现打通 E2E；T5 人类报告**「任务异常终止，恢复继续」**；T6 产出方案架构文档。
- **Workflow**：568 步 / 470 bash（**293 次 grep/awk 类检索**）/ 5 次 compaction / 峰值 199,833。46MB/56 万行日志、2.8M 行失败 E2E 日志全部经 /tmp 有界切片处理（规则 8 达标）。T1：日志考古 ~20 步 → CI@S22（**从未传 contract 参数**）→ 通读 `InsertLoadStoreForMixCV.cpp` → 报告 S42。T2：PR commit 映射 + **`bishengir-opt` 单 pass replay + 消融实验**，收敛到 `checkInsertSliceTileAlignment` 与三道编译器 gate。T3：`ND2NZ.h` 模板参数级取证 → **非硬件限制**结论。T4：发现 fixture 已含目标 IR 形态 → 改设计 → pass v1 → **80,107 字符单块 THINK**（全部 THINK 1.1M 字符/343 块）→ compaction。T5（407 步）：恢复重述 → pass 重写 + 4 处注册 → **19 次 ninja 构建 + 18 次 E2E（前 17 次 exit=1）**，每次失败做日志二分定位肇事 pass（同一报错位置在 8 个不同根因下复现，e2e9 无 dump 版是关键鉴别实验）→ 修复 master 既有标量跨核机制缺口（SplitMixKernel 13 edits、InsertLoadStoreForScalar 11、CubeTileAssembly 10）→ e2e18 exit=0 → 全量 UT 864 过。T6：72.7 万行取证 dump → 文档。
- **成功**：**人类全程零纠错、零重定向**（六轮均为任务深化）；恢复能力强（盘上工件 + compaction 摘要重述，重复行为仅 2 次文件重读、0 次重复命令）；终局纪律（E2E 过即跑全量 UT + git 变更清单核对）；compaction 摘要质量高（25–34KB、8 节结构、verbatim 活动请求）。
- **摩擦**：①**T5 全程零正式 checkpoint**（仅 4 处 THINK 内 Decision 片段——对用户不可见、不进 compaction 原料）；T6 开头 compaction 摘要的 "Next Step" 是**陈旧的**（写「重跑 E2E→UT→报告」，实际均已完成），需从盘上报告重新确认状态；②CI@T3 S1 `history_window=0` 报错重演；③docker 包装命令 `; echo` 掩盖 ninja exit=1（构建「假成功」再排查，1 步级）；④成本结构：T4–T5「实现+打通」438 步占 77%，其中近半为日志切片检索。
- **Category**：B（checkpoint 在最高 compaction 压力段缺位；THINK 体量无预算引导）+ C（pass-segment 日志索引/replay 工具缺位）+ D（master 既有机制缺口是被测代码库的真实能力缺口——工具只能压缩定位成本）。
- **D 信号**（强）：T2/T3 的全部关键判断（L1CacheAgg 未生效、fractal 对齐性质）都是 pass constraint + provenance 问题——`review <pass>`、`pass-constraints`、`pipeline-stages`、`evidence` 正为此建。

### Case C6 — 89307463：rebase feature/megakernel + 冲突裁决文档

- **Task**：先梳理 7 个 commits 并确认 pytest/mlir/test_mlp_layer.py 通过，然后 rebase 解决冲突；歧义自行分析判断但记录文档待人类检视。T2 为审计性质询（为何运行时用到源码目录 `python/triton/_C`）。
- **Workflow**：compiler-development skill（4KB）→ git 侦察（发现**用户前提需修正**：本地分支==merge-base，直接 rebase 是 no-op，冲突实来自 origin 新 8 commits；fast-forward 后再 rebase，未打断询问）→ 环境验证（NPU/conda/CANN）→ **CI@S11**（files=8, symbols=4, **契约参数齐全**；模型推理原文 "Now, per policy, call compiler_inspect for the understanding phase"——把 git 机制侦察与环境验证归入第 5 条 build/environment 豁免，锚点本身依赖先跑 `git log -7`）→ **三层基线先行**（pytest 15 → lit 2/2 → E2E）→ E2E 首跑失败（树内陈旧 untracked `libtriton.so` 早于子模块 `compile_mode` 绑定）→ 取证（mtime/字节比对 + `git ls-files` 确认 untracked）→ 一次控制实验（刷新后重跑通过）归类 environment → rebase：两处冲突均做双侧 caller 分析 + bitcode 清点后裁决 → post-rebase 三层复验 → `REBASE_REVIEW.md`（§4 歧义裁决、§7 四项待确认清单，**含 agent 自提的 AGENTS.local.md 候选条目**）。
- **成功**：先验证后改的基线工作流；**规则 8 全场最佳**（60 次 bash 最大结果仅 9,104 chars，`head -160` 主动限幅）；冲突裁决文档化 + 人类检视闭环；子模块脏状态全程保留；T2 审计问题如实回答并将澄清补进文档。
- **摩擦**：①E2E 首跑踩陈旧产物（8–9 步）——仓库没有「针对给定 HEAD 跑 E2E」的文档化程序，且 `PYTHONPATH NONE` 条款被宽松解释（「未列批准 ≠ 禁止」）；②CI@S11 偏晚属**规则文本解释缝隙**（实际浪费 1–2 步，非不合规）；③2 次 edit 读态错误；④git 2.25.1 无 `merge-tree --write-tree`（人工重叠文件分析完全替代）。
- **Category**：B（按-HEAD E2E 程序契约缺口；第 5 条对 rebase/history 场景的时序判据模糊）+ C（轻，git 代际）。
- **D 信号**：无（裁决依据全部来自仓内代码与双侧 diff）。

### Case C7 — 90b8f512：ciface u16 ABI 设计检视（纯分析，preset 意图兑现最完整）

- **Task**：检视 `Megakernel.cpp` 中 `_mlir_ciface_dtile_{ld_dev,st_dev,st_io}_u16` 返回/入参用 `int32_t` 的设计合理性。
- **Workflow**：compiler-development skill → CI@S2（**contract 通道全用**：`contract_test_dirs=['unittest']`, `exclude_dirs=['3rdparty']`）→ 引用与调用点齐备 → read 关键区段 → 需 vendored 后端证据时，因 CI vendored 回退条件不满足（非 vendored 已有匹配），改用裸 grep 进 `3rdparty`（一次 28KB、250/1220 matches）→ context-guard 两次注入「已反复检视」，模型顺应收敛 → 产出「合理 3 条 / 脆弱 4 条」评审（系统性调用签名错位靠 target-luck 兜底、`u16` 后缀与 ABI 脱钩、i8 归并 16 位存储越界隐患）。
- **成功**：contract 参数、证据链闭环、guard 顺应、有界产出。
- **摩擦**：①**CI 定义节为空**：definition 正则（关键字声明形 / `name\s*[:=]`）匹配不了 C 函数定义形 `type name(args) {`，定义行只落在 References 标签下（行号仍在，证据未丢但分类误导）；②vendored 回退触发条件过窄 → 28KB 裸 grep。
- **Category**：C（definition 模式缺口；vendored 条件）。
- **D 边界说明**：`_mlir_ciface_` 前缀与 MLIR 标准 C 接口约定的关系靠 2 次 web_search + vendored 源码拼装——属通用 MLIR 知识而非本仓库 pass 知识，不属 D 落点。

### Case C8 — c98f102f：ciface 接口重构设计 + 人类设计的端到端检视（两轮）

- **Task**：T1——`ld_io` 组 `__gm__` 指针改 `void*`，进而 `DTileMemRef1DDesc` 重命名为模板 `memref_t<T>`，四组 ciface 统一，需从 dtile Op language 层考虑编译全链条；T2——人类给出具体模板设计片段，要求检视「uint16 memref 先按 uint8 解读 offset 再强转」的端到端正确性。
- **Workflow**：skill（4KB）→ CI@S2（contract 通道全用，**本批 case 中的合规标杆**）→ **65 步纯发现**（edit 在 S67），构成：repo 侧类型链仅 ~5 步；**vendored bishengir 树 ABI 追踪 ~28 步**（`getOpLibraryCallName` 一处定义横跨 4 个文件追了 13 步）；bitcode 构建链核实 ~16 步；权威 MLIR ABI 文档获取 ~6 步**零收获**（本地无 LLVM 源树 ×2、web_search 两次仅返回 URL 列表、curl 被网络策略阻断）→ **checkpoint@S53/S54 + todo（设计敏感编辑前，格式正确）** → 三处 edit → 验证（llvm-dis 抽查 12 个符号签名与 GEP 缩放、lit 2/2）。T2（H2 质疑成立）：重新取证 cache dump → io 组改 pointee-typed + st 组值参改 `int16_t` → **在 builder 层加 `checkDtileLdStContract` 契约检查**关死根因 → 全量复验（py_compile、8 个 .bc 重编、GEP `inbounds i16` 确认、lit 2/2）→ 承认 v1 设计错误。
- **成功**：发现既有 `memref_t` 先例对齐约定（"zero ABI/toolchain risk"被编译证实）；验证用 llvm-dis 等价性论证而非只看 exit 0；对人类质疑零辩护、先取证再承认；修正下沉到 builder 契约检查（超最小修复但方向正确）。
- **失败点/摩擦**：
  1. **v1 设计错误（io 组 byte-typed）**：把 blade 遗留的 `ptr<u8>` 字节游标当成 io ABI 语义，与模型自己在 T1 总结中声明的「descriptor 元素类型 = pointee」契约相矛盾——**两条自相矛盾的陈述同存于 T1 final 而未被自查发现**。T2 修正代价 29 步 ≈ 全 session 24%，3 文件改动 + 第二轮全量复验，并推翻 T1「其余各层无需功能性修改」结论。
  2. vendored ABI 追踪 28 步串行 bash：CI 传了 `exclude_dirs=['3rdparty']` 且 vendored 回退仅在「vendored 外零匹配」时触发——vendored 半条链完全没有工具覆盖。
  3. 权威文档获取 5 步零收获（web_search 无正文、curl 阻断）——preset 组成有意关闭 `tool-web` 的 fetch（`fetch: false`），该选择在此 case 有真实代价。
  4. 20,083 chars 宽模式 grep（`_mlir_ciface_` 直查 vendored 树，250/1220 matches 有效信息稀薄）。
  5. 环境 preamble 重复 8 次 + conda 定位 6 步；2 次 edit 读态错误。
  6. **reasoning/SAY ≈ 40:1**（360,588 vs 8,905 chars）；T2 S1 单块 reasoning **106,560 chars ≈ 26K tokens**（一步吃掉峰值上下文 >13%）；峰值 199,421、0 compaction（距阈值 0.3%）——人类若有第三轮追问必然触发。
- **Category**：**D（io vs dev 地址契约的判断错误——repo 自身 ABI 语义，诚实归类）**+ B（checkpoint 未要求「契约声明 vs 实现逐条对账」自检）+ C（vendored 覆盖、离线文档、缓存 IR 证据位）。
- **D 信号**：io/dev 两组 dtile op 的地址契约（element 类型解释、offset 语义）没有文档化事实源，模型用「唯一可观测调用方形状」替代契约推导并出错——`documentation` 类 feedback；通用 MLIR ciface/memref 布局知识则属外部知识（离线 MLIR/LLVM ABI 参考包可消除 5 步文档空转）。

### Case C9 — d2846ac7：print1/print0 编译产物行为差异定位（纯分析，无 CI 无 skill）

- **Task**：两份 47MB/51.6 万行 pipeline 日志——print1（带设备打印）的 .o 正确、print0 的 .o 错误，差异集中在 `bufferization.materialize_in_destination` 写 GM 的 count 值；人类给出「打印改变设备时序」的猜测性假说并自我声明「只是举例」。要求定位根因。
- **Workflow**：**无 skill、无 CI、无 edit**（97 步：bash 95 + read 1）。五段：日志结构测绘（S2 整读 print0.bcmlir **50,329 chars**——行数少但 loc 行超长）→ 最终 LLVM dump 函数级对比（print1 的 fused_17 是 merged 后缀 6 参数版、print0 是 4 参数版）→ 编译器内部语义追踪（S34 起进入 AscendNPU-IR-Dev：`copy_ubuf_to_ubuf_2d_bool` 模板、`view_as`/`bitwidthOf<bool>==1`、i1 pintlv lowering；位级推演排除「布局换算错误」假说）→ 搬运器实现追查（确认走 `copy_ubuf_to_ubuf_2d_intrin_core` 的 **MTE DMA 异步路径且内部无 V↔MTE flag**；期间 1D 模板宏结构追查 ~16 步为弯路；S67/S88 两次正式 checkpoint per policy #9）→ 收敛：**print 不是赢了一场时序竞争，而是改变了 `hfusion-merge-vf` 的融合决策、从根上消掉了带竞争的拷贝**（`CopyOpToLibraryCallPattern` 只生成裸 libcall 不插同步；对比 GM↔UB 路径的成对 set_flag/wait_flag）→ compaction@S94 后 3 步收尾，完整根因报告（诚实保留「纯静态分析无法 100% 区分 DMA 竞争与布局语义偏差」的不确定性）。
- **成功**：把人类的时序猜测改写为编译器决策差异（并如实推翻猜测方向）；print0/print1 对照作为控制实验运用得当；47MB 日志全程有界切片；compaction 后 3 步收尾零损伤。
- **摩擦**：①**CI 全程 0 次**——前 33 步（日志域）在 CI 覆盖外属合理；但 **S34 起进入 owning repo 做 pass/ABI 语义调查，是策略第 5 条明列场景而被整体跳过**（规则触发条件没有「分析编译产物/日志时定位到 owning repo 仍先 CI」的措辞，模型也未在 S34 补触发）；约 25 步「先找定义再开窗口」中 15–20 步可被一次携带锚点的 CI 压缩（~50 步语义阅读/位级推演不可省，诚实估算总降幅 20–25%）；②S2 整读 50KB + 9 条 >8KB 结果（「行数少但行超长」文件先 `wc -L` 感知的自觉不稳定）；③CANN regbase intrinsic 语义（async-DMA 顺序保证）repo 内不可确证——S85–S88 探索后放弃，靠对照实验绕过。
- **Category**：B（规则 5 覆盖缺口为主）+ A（S34 未补触发；50KB 整读）+ C（无日志 differ；CI 无工件入口）+ **D（intrinsic 管线语义参考不可达——对照实验 + 保留不确定性是正确兜底姿势，非缺陷）**。
- **Missing capability**（直接可用）：**两份 pipeline 日志的 pass-pipeline differ**（pass 序列 diff、首个分歧 pass、按函数 IR 差异摘要）——S6–S12/S24–S25 的手工实现花 10 步且产出 25.8KB 输出；这是「两份编译日志找分歧」这一高频任务型的直接工具化。

---

## Part 3 — Cross-case patterns（跨 case 模式）

### P1 — 契约系统已兑现，是最大成功项（Category A 正面证据）

- 契约命令全程被遵守：docker exec（C3 23 次 / C5 19 次，含 `set_docker_env.sh`）、`source set_env.sh`、
  `ninja -C build` 增量、`llvm-lit` 定向、`run_triton.sh` E2E、MAX_JOBS/-j 并行约束。
- 契约参数通道：Triton 系 3 case 100% 传入（C6/C7/C8）；AscendNPU-IR-Dev 系部分传入（C3 T1 传、
  T2 未传；C5 三次全未传）。
- 失败四分类语言在 4 个大 case 中出现 100+ 次；一次控制实验止损在 C3（用户 WIP 归因）、C6（陈旧
  .so 归因）严格落地。
- **契约更新回路真实运转**：C6 agent 自提 AGENTS.local.md 候选条目；C3 顺手上报 latent bug 与
  第三处魔串但克制不越权修改。
- 已批准 workaround（run_triton.sh PATH 预置）被直接复用，未重新发现。

### P2 — `compiler_inspect`：预算纪律完美，供给内容与调用时机有真实缺口（B+C）

- 11 次调用：2 次参数越界报错（C4 `history_window=40`、C5 `=0`——**两个方向的越界都发生了**，
  schema 无 min/max 标注）；1 次无锚点弱调用（C2，仅换回 3 条 history）；1 次 files 锚点未命中
  未修正（C4）；1 次晚到属解释缝隙（C6，浪费 1–2 步）；2 次在 T2/T3 新回合未复用契约参数
  （C3 T2）/全未传（C5）。有效强调用 8 次，全部 2.5–6.4K 字符、**零截断、零 vendored 污染**；
  C7/C8 的 CI@S2 + 契约参数全传是合规标杆，C8 全 bundle 仅 2,543 chars 即完成锚定。
- **另一端是 C9 的 0 次调用**：任务从日志域进入 owning repo 的 pass/ABI 语义调查后仍未触发
  （规则 5 的触发措辞没有「分析编译产物时定位到 owning repo」的桥）——CI 的缺席不是单点失误，
  是规则文本与任务形态之间的覆盖洞。
- 相对 996 次 bash，CI 的贡献是「便宜的起点锚」而非「探索替代」。结构性弱项四个：
  definition 正则 miss C/C++ 函数定义形（C7 定义节为空）；vendored 回退条件过窄（C7/C8 被迫
  28KB/20KB 裸 grep，C8 的 vendored 半条链完全没有工具覆盖）；无任务工件（编译日志）入口
  （C4/C5/C9 的主战场）；CI 未携带任何 repo/契约默认值，每会话依赖模型记忆传参。

### P3 — checkpoint 纪律：格式与时机在低压力段成立，在最高 compaction 压力段恰好缺位（B）

- **修正一个容易做出的错误结论**：checkpoint 并非「零执行」。以「Checkpoint/Decision — … Evidence —
  … Uncertainty — … Patch implication」格式（em-dash 连接）统计：C3（T1 S15/S16 edit 前、T2 S5
  edit 前）、C4（T1 S22 转入源码调查前）、C5（T1 S41 per policy #9）、C8（T1 S53/S54 设计敏感
  编辑前）、C9（T1 S67/S88 per policy #9）共 5/9 个会话发出 8 次正式 checkpoint，**时机全部正确**。
- 真正的缺口在 C5 T5（407 步实现+调试马拉松，**5 次 compaction 所在的会话**）：零正式 checkpoint，
  仅有 4 处 THINK 内 Decision 片段——THINK 对用户不可见、也不进 compaction 摘要原料；第 5 次
  compaction 摘要的 "Next Step" 因此陈旧。同时推理体量本身在压垮 200K 早压缩阈值：C5 有
  **80,107 字符单块 THINK**（全 case THINK 总量 1.1M 字符/343 块），C8 有 **106,560 字符单块
  THINK ≈ 26K tokens**（一步吃掉峰值上下文 >13%；该 case reasoning/SAY 比 ≈40:1）——preset 对
  THINK 没有任何预算引导。
- 第二类缺口是**自检维度**：C8 的 v1 设计错误（io 组 byte-typed）与模型自己声明的 ABI 契约
  （descriptor 元素 = pointee）同存于 T1 final 两条陈述中，未被任何 checkpoint 环节对账发现，
  直到人类质疑才修正（代价 ≈ session 24%）。checkpoint 的四要素里没有「契约声明 vs 实现逐条
  对账」这一自检项。
- 结论：checkpoint 规则「存在且被低压力段遵守」，但它最被设计出来的场景（抗 compaction 遮蔽）
  恰好没有触发条件——模型不知道 compaction 何时到来，长循环中的「假设变更点」没有被要求重新
  取 checkpoint。这是规则触发条件与真实风险点的错配，不是模型不合规。

### P4 — 「pipeline 日志取证」是被三个 case 重复验证的最大工具空白（C/D 交界）

- C4（10MB×2 日志对比，142 条 grep 类命令）、C5（46MB/2.8M 行日志二分，293 条）、C9（双份
  47MB 日志 diff，64 条）都以 `~/workspace/issues/*` 下的编译 pipeline 日志为主战场。核心操作是：
  「IR Dump After <pass>」段定位、双日志 pass 级对齐、行区间 awk 切片——全部手工。其中 C9 还
  分离出一个更窄的高频任务型：**「两份编译日志找分歧」**（pass 序列 diff、首个分歧 pass、按函数
  IR 差异摘要）——S6–S12/S24–S25 的手工实现花 10 步且产出 25.8KB 输出。
- C5 的反事实估计：一个 pass-segment 日志索引/回放工具可省 **80–120 步**；C9 的反事实估计：
  一次携带锚点的 CI 可压缩其 25 步定义追踪中的 15–20 步（~50 步语义阅读/位级推演不可省）。
- 该域 CI 无入口（锚点在 repo 源码）；契约无「日志取证纪律」条目；导航它需要的 pass
  ownership/意图知识正是知识层核心资产。**机械部分（有界索引切片）可进 CompilerDev；语义导航
  （该看哪个 pass 的 dump）与 stop-at-pass/replay 能力应外流**（Appendix B）。

### P5 — 生成文件洪泛与陈旧产物：验证循环的两个机械性缺口（A+C）

- **洪泛**：C3 S52（build.ninja 49,999B，head 限行不限字节）、C4 S75/S76（build.ninja/CMakeFiles
  glob，两条 50KB 各滞留 ~75 步）、C9 S2（bcmlir 整读 50,329B——**行数少但行超长**的文件，
  592 行里 loc 行可超万字符）——「predictably huge」的判断对生成文件与超长行文件失效，bash
  工具侧无体量护栏（DSH 上游行为，preset 侧只能靠策略文本点名 + `wc -L` 式感知提示）。
- **陈旧产物**：C4 只重链 `bishengir-opt` 后 e2e 走旧 `bishengir-compile`（~23 步误判）；C6 树内
  陈旧 untracked `libtriton.so`（8–9 步）。两次的失败分类都跳过了「产物新鲜度」分支——策略第 7
  条的四分类清单里没有这个显式候选。

### P6 — 人机协作模式已成型且健康（A 正面证据）

- 人类以「设计指令 + 方案裁决 + 参数默认值 + 背景补充」介入（C4 T3/T4、C5 T2/T3/T4、C6 冲突
  裁决检视约定）；人类两次否决/修正模型设计方向，模型均无异议照办（决策权归属正确）。
- 模型以「对照实验 + ask_user_question 三选项」上报歧义（C3——用户否决了 Recommended 项，证明
  不问后果严重）；以「修正用户任务前提」（C6 no-op rebase）与「审计性质询如实回答」（C6 T2）
  处理信息不对称。纠偏是**双向**的：人类两次否决/修正模型设计（C4 T4 默认值、C8 T2 v1 设计
  证伪），模型也两次如实推翻人类假说（C9 的时序猜测被改写为编译器融合决策差异、C6 的 rebase
  前提被修正为 origin 新 8 commits）——双方都以证据而非权威定输赢。
- 9 case 中人类纠错仅 C5 T5 一次，且是会话崩溃恢复而非工程纠偏。
- **异常终止**：C5 T4/T5 之间一次（峰值 199,833 贴 compaction 线；伴随 5 次 llm/retry 记录均为
  瞬时 provider 重试成功）。恢复成本 = 一次人工确认，无状态丢失——但无 checkpoint 兜底是运气
  结构（见 P3）。

### P7 — 委托工具闲置；后台 job 是唯一被使用的并行机制

- subagent/workflow/ralph 全部 0 次；后台 bash job + job_output 在三个大 case 使用 42 次（长构建/
  E2E 必备）；sleep 轮询仍出现 9 次（C4）。当前任务形态（单一长链推理）下委托路径无收益，
  属正常闲置而非缺陷。

### P8 — edit 读态摩擦高频但低价（C，DSH 上游行为）

- 19 次 edit 错误（read-first ×11、file-changed ×4、old_string 不匹配 ×4），分布在 5 个 case；
  单次代价 1 步（重读重试），多发于长会话后段与 bash-sed 混用后。preset 侧无可修点，记录观察。

---

## Part 4 — Workflow effectiveness evaluation（当前有效性评估）

### 4.1 Repository understanding（是否减少 grep/rg/全仓搜索）

**部分成立，且要分域归因。** 契约（do-not-rediscover + 验证矩阵）消掉的是构建/环境发现类搜索
（C3/C5/C6 的 bash 里几乎没有环境探索；C4 的 30 步环境抢修恰是契约未覆盖该服务器 toolchain
腐坏所致的反例）。CI 提供起点锚，但相对 996 次 bash 是小项。真正的源码 grep 集中在两类 CI
覆盖不到的域：**pipeline 日志取证**（P4）与 **vendored 后端语义**（C7/C8）。
**结论：目标在契约域已兑现；在日志域与 vendored 域未兑现——这两个域的缺口应外流知识层或做
工具级补强，而非 preset 内部堆规则。**

### 4.2 Compiler analysis quality（pass 架构 / pipeline 顺序 / 约束 / 历史）

- **历史维度**：CI scoped history + pickaxe 被实际使用（C2/C3/C7）；「N commit 地平线」在 C6 的
  7 commits 梳理中体现；C5 T2 的跨分支 PR commit 映射是 CI 覆盖不到的变体。
- **pass/pipeline 结构维度**：全部靠模型 grep+read 拼装（P4）。产出质量高（C5 三份分析文档、
  C7 ABI 评审、C4 量化根因、C9 推翻人类假说的 DMA/融合决策定位）但**不可复制、不可审计**——
  每次重新付全款。C9 的反事实：CI 缺席使其 25 步定义追踪中 15–20 步纯手工。知识层四个查询
  （review/finding-impact/pipeline-stages/evidence）正针对该维度，本批 **0 次调用**（preset 无入口）。
- **约束维度**：C3 的 i1 传播、C4 的 stall 复用判据、C5 的三道编译器 gate、C8 的 io/dev 地址契约、
  C9 的 intrinsic 管线归属，全部靠模型从源码自行拼装；C3 还暴露了 VF 身份启发式无文档、C8 的
  v1 错误直接源于 io/dev 契约无事实源（documentation 类缺口）。

### 4.3 Implementation quality（修改范围控制 / regression 分析 / testing）

- **最小补丁**：全部实现类 case 的 diff 限定在任务文件 + 新测试 + 必要接线（C4 最终仅 6 行删除级
  门控；C5 修补 master 既有机制 24 处属任务要求的打通范围且逐一可归因）；C4 的 clang-format
  过宽被自我发现并 revert——错误控制闭环有效。
- **regression 分析**：四分类语言 + 一次对照实验止损严格执行（C3/C4/C5/C6）；C4 的陈旧二进制
  误判（23 步）与 C6 的陈旧 .so（8–9 步）是分类清单缺「产物新鲜度」分支的直接代价。
- **testing**：lit/pytest/E2E 全走契约命令；新用例按契约落盘；全量 UT 门禁（2295/2294/989/872/864
  例）在 E2E 过后执行（C5 的 skill 强制条款生效）。
- **结论：实现质量三项达标，且达标机制可追溯到契约与策略文本——这部分设计应保持不动；
  唯一结构性代价是「重建-再验证」纪律缺失（P5）。**

---

## Part 5 — Improvement priority（优先级）

> 原则：不为单个 case 改 prompt；不加规则使 preset 臃肿；compiler 知识逻辑外流
> mlir-compiler-harness（经 `adapters/compiler-dev` 契约）；Agent reasoning 不写入知识层。

### High（必须改：证据充分、改动小、收益确定）

| # | 改进 | 类别 | 修复的 case | 依据 |
|---|---|---|---|---|
| H1 | `compiler_inspect`：`history_window` 的 JSON Schema 加 `minimum: 1, maximum: 30`，工具描述写明范围（或插件侧 clamp 后照常执行并在 unresolved 提示） | C | C4、C5 | 两个方向的越界（40 / 0）各浪费 1 次调用 + 1 步重试；schema 层修复一劳永逸 |
| H2 | driver definition 检索补 C/C++ 函数定义形（`type name(`、`name(...) {`、`name(...) const`、`*name(`） | C | C7、C8 | 定义节两次为空/缩水，定义证据只落在 References 标签下 |
| H3 | 核心策略文本一处集中修订（三个子句，不增条数）：①第 5 条补 skip/降级——commit 描述/总结类任务可跳过；git 机制侦察与环境验证不算「仓库检视步」；任务工件（编译日志）分析优先于仓库检视时，CI 推迟到转入源码调查的时点，**且一旦定位到 owning repo，第一步仍是 compiler_inspect**（C4 模型实际已这样做，把惯例变成文本；C9 则因缺此桥全程 0 调用）；②第 7 条失败分类补第 5 类候选「stale artifact（产物新鲜度）」，并给一句判据（部分重建后先核对被测二进制 mtime/再验证）；③第 8 条点名 build.ninja/CMakeFiles/链接数据库类生成文件与「行数少但行超长」的 IR 文件为 predictably huge | B | C2、C4、C5、C6、C9 | 六处摩擦同源于三条措辞的判据缺口；总增字数 <150，不破坏十条结构 |

### Medium（验证后改：需一次真实会话或重放对照）

| # | 改进 | 类别 | 修复的 case | 验证方式 |
|---|---|---|---|---|
| M1 | checkpoint 触发条件与真实风险点对齐：skill 的 Checkpoint 节加两条——「实现/调试长循环中，每当工作假设变更（新增/推翻一个归因）时重新取一行 checkpoint；THINK 内的 Decision 片段不算 checkpoint（不可见、不进摘要）」；「设计定稿的 checkpoint 必须含『契约声明 vs 实现逐条对账』自检」（C8 的 io/dev 契约矛盾由此可拦）；同时给 THINK 体量一句引导（长推理落盘为 checkpoint/结构化笔记，不做 80K–100K 级单块输出） | B | C5、C8（潜在 C4） | 下一批含 compaction 的会话：正式 checkpoint 出现率、compaction 摘要 "Next Step" 时效性、设计类错误被自检拦截数 |
| M2 | 契约参数 checklist 化（skill 锚点工作法节加两行）：同会话再次调用 CI 必须复用首次的 `contract_test_dirs`/`exclude_dirs`；CI 的 unresolved 明示锚点未命中时，下一步先修正或删除该锚点 | B | C3、C4、C5 | 同会话多次 CI 调用的参数一致性；unresolved 锚点的处理延迟 |
| M3 | driver vendored 回退放宽：锚点文件位于 vendored 树内、或符号的定义形仅 vendored 命中时也触发（保持 ≤4 条与 20K 预算不变） | C | C7、C8 | 用 C7/C8 的锚点重放 driver，验证 28KB 裸 grep 不再必要 |
| M4 | 有界日志取证入口：`compiler_inspect` 增加可选 `log_files` 参数——只做确定性分段定位（匹配 `IR Dump After <pass>` 的行号索引 + 指定 pass 前后有界切片 + 双文件同 pass 对齐行号表 + **pass 序列 diff/首个分歧 pass**（C9 的 differ 需求）），不解析 IR 语义、遵守 20K 预算 | C | C4、C5、C9 | 先以脚本原型对 C5 的 46MB 日志与 C9 的双 47MB 日志重放，度量步数节省（反事实估计 80–120 步 / 15–20 步）；确认后再进插件 |
| M5 | 契约内容提案（经人类，两条）：①「编译日志取证」条目（日志目录、`IR Dump After` 分段约定、推荐切片模式）；②该服务器 toolchain 路径与腐坏标准修复法（C4 的 cmake/ninja/ccache 死链 30 步）；③（C6 agent 已自提的）按-HEAD 跑 E2E 的批准程序 | B（契约内容，人类拥有） | C4、C5、C6 | 日志类任务 grep 次数与 50KB 级单结果数量；环境抢修步数 |
| M6 | 镜像树约定进契约（C4 结尾自行披露的 `bishengir/hivmc/` A5 镜像树） | B | C4 | 下次触碰 lib/include 的改动是否同步评估镜像树 |

### Low（暂不处理，记录即可）

| # | 事项 | 类别 | 理由 |
|---|---|---|---|
| L1 | skill 整读 49KB 的按需分节加载 | C | 需改 DSH skill 机制，部署侧动因未成熟 |
| L2 | edit 读态摩擦（19 次） | C | 单次 1 步；DSH 上游行为；随 M1 观察是否恶化 |
| L3 | subagent/workflow 委托推广 | A | 当前任务形态单人可解；强制分反增开销 |
| L4 | sleep 轮询换 job 完成通知驱动 | A | 已有机制，属模型习惯；C4 后段已自发转向 |
| L5 | bash 结果超阈值自动截断 + spill 提示 | C（DSH 上游） | 收益真实（C4 两条 50KB 滞留 75 步）但属 harness 工具行为，不在 preset 边界内 |
| L6 | repo skill（ascendnpu-ir-expert）体积治理 | 仓库自身 | 不在本 preset 边界内 |
| L7 | `tool-web` 的 `fetch: false` 取舍复核 | C（preset config 一行） | C8 为 MLIR ABI 权威文档空转 5 步（web_search 仅回 URL、curl 被网络策略阻断）；但放开 fetch 引入新面，建议以「离线 MLIR/LLVM 文档包」（外流项 5）优先，fetch 复核次之 |

### 外流项（Category D → `mlir-compiler-harness/adapters/compiler-dev` feedback，见 Appendix B）

1. **pipeline 日志取证查询面**（C4/C5/C9，`query-coverage`）：IR-dump 段导航、双日志 pass 级对齐、
   「第 N 个 dump」定位；以及面向编译器工具链的 stop-at-pass dump / pass-segment replay 能力诉求。
2. **pass 约束/意图的会话内入口**（C3/C4/C5，`workflow`）：`review <pass>`/`pass-constraints`/
   `pipeline-stages`/`evidence` 已存在，但 preset 无任务路由入口、契约无 do-not-rediscover 指向
   ——两侧协作的接缝问题，建议按 workflow-contract.md 的任务序列在目标仓库契约登记。
3. **编译缓存 IR 实证源**（C8，`evidence-location`）：`cache_*/kernel.ttadapter.mlir` 等实际下发 IR
   作为证据位的登记与检索；延伸为「语义探针」——给定 triton 指针类型，直接给出 ttadapter 产生的
   memref 类型与对应 ciface 签名（C8 中若有此探针，io 组 byte-typed 假设可在编辑前被证伪）。
4. **VF 身份命名契约**（C3，`documentation`）：producer `+"_fused"` / consumer `contains("_fused_")`
   的隐式约定文档化（或以 `hivm::isVF` 属性为唯一事实源）。
5. **dtile io/dev 地址契约与 CANN regbase intrinsic 语义参考**（C8/C9，`documentation`）：io 组与
   dev 组的 element 类型解释/offset 语义无文档化事实源（C8 v1 错误的直接土壤）；`copy_ubuf_to_ubuf`
   系列的管线归属（MTE vs V）与异步顺序保证在 repo 内不可确证（C9 S85–S88 死胡同）——需要
   离线 intrinsic/ISA 语义参考包；补齐前「对照实验 + 保留不确定性」是正确姿势。

---

## Part 6 — CompilerDev Harness Improvement Plan（实施提案，等待确认）

> 以下为建议改动清单；**未经确认不实施**。

### 6.1 改动文件与理由

| 文件 | 改动 | 对应项 | 预期改善 | 验证 |
|---|---|---|---|---|
| `compiler-inspect-v3-1.cjs`（按热更新约定**改名**为 `compiler-inspect-v3-2.cjs` 并同步 `agent.cordis.yml` 组成行） | ① `history_window` schema 加 min/max + 描述写明；② CORE_POLICY 按 H3 修订（第 5 条两个子句、第 7 条加 stale-artifact 判据、第 8 条点名生成文件）；③（可选，M1 采纳后）第 9 条补「长循环中假设变更即重取 checkpoint；THINK 片段不算」 | H1、H3、M1 | CI 参数错误归零；commit 描述/工件分析/rebase 类任务的调用时机摩擦消失；stale 产物误判分支有显式候选 | `node --test` 式参数校验单测；analyze-session 对新会话的四项指标对比（CI 参数错误数、CI 首步相对首个 repo 检索步、正式 checkpoint 率、50KB 级结果数） |
| `compiler-inspect-driver.mjs`（bump `?v=`） | ① definitionPattern 补 C/C++ 函数定义形；② vendored 回退条件放宽；③（M4 采纳后）`log_files` 有界分段定位参数；schema 同步 | H2、M3、M4 | C7 定义节非空；28KB 裸 grep 消失；日志取证获得有界入口 | driver 重放：C7 锚点定义命中；C4/C5 日志样本的行号索引正确性与预算遵守 |
| `skills/compiler-development/SKILL.md` | 锚点工作法节加：多次 CI 复用契约参数 + unresolved 锚点先修正；Checkpoint 节加 M1 的长循环条款、契约对账自检与 THINK 引导 | M1、M2 | 参数漂移消失；高压力段 checkpoint 在场；设计类错误被自检拦截 | 下一批会话 analyze-session 指标 |
| 目标仓库 `AGENTS.md`/`AGENTS.local.md`（**经人类**，agent 只能提案） | M5 的三条契约内容 + M6 镜像树约定 | M5、M6 | 环境抢修/日志取证/按-HEAD E2E 有据可依 | 同上 |
| `analysis/feedback/`（新） | Appendix B 的 5 条 Category D 项按 feedback-schema.md v1 落盘为 JSON | 外流项 | D 类信号进入知识层演进回路 | `mlir_repomap.feedback.validate_feedback` 校验通过 |

### 6.2 不做的事（边界声明）

- 不把 pass/pipeline 语义复制进 compiler_inspect（repomap 领域；接缝 5/6 需最强证据）；
- 不增加「每步检查单」类规则（P3 的教训：规则在场 ≠ 被执行；机制与判据优于规则堆叠）；
- 不修改 DSH 上游（edit 读态校验、skill 加载、bash 截断行为、context-guard）；
- 不在 preset 侧内联 mlir-compiler-harness 的 workflow 方法论（thin-adapter 原则）；
- 不动 Part 4 中已达标的部分（最小补丁、四分类、验证矩阵、契约回路）——保持而非重写。

### 6.3 实施顺序

1. H1+H2（纯机械，零文本风险）→ 热更新改名/bump；
2. H3（策略文本一处集中修订）→ 下一批真实会话观察；
3. M1/M2（skill 两节各加两行）→ 同上；
4. M3/M4（driver 重放验证通过后）→ 进插件；
5. M5/M6（契约提案交人类）→ 人类决定是否登记；
6. Appendix B 反馈 JSON 落盘 → 知识层回路。

---

## Appendix A — 方法与数据

- 9 个 case 解包为逐帧 JSONL；`scripts/analyze-session.mjs` 得基线指标；另以解析脚本提取：全部
  human turn、assistant reasoning/text、tool call 参数、isError 与超限结果、compaction summary、
  context-guard 注入、bash 动词普查、验证命令清单、CI bundle 逐节计数、checkpoint 全文定位。
- 每 case 一份 digest（`/tmp/case-analysis/<id>/digest.md`）；C3/C4/C5/C6 由四个并行分析代理产出
  结构化报告（`/tmp/case-analysis/reports/`），两处与量化初稿相悖的结论（C4 的 edit/CI 顺序、
  checkpoint 是否存在）均已回到原始日志验证后以日志为准修正。
- 已知数据坑（复现时注意）：analyzer 的 first-edit/first-inspect step 是**按轮编号**，跨 turn 比较
  会产生顺序假象；checkpoint 的 em-dash 格式（`Decision —`）不会被分号式正则命中。

## Appendix B — Category D 反馈工件样例（对齐 `adapters/compiler-dev/feedback-schema.md` v1）

```json
{
  "feedback": {
    "schema_version": 1,
    "created_at": "2026-09-06",
    "task": { "kind": "pipeline-log-investigation", "target": "pass:hivm-mark-multi-buffer" },
    "query": { "command": "evidence", "args": { "id": "pass:hivm-mark-multi-buffer" } },
    "observation": "multi-buffer 性能根因分析（两份 10MB pipeline 日志对比）中，需在两份日志的 IR Dump After 段之间逐 pass 对齐；repomap 无日志取证查询面，会话以 142 次 grep/awk 手工完成。另一会话 46MB/2.8M 行日志二分耗时约 350 步中的近半。",
    "manual_source_search": { "performed": true, "reason": "日志域无查询入口；pass 导航知识靠模型从源码自行拼装。" },
    "possible_gap": { "category": "query-coverage", "statement": "可能缺少以 pipeline 日志 IR-dump 段为对象的 pass 导航/对齐查询（log-evidence 面）；以及编译器工具链侧 stop-at-pass dump / pass-segment replay 能力。" },
    "evidence": [ { "file": "lib/Dialect/HIVM/Transforms/MarkMultiBuffer.cpp", "lines": "1-120" } ],
    "sensitivity": { "contains_sensitive_content": false }
  }
}
```

（其余四条同 schema：`workflow`——四个查询已存在但 preset 无任务路由入口与契约指向；
`evidence-location`——编译缓存 `cache_*/kernel.ttadapter.mlir` 未登记为可检索证据位；
`documentation`——VF `_fused_` 身份启发式无文档；`documentation`——dtile io/dev 地址契约与
CANN regbase intrinsic 语义参考不可达。）

---

*报告完。Part 6 为提案，未实施任何代码改动；等待确认后按 6.1/6.3 执行。*
