# Compiler Dev Preset 架构说明

> 本文面向 AI 模型:作为分析「Compiler Dev Preset 如何与 `mlir-compiler-harness` 配合使用」的输入材料。
> 第 1–10 章是 preset 侧的架构事实(逐条来自 preset 源文件,已核对);第 11 章是被对接方的概览(来自
> mlir-compiler-harness 仓库文档);第 12 章是接缝分析,属于**供评审的建议**,不是已实现的机制。
> 文件指针:`/home/shijingchang/.dsh/.agent-presets/compiler-dev/`(下称 `PRESET/`)与
> `/home/shijingchang/workspace/mlir-compiler-harness/`(下称 `HARNESS/`)。

---

## 1. Preset 定位与文件清单

Compiler Dev 是一个 DeepSeek Harness **agent preset**(per-session agent 组合层):在标准编码 agent
能力之上,面向 **MLIR/LLVM/Triton 类编译器仓库工程**增加一套有界证据检索、人在回路契约和纪律化验证的
工作方式。`PRESET/preset.yml` 的元数据:

- `name: Compiler Dev`
- `description: Standard coding capabilities with bounded compiler evidence, human Repository Contracts, disciplined verification, and knowledge-first compiler-memory routing.`

目录结构:

| 文件 | 角色 |
|---|---|
| `preset.yml` | preset 元数据(name/description) |
| `agent.cordis.yml` | **agent-plane 组成**:挂载哪些插件/工具/提示段(第 2 章) |
| `compiler-inspect-v3-5.cjs` | 本地 Cordis 插件:always-on 核心策略段 + `compiler_inspect` 工具(第 3 章;v3-3 = output schema 兼容修正;v3-4 = Phase R1 backend policy;v3-5 = Phase R1.5 rollout 默认 legacy) |
| `compiler-inspect-driver.mjs` | 检索驱动,被插件 in-process import(第 4 章;v1.3 起含 CodeContextProvider 接缝,v1.4 = rollout 默认) |
| `compiler-context-backend.mjs` | Ripwire 通用上下文后端(第 14 章) |
| `compiler-observation-state.mjs` | per-agent correlation id 共享注册表(第 14.5 节) |
| `compiler-knowledge-v3.cjs` | 本地 Cordis 插件:`compiler_route` + `compiler_knowledge` 工具 + always-on 知识路由段(第 3.3 节、第 13 章;v3 = correlation id 发布) |
| `compiler-knowledge-driver.mjs` | 知识查询驱动,被插件 in-process import(第 13 章) |
| `compiler-explain-v1.cjs` | 本地 Cordis 插件:`compiler_explain` 工具 + always-on code-explanation 路由段(第 17 章) |
| `compiler-explain-driver.mjs` | 教学 artifact bundle 的 plan/validate/readiness/stale 驱动(第 17 章) |
| `scripts/teaching-schema.mjs` | Teaching Artifact Protocol v1 validators + 机械 readiness 门 + staleness(第 17 章) |
| `skills/compiler-development/SKILL.md` | preset 本地 skill:条件性详细指南(第 5 章) |
| `skills/code-explanation/` | preset 本地 skill:通用 code explanation workflow 与 artifact 字段手册(第 17 章) |
| `skills/compiler-architecture-presentation/` | preset 本地 skill:代码/IR/设计笔记 → Quarto Reveal.js 架构/Pass 说明 slides(中文优先、Excalidraw 源图、QMD 为源、HTML 为产物) |
| `REPOSITORY_CONTRACT_TEMPLATE.md` | 人类维护的**团队**仓库契约模板——模板产物落在目标仓库,不在本仓库(第 6 章) |
| `contracts/<Profile>/{REPOSITORY_PROFILE.md,AGENTS.local.md,profile.json}` | harness 拥有的仓库 profile 与 host-local 事实源;**不含**团队 `AGENTS.md` 快照(第 6 章) |
| `scripts/prepare-workspace.mjs` | workspace 准备:把 harness profile+local 事实物化为目标仓库的 `AGENTS.local.md` 托管副本,并通过 `info/exclude` 本地排除(第 6 章) |
| `scripts/analyze-session.mjs` (+`scripts/test/`) | 离线会话日志分析器,非模型侧(第 8 章) |
| `scripts/{feedback-schema,collect-feedback,review-feedback,summarize-feedback,export-feedback-bundle,regression-cases}.mjs` | Phase 2 离线观测闭环工具(第 13 章) |
| `analysis/case-baseline.json` | 案例回归基线(仅指标数字) |
| `README.md` | 面向人的使用说明 |

## 2. 组成挂载模型(agent.cordis.yml 的分层逻辑)

DeepSeek Harness 中,host 组成(`base.cordis.yml` + `web.cordis.yml`)拥有 preset 不得拥有的东西:
各类注册表本身、沙箱与审批栈、持久化、模型路由。preset 文件是 **agent-plane 组成**,由 roster 在进程内
以常驻 scope 挂载一次;每个会话通过 scope 父子关系加入,工具与提示段随之覆盖该 agent,而插件内部的
会话状态按 Session/Agent 各自键控。

### 2.1 三种归属模式(本文件的核心架构逻辑)

每一行(agent-plane 中的一个插件挂载)按其发布物归属,遵循三条模式:

1. **只向 host 注册表注册 model-facing 工具/提示段、不发布服务的行** → 不需要 realm。
   如 `tool-fs`、`tool-bash`、`tool-jobs`、`tool-goal`、`tool-skill`、`tool-ask-user`、
   `tool-todo`、`tool-web`、`compiler-inspect`。
2. **发布服务的行** → 必须放进带 `isolate` realm 的 group,否则发布到 root realm(进程全局),
   与其他 preset 同名服务冲突,`dsh-agent-presets` 在挂载时拒绝。`isolate: true` = 条目私有 realm。
   如 `planning`(isolate `planMode`)、`compaction`(isolate `compaction` + `toolResultPruner`)、
   `delegation`(isolate `workflowEngine`)。
3. **注册表型单例(跨会话、跨 preset 读取)留在 host-plane**,preset 只决定 agent 是否拿到
   model-facing 工具。例如:jobs 任务注册表、goals 服务、subagents 注册表、tokenMeter、skill 注册表。

### 2.2 挂载清单

| Group / 行 | 内容 | 备注 |
|---|---|---|
| identity | `persona`(编码 agent 人设,`{{model}}`/`{{cwd}}` 解析)、`agent-instructions`(maxBytes 65536) | |
| shell | `tool-bash`(非 Windows)、`tool-pwsh`(Windows) | `shell-env` 与沙箱执行器留在 host |
| filesystem | `tool-fs`、`tool-fs-search`(`sampleOverCapGlobResults: false`) | `fs` 服务与策略留在 host |
| background jobs | `tool-jobs` | 任务注册表留在 host(键控按 agent) |
| skills | `skill-filesystem`(`customSkillDirs` 指向 `PRESET/skills/`,经 `baseUrl` 解析,随 preset 安装位置漂移)、`tool-skill` | skill 注册表在 host 分层;本地根之外还合并部署级全局 skill |
| goals | `tool-goal` | goal 服务/驱动/命令留在 host(Gateway 远程端点) |
| plan mode | group(isolate `planMode`)+ `plan-mode`(完整 plan-mode 提示段:先探索后计划、计划 decision-complete、`exit_plan_mode` 收口等) | 计划状态天然 per-agent |
| compaction | group(isolate `compaction` + `toolResultPruner`)+ `compaction-basic`(**实验性早期压缩策略**,见第 7 章)+ `command-compact` + `tool-result-pruner`(8192/4096/1024) | `tokenMeter` 留在 host;pruner 必须与 compaction-basic 同 realm(经 `ctx.get` 读取) |
| delegation | group(isolate `workflowEngine`)+ `tool-subagent`(spawn,continuable)、`tool-subagent-fork`(fork,continuable)、`tool-subagent-list-agents`、`workflow-worker-thread`(provider spawn)、`tool-workflow`、`tool-ralph`(maxRounds 64);codex/claude-code 子代理行**存在但 disabled**(需安装对应 Bundle) | subagents 注册表留在 host;`tool-subagent-report` 是 host-plane(continuable setup 单例) |
| compiler | `compiler-inspect` → `./compiler-inspect-v3-5.cjs` | 只贡献提示段 + 工具,消费 host 服务,不发布服务,无 realm(第 3 章) |
| 其余 | `tool-ask-user`、`tool-todo`(`allowParallelInProgress: true`)、`tool-web`(`fetch: false`,`searchTimeoutMs: 60000`) | web 服务与搜索 provider 在 host |

**Preset 明确不挂载**:LSP、hooks、notebook/view 等非标准工具;web fetch 被关闭(仅保留 search)。
条件禁用走 `!!js` 表达式(仅 shell 两行,按平台二选一)。

## 3. compiler-inspect 插件(compiler-inspect-v3-5.cjs)

`exports.name = 'compiler-inspect'`,`exports.inject = ['tools', 'systemPrompt']`。`apply(ctx)` 做两件事:

### 3.1 Always-on 核心策略(system prompt 段 `compiler-development-policy`,order 114)

十条例则,设计依据是生产会话中模型并不总先加载 skill,因此**定义该 preset 的最小不变量集必须每步在场**:

1. 人类 Repository Contract(AGENTS.md 或邻近契约文件)与项目指令是权威操作知识。
2. 不重新发现已文档化的环境/构建/测试流程,除非文档流程在用点失败,或任务本身就是该基础设施。
3. 只构建任务相关的架构/数据流模型,不做全仓库理解。
4. "最近 N 个 commit"是历史搜索地平线;优先路径/符号 scoped history,仅跨文件设计意图才读完整 commit。
5. 有显式文件/符号锚点的代码评审、设计评审、语义调查、pass 分析、API 分析、近期历史任务,
   **第一步调 `compiler_inspect`**(在串行 grep/read/git 之前)。跳过条件:已知单文件即可回答、
   纯执行契约中的构建/测试命令、用户明确不用;构建/环境类工作不适用。
6. 语义最小补丁:满足任务的最小改动;无顺手重构/格式化/重命名/依赖变更。
7. 有界验证:每个失败归类为 patch-caused / environment / pre-existing / unknown;
   一次聚焦对照实验证明无关后,记录并停止调查。
8. 不向 context 流式倾倒可预见的大输出(ninja -t、完整构建日志、宽 find、大 git show 等);
   重定向到临时日志再取有界切片。
9. 设计敏感编辑前、大型发现阶段后、长验证前,保留一行 checkpoint:
   **Decision; Evidence; Uncertainty; Patch implication**。
10. 域边界:本 preset 服务编译器仓库工程;若任务变成修改 DeepSeek Harness 本身(preset/Cordis/Web/运行时),
    先结束进行中的编译器构建/测试,再换 fresh Creator-mode 会话继续。仅提及 DSH 不触发;DSH 成为实施目标才触发。

### 3.2 `compiler_inspect` 工具注册

- 工具描述与策略第 5 条同口径(何时先调、何时不适用)。
- 参数与输出均为 JSON Schema 强约束(输出 `additionalProperties: false`);`render` 把结构化 bundle
  渲染为分节文本。
- **driver in-process 运行**:`import(new URL('./compiler-inspect-driver.mjs?v=1.2', file://__filename))`。
  设计理由:driver 是固定、只读(git/rg)、参数不落 shell 的脚本,in-process 比 shell/沙箱往返少一类
  失败模式且不损失封闭性。60s AbortController 兜底,并透传工具调用的 abort 信号。
- URL 的 `?v=1.2` 用于击穿 host 进程的 ESM 模块缓存(见第 9 章)。

> 命名澄清:文件名 `v3-3` 是插件文件的演进代号(v3-3 仅将 output schema 的 type 数组改为当前 harness 支持的 `oneOf` nullable 形式,行为不变);driver 内 `VERSION = '1.2'` 是检索协议版本,
> README 与工具描述均称 v1.2。两套编号并存,勿混淆。

### 3.3 compiler-knowledge 插件(compiler-knowledge-v3.cjs)

`exports.name = 'compiler-knowledge'`,`exports.inject = ['tools', 'systemPrompt']`。归属与
compiler-inspect 相同:只注册 model-facing 工具与提示段,不发布服务,无 realm。包含:

1. always-on 知识路由段 `compiler-knowledge-routing`(order 115):knowledge-first 顺序、按任务
   类型路由、保守 skip、不过度查询、反馈工件义务(第 13 章为 Phase 2 扩展后的文本);
2. `compiler_route` 工具:每任务一次的路由决策 + correlation id 铸造(第 13.2/13.3 节);
3. `compiler_knowledge` 工具:四个契约查询 + status;driver 经 `?v=` in-process import(与 3.2 的
   `?v=` 缓存击穿机制相同),240s AbortController 兜底。

内部状态(route→correlation 映射)按 `exec.agent.id` 分键:standing-scope 单次挂载下所有 session
共享同一模块实例。观察流默认写 preset 的 gitignored `analysis/feedback/{routes,queries}/`,
`COMPILER_DEV_FEEDBACK_DIR` 可重定向(测试用)。

## 4. `compiler_inspect` 接口契约(v1.2)

### 4.1 输入参数

| 参数 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `repo_root` | string | `process.cwd()` | 仓库根;缺 `.git` 时回退 `git rev-parse --show-toplevel`(子目录锚点可用) |
| `files` | string[] | `[]` | 文件锚点;根外路径被过滤,绝对路径转为相对展示 |
| `symbols` | string[] | `[]` | 符号锚点;去重后截前 12 个 |
| `history_window` | int | 6 | git log 窗口,1–30(schema 声明 min/max);越界值**钳制**到边界并在 `unresolved` 记录,不再使整次调用失败 |
| `include_tests` | bool | true | 是否检索覆盖测试 |
| `include_diff` | bool | true | 是否含工作树 `git diff --stat` |
| `contract_test_dirs` | string[] | `[]` | **来自 Repository Contract** 的测试目录;替换默认 test glob |
| `exclude_dirs` | string[] | `[]` | 追加到默认排除目录(默认排除:`.git`、`node_modules`、`dist`、`build`、`out`、`target`、`.cache`、`__pycache__`、`.venv`/`venv`、`.mypy_cache`、`.pytest_cache`、`.cxx`) |
| `log_files` | string[] | `[]` | **v1.2** 编译/pipeline 日志路径(≤4,相对 repo_root);触发有界日志取证 |
| `log_passes` | string[] | `[]` | **v1.2** 感兴趣的 pass 名(≤8;精确匹配优先,否则按首个子串命中) |
| `log_occurrence` | int | 1 | **v1.2** 取每个 pass 的第 N 个 dump |
| `log_slice_lines` | int | 60 | **v1.2** 每个切片的最大行数(5–400;切片在下一个 dump 标记处提前截断) |

### 4.2 检索管线(单次调用、一次往返)

1. Git 状态:`branch --show-current`、`status --short`(前 8 条);非 Git 工作树记入 `unresolved`。
2. **定义检索**(batched):符号集合拼成一条 ripgrep 交替正则,单遍——关键字声明形
   (`class|struct|union|enum|... name` / `name\s*[:=]`),**v1.2 增加 C/C++ 附加花括号函数定义形
   `type... name(args) {`**(v1.1 对纯 C/C++ 函数定义全部 miss,定义行只能落在 References 节),
   `--max-count 6`、`-C 2` 上下文。
   排序规则:锚点文件内 match 行 > 其他文件 match 行 > 锚点文件上下文行 > 其他上下文行,同秩稳定。
   取前 10 条(`MAX_DEFINITION_ITEMS`)。
3. **引用检索**:`\b(symbols)\b` 单遍 batched,`--max-count 8`,取前 12 条。
4. **Vendored 回退**:三个触发条件——(a) 符号在非 vendored 树零匹配(v1.1 行为);(b) **v1.2**
   非 vendored 树无定义形命中(ABI 链条的 vendored 半边此前无工具覆盖),此时用定义形模式检索;
   (c) **v1.2** 锚点文件位于 vendored 树内。取前 4 条;并写入 `unresolved` 说明触发原因。
   include/vendor glob 顺序利用 ripgrep last-glob-wins 保证 vendored 默认被排除。
5. **测试匹配**:`contract_test_dirs` 非空则用它,否则默认 glob(`**/*test*` 等);取前 8 条。
6. **工作树变更**:`git diff --stat`(锚点文件或全仓库),取前 12 条。
7. **历史**:`git log -N --format='%h %s' -- <files| .>`;另对前 3 个符号做 `-S` pickaxe(各取 4 条)。
8. **日志取证(v1.2)**:`log_files` 非空时,逐文件扫描 `IR Dump After/Before <pass>` 标记,产出
   每 pass 计数 + 首行号索引(≤24 条/pass 名)、`log_passes` × `log_occurrence` 寻址的有界 dump
   切片(单切片 ≤`log_slice_lines` 行,行 ≤280 字符,总量 ≤8K 字符),两份日志时追加 pass 序列
   diff(逐 pass 计数差、首个分歧 dump 序号、公共 pass 首现行号对齐)。机械行号运算,不解读 IR。
9. **Unresolved 诊断**:无显式锚点、符号零匹配(拼写/生成代码/实现专属名)、vendored 命中及触发
   原因、日志文件缺失/无匹配 pass、history_window 钳制等,显式列出。

### 4.3 预算与输出

- 行级:每条 ≤280 字符(`MAX_LINE_CHARS`);每节 ≤12 条(`MAX_ITEMS`,定义节 10)。
- **总量硬预算 20000 字符**(`MAX_TOTAL_CHARS`):超限时按 References → History → Tests → Definitions → Logs
  优先级对最大节对半裁剪,`budget.truncated = true`;日志切片文本另有 8K 字符子预算。
- 输出 schema:`repository{root,branch,dirty}`、`anchors{files,symbols}`、`definitions[]`、
  `references[]`、`vendored_matches[]`、`tests[]`、`changes[]`、`history[]`、**`logs{files[],slices[],slice_items[],diff|null,truncated}`(v1.2)**、
  `unresolved[]`、
  `budget{max_items_per_section, max_line_chars, total_budget_chars, truncated, version}`。
- **语义定位**:只检索确定性代码事实;不推断构建/环境命令;bundle 各节是**线索不是结论**
  (skill 明言:定义行只是语法 + 两行上下文,不足以决策时才打开文件)。
- 独立运行:`node compiler-inspect-driver.mjs <base64url(JSON 输入)>`,便于脚本化复现。

## 5. compiler-development skill(preset 本地 skill)

frontmatter:`name: compiler-development`;描述面向 Triton/MLIR/LLVM 类仓库;`whenToUse`:编译器架构、
代码评审、实现、测试、近期历史任务。

与 always-on policy 的**分工**:policy 承载不变量(contract-first、任务相关架构、单 bundle、最小补丁、
有界验证/输出、checkpoint、域边界),skill 承载不变量背后的判断细节,**不重复不变量**。五个主题:

1. **锚点工作法**:先定义/调用方/语义/测试/scoped history,证据足够即停(额外探索是花销不是安全)。
   调 `compiler_inspect` 时把 Contract 的测试目录传 `contract_test_dirs`、vendored/子模块/生成目录传
   `exclude_dirs`,**同一会话的后续调用必须复用这些契约参数**;bundle 的 `Unresolved` 报告锚点未命中时,
   先修正或删除该锚点再扩大搜索。**v1.2**:编译/pipeline 日志经 `log_files`/`log_passes` 走有界取证,
   不向 context 流式倾倒原始日志。契约约束进入 bundle 而不复制契约。bundle 是线索;`Vendored matches`
   或 truncation 标记 = 证据不完整,应收窄锚点而非扩大搜索。"最近 N commits"是搜索地平线。
2. **Repository Contract**:权威次序 = 人类契约 > 项目指令 > 源码 > 相关历史 > 推断。先读契约再做任何
   环境/构建/测试发现;契约命令只在用点验证,不换成推断流程。无契约时只发现本任务所需事实。
   **绝不持久化推断出的操作事实**;有用 workaround 以候选契约更新提议给人;仅当人类要求时才用模板起草。
   契约是**两层所有权的合成**——目标仓库团队维护的 `AGENTS.md`(上游权威,harness 只读)+
   harness 物化的 `AGENTS.local.md` 本地覆盖(见第 6 章);两者相加构成有效仓库操作上下文。
3. **Checkpoint**:一行 `Decision; Evidence; Uncertainty; Patch implication`,在三个时机取——设计敏感
   编辑前、大型发现移交实现时、结论稳定后的长验证前。**v1.2**:长实现/调试循环中,工作假设每变更一次
   重取一行;只存在于 reasoning 中的决策不算 checkpoint;设计定稿的 checkpoint 须把已声明契约与实现逐条
   对账;长推理落盘为 checkpoint/结构化笔记,不做超大单块思考。目的是**在 compaction 中存活**(摘要保留
   工程状态而原始证据被遮蔽)。是证据边界不是数据库;琐碎读取后不发仪式性 checkpoint。
4. **验证**:先窄验证,有理由才跑仓库规定的更广检查。失败四分类;疑似无关阻塞最多一次聚焦对照实验,
   证明无关后记录(阻塞、证据、它阻止了什么验证)并继续不受影响的检查;不为凑绿改环境/依赖文件。
5. **混合/域外工作**:混合请求按内部工作包分组,证据充分的包先行。Harness/preset/Cordis/Web/运行时
   基建工作移交 fresh Creator-mode 会话,交接带简短观察总结。

## 6. Repository Contract(人在回路)与所有权分层

### 6.1 指令所有权

每个目标编译器仓库的操作指令分三个所有权域,互不竞争同一文件:

```text
          team Git 历史
                │
                ▼
        目标仓库 AGENTS.md            ← 团队拥有、tracked、正常 Git 演进
        (harness 只读,永不改写)
                │
                ├──────────────────────────────┐
                │                              │
                ▼                              ▼
        仓库操作规则(构建/测试/   compiler-dev-harness
        环境/子模块 —— 上游真相)            │
                                            ├─ contracts/<Profile>/REPOSITORY_PROFILE.md
                                            │    harness 仓库 profile(检索策略、
                                            │    compiler_inspect 契约参数、
                                            │    团队不跟踪的仓库约定)
                                            └─ contracts/<Profile>/AGENTS.local.md
                                                 host-local 事实
                                                     │
                                                     ▼
                                        scripts/prepare-workspace.mjs
                                                     │
                                                     ▼
                                        <TARGET>/AGENTS.local.md
                                        生成的托管副本(带 managed 头 +
                                        内容 SHA-256),经 info/exclude
                                        本地排除,不进团队 Git
                                                     │
                                                     ▼
                                        有效 agent 操作上下文
                                        (base AGENTS.md + additive local overlay)
```

- **团队 `AGENTS.md`**(目标仓库 tracked):上游操作真相。harness 可读、可检测存在/是否
  tracked,但**永不**改写、永不 symlink、永不 `skip-worktree`/`assume-unchanged`、
  永不在 pull/rebase 后恢复副本、永不静默合并 harness 策略。普通 `git pull`/rebase
  正常更新它,无需任何人工恢复。
- **`REPOSITORY_PROFILE.md`**(harness 拥有):`compiler_inspect` 契约参数
  (`exclude_dirs`、`contract_test_dirs`)、harness 工具纪律、团队不跟踪的仓库约定
  (如 `hivmc/` A5 镜像树、pipeline 日志取证)。
- **`AGENTS.local.md`**(harness 源 → 目标仓库物化):host 专属事实(工具链路径、
  加速器、本机 workaround),按服务器分源存放:`contracts/<Profile>/hosts/<host-id>/`
  (+`host.json` 的 `hostnames` 别名),由人提供、模板为
  `contracts/HOST_FACTS_TEMPLATE.md`,agent 只能起草、由人审定提交。部署名固定为
  `AGENTS.local.md`,因为这是 DeepSeek Harness agent-instructions 加载器默认的
  additive local-overlay 候选(base 之后渲染,不遮蔽 base);源文件名与部署名的区分
  见 `contracts/README.md`。

### 6.2 workspace 准备(`scripts/prepare-workspace.mjs`)

```sh
node <harness>/scripts/prepare-workspace.mjs [target-root]     # 物化/更新
node <harness>/scripts/prepare-workspace.mjs --check [target]  # 只校验
# 可选:--profile <name> 强制 profile;--harness-root <dir> 覆盖 harness 根
```

- **身份识别**:显式 `--profile` > Git remote URL 匹配 > worktree 目录名;无匹配或
  歧义是有界失败(exit 2),绝不猜测。远程匹配是第一依据,因为 clone/worktree 的本地
  目录名可变(实测:远程仓库名 `AscendNPU-IR`,本地目录 `AscendNPU-IR-Dev`)。
- **host facts 解析**:显式 `--host` > 当前 `os.hostname()` 与
  `contracts/<Profile>/hosts/<id>/host.json` 的 `hostnames` 匹配;无匹配 = 有界失败
  并附模板指引。**绝不让上一台服务器的 facts 物化到新机器**;host 事实只能由人提供
  (或 agent 按 `contracts/HOST_FACTS_TEMPLATE.md` 起草、人审定后提交),含未填的
  `REQUIRED:` 占位即拒绝物化;遗留的单机 profile 级 `AGENTS.local.md` 仍受支持,
  与 `hosts/` 并存则报错(单一事实源)。
- **物化策略**:`REPOSITORY_PROFILE.md` + `AGENTS.local.md` 合成为**生成的托管副本**
  (非 symlink):一个部署文件必须承载两个 harness 源;副本自包含,不会因 harness
  checkout 移动而悬空;新鲜度由重跑 prepare 确定性地处理。托管头含
  `compiler-dev-harness:managed-v1` + profile 名 + 正文 SHA-256——所有权按内容识别
  而非文件名,摘要漂移即检出手工编辑。
- **Git 排除**:经 `git rev-parse --git-path info/exclude` 写入**common** Git dir
  (对普通 clone、linked worktree、`.git` 为文件的布局都正确),**不改团队 tracked
  `.gitignore`**;幂等(已有裸条目或标记块则不动,畸形块报错不重写),并用
  `git check-ignore` 验证。
- **冲突安全**:unmanaged 已存在文件、异 profile 托管件、手工编辑过的托管件一律拒绝
  并给出可操作指引,且拒绝发生在任何 mutation 之前;团队 `AGENTS.md` 上游变化无需
  任何处理,prepare 照常成功。退出码:0 成功,1 冲突/漂移,2 用法/未知 profile。
- **worktree**:排除条目在 common dir,**所有 linked worktree 共享**;托管副本按
  working tree 各自一份——新 worktree 只需在其中跑一次 prepare,无需手工编辑
  Git 元数据。
- **启动边界**:preset 组成(agent.cordis.yml 的行 = service/tool/prompt 注册)没有
  可靠的启动脚本钩子,故调用保持显式、幂等;架构为将来自动调用留好接口(直接包一层
  即可),不伪造钩子。
- **域边界**:workspace 准备是基建,与 `compiler_inspect`、`compiler_knowledge`、
  Ripwire、feedback 协议零共享代码路径;其观察不写入知识反馈。

### 6.3 契约字段与机制

`REPOSITORY_CONTRACT_TEMPLATE.md` 的字段(模板给**团队**在目标仓库维护
`AGENTS.md` 用,产物不落在本仓库):仓库身份/主分支、主编译器子系统、环境初始化
(shell/Python/conda/工具链/设备)、规范与增量构建命令、验证命令(fast/default、
Python、MLIR-lit-FileCheck、C++、host-only、加速器必需)、格式化/lint、
**仓库边界**(禁改/禁广探目录、生成或 vendored 目录)、子模块策略、已知环境约束、
已知支持的 workaround、**do-not-rediscover 规则**(必须复用而非从构建文件/CI/脚本
重新推导的事实)。

机制要点:

- 契约字段完成后即权威,只在用点验证。
- 每任务都用的事实放团队 `AGENTS.md`;harness 检索参数放 `REPOSITORY_PROFILE.md`;
  更大的子系统材料放项目本地 skill/参考;host 事实放 `AGENTS.local.md`;不复制。
- `contract_test_dirs` 与 `exclude_dirs` 是契约进入 `compiler_inspect` 的两个参数
  通道(见 4.1);在新所有权模型下它们由 harness profile 持有并经本地覆盖到达 agent。
- agent 永不静默持久化推断事实;新 workaround 作为候选人类更新上报到对应所有权域
  (团队规则→目标仓库契约;host 事实→harness `AGENTS.local.md` 源)。

## 7. 上下文预算机制(三层)

1. **实验性早期压缩**(`compaction-basic.modelPolicies`):源自四个生产编译器会话审计——长发现阶段在
   1M 上下文路由上累积到 ~250K cached tokens 而无压缩事件,实现与验证跑在巨大发现历史上。对**精确匹配
   provider+model** 的六条已确认 1M 路由(`huawei-api-bundle` × GLM-5.3-Flash / GLM-5.3 /
   DeepSeek-V4-Pro / DeepSeek-V4-Flash-0731;`sub2api` × deepseek-v4-flash / glm-5.3-flash)设
   `thresholdRatio: 0.2`(~200K 触发)+ `retainTokens: 65536`。其他 preset、未知模型、小上下文路由
   保持默认 80% 溢出阈值。**扩展前提**:对应 `contextWindow` 声明必须先出现在 `~/.dsh/settings.yaml`。
2. **工具结果修剪**(`tool-result-pruner`,同一 compaction realm):`thresholdChars: 8192`,
   保留 head 4096 + tail 1024。
3. **Checkpoint 纪律**(第 5 章主题 3):一行工程状态,抗 compaction 遮蔽。

## 8. 会话观测(scripts/analyze-session.mjs)

离线、非模型侧分析器,读取导出的会话日志(`.jsonl` 或本部署写的多帧 zstd `.jsonl.zstd`,
逐帧扫描解码;`DSH_SESSION_JSONL` 环境变量可兜底当前会话)。容错:坏行、缺字段、未知事件忽略不致命。

报告字段:session id/preset/cwd/version、provider/model/contextWindow、human turns(+goal 续跑轮)、
model steps、tool calls 按名分布、`compiler_inspect` 调用数与首次出现 step、`compiler_knowledge` 调用数
(按 command 分解)、**Phase 2 观测面**——`compiler_route` 声明(kind/knowledge_expected/confidence/
correlation id)、route 分组(每组 knowledge 调用数、命令分解、discovery/verification/uncertain 搜索计数、
edit step、operational 信号)、adoption(eligible/adopted/missed)、temporal 次序(首个 knowledge/inspect/
discovery/edit step、knowledge-before-search)、**搜索分类**(见第 13.5 节,precision-first)、skill 加载
失败数、token 记账、峰值请求上下文及 step、首个 edit/write step、工具结果总量与超 8KB 计数及最大 5 条、
compaction 启停/错误数、per-turn 明细。

用途:preset 变更以真实生产会话数据评判(如早期压缩策略就源自该分析器对四个会话的审计);
`scripts/regression-cases.mjs` 用同一分析器对 `cases/` 语料做基线回归(第 13.6 节)。

## 9. 运维细节(热更新)

- host 进程按文件 URL 缓存 preset 插件模块,生存期为进程生命周期:
  - 改 `compiler-inspect-v3-5.cjs` → **重命名文件**并同步组成行;
  - 改 `compiler-inspect-driver.mjs` → **bump 插件 import 的 `?v=` 查询**;
  - 改 `compiler-context-backend.mjs` → **bump 驱动内该模块 import 的 `?v=` 查询**;
  - 组成 YAML(行、config、skill 目录)每次会话挂载时重读,无需重启。

## 10. 设计不变量汇总(下游 AI 的"不可违背清单")

1. 确定性事实优先、一次有界往返(compiler_inspect 的全部设计目的)。
2. 契约先于发现;契约事实人类拥有,agent 不持久化推断。
3. 输出有界(20K 硬预算 + 行/条上限 + 工具结果修剪 + 重定向大输出)。
4. 补丁最小;验证有界且失败四分类;无关阻塞一次对照实验后止损。
5. checkpoint 抗 compaction。
6. 编译器域边界(Creator-mode 移交规则)。
7. 组成层:服务发布必须 isolate realm;注册表单例留 host;preset 只选择 agent 能拿到哪些 model-facing 工具。

---

## 11. 对接对象概览:mlir-compiler-harness

> 本章内容来自 `HARNESS/docs/` 与 `HARNESS/adapters/`,是**另一仓库的既有事实**,此处仅摘与对接相关的部分。

### 11.1 定位与分层

仓库优先、证据优先、MLIR 感知的索引与查询系统,帮助任意 coding agent 理解大型 MLIR/LLVM 编译器仓库
(dialect/pass/pipeline/pattern/分析/测试/跨 pass 不变量),避免 grep 扫仓。核心原则:
**确定性抽取产出事实;agent 的 token 花在推理而非仓库发现**。

```
Layer A  repomap 引擎(repomap/src/mlir_repomap/)—— CLI 可运行核心,无 agent 依赖
Layer B  工作流(docs/workflows/*.md)—— agent 无关方法论,唯一事实源
Layer C  适配器(adapters/)—— 薄协议层:CLI 为主;MCP/ZCode skill 为后续阶段,只包 A/B
```

硬边界:引擎永不 import 任何 agent 产品/skill 系统/MCP SDK;每个 agent-facing 工件都是对稳定查询契约
(`docs/architecture/query-api.md`)的薄适配;机器事实(`.mlir-repomap/` 索引,生成物)与人类知识
(agent 评审的 `docs/compiler-architecture/`,由工作流产出)严格分离。

引擎模块:`index.py`(编排+增量失效)、`store.py`(SQLite + HEAD/schema/文件哈希元数据)、`model.py`、
`query.py`(**唯一查询业务逻辑**)、`cli.py`(薄 argparse 前端)、`repo.py`(git 事实)、`extractors/`
(tablegen / cpppass / pipeline / pattern / tests / attribute / python)。规则:fail soft(解析失败记
diagnostic 继续);deterministic before LLM;每条关系 ≥1 个证据(file:line)+ 置信
(confirmed/inferred/heuristic);语义后端缺席时降置信不失败。

### 11.2 查询契约 v1(对接的关键面)

统一 JSON envelope:`{command, args, index:{head, branch, indexed_at, schema_version, stale, dirty_files}, result}`。
`stale: true` = HEAD/工作树与索引快照不一致,工作流要求**推理前先刷新**(`mlir-repomap index`)。

命令族(完整表见 `docs/architecture/query-api.md`):

- 结构:`status`、`modules`、`dialects`、`passes`、`pipelines`、`symbol`、`references`
- 实体档案:`pass <name>`(**一站式 dossier**:定义/声明/工厂/注册/pipeline 成员序与守卫/前后驱/patterns/测试/
  证据指针;名字可传 arg、td class、factory、C++ 类,歧义返回 candidates,调用方必须问不能猜)、
  `pipeline <name>`(含 `--brief`)、`pipeline-stages`(Python 组合 pipeline:AST 确认的 owner、有序 stage、
  file:line 证据、未解析名走 diagnostic)
- 溯源:`pattern-owner`、`pipeline-builder`、`attribute`、`attribute-provenance`、`pipeline-composition`、
  `pass-intent`、`pass-constraints`、`evidence`(证据目录 + 结构化 finding 关联 + 实体主文件近期 git 历史)
- 生态与漂移:`ecosystem`(跨仓库)、`changed`(vs 索引/base 的变更与受影响实体)、`constraint-diff`
- **评审记忆/发现生命周期**(文档层工件,非图实体):`findings list/check/show`、`finding-impact`、
  `review <pass>`(pass 档案评审记录 verbatim + 关联 findings + 确定性不变量守卫 + 近期影响信号)。
  引擎永不推进 finding 状态;`findings check` 只报漂移与 Needs review。

Token 纪律:每条命令返回紧凑 JSON,带 `file:line` 指针,**永不返回文件内容**;agent 只打开需要的文件。

### 11.3 工作流(Layer B,方法唯一事实源)

- `repo-map`:首触/大变更后建 `docs/compiler-architecture/`(repository/dialect/pipeline/pattern/
  attribute 映射 + pass catalog)。
- `pass-analysis`:单 pass 深析,13 步固定脊柱(第 0 步即 `review <pass>` 载入评审记忆 + 对漂移 finding
  跑 `finding-impact`;第 3 步 pipeline 位置强制 `pipeline-builder` 佐证"为什么在这")。产出 pass dossier
  至 `<repo>/docs/compiler-architecture/passes/<arg>.md` 并登记 `pass-catalog.md`。
- `pipeline-audit`:跨 pass 管线审计(隐式契约、脆弱顺序、架构风险);Python 组合管线走 `pipeline-stages`。

### 11.4 适配器与约定(Layer C)

- **适配器契约**:一个 agent 被支持,当且仅当它能 (a) 在 shell 里跑 `mlir-repomap`(console script,
  入口 `mlir_repomap.cli:main`,安装于 `repomap/pyproject.toml`),或 (b) 说 MCP。适配器不得改引擎。
- `adapters/deepseek-harness/`:三个 goal 模板(`repo-map-goal.md`、`pass-analysis-goal.md`、
  `pipeline-audit-goal.md`)+ `conventions.md`。使用方式 = 把模板填占位符后作为 goal 交给 agent。
- `conventions.md` 强制行为:① 先读工作流文件,不得凭记忆改造方法;② **RepoMap before source**,
  只打开查询指到的 file:line;③ 禁全仓 grep/find(步骤走不通就记录"哪个查询本可回答"并继续);
  ④ 无查询+证据支撑的关系标 heuristic 或省略;⑤ 承重论断必须 file:line;⑥ fail soft;⑦ 结果写到工作流
  规定的确切输出路径并登记索引文件;⑧ `status` 报 `stale` 先 `index`。工作流解析顺序:
  `$MLIR_COMPILER_HARNESS` → `<target-repo>/../mlir-compiler-harness` → **abort 并问人,绝不凭记忆即兴**。
- 预算护栏(AscendNPU-IR 实测):一次 pass 分析 ≈ 1 `status` + 1 `pass` + 1–3 `pipeline`/`tests`
  (各 ≤~1.5K token)+ 读 ≤5 个源文件;显著超出 = harness/工具缺陷,记入运行报告而非硬推。
- `adapters/zcode/`:三个薄 skill(`mlir-repo-map`/`mlir-pass-analysis`/`mlir-pipeline-audit`),
  方法论零内联,运行时经 `MLIR_COMPILER_HARNESS` 读工作流文件——是"如何给一个 agent 做薄适配"的参照实现。
- 状态:`status.md`(2026-09-06)记 Phase 0–18 完成;Phase 19(Python pipeline provenance,
  `docs/goal.md`)的 `pipeline-stages` 查询与 `extractors/python.py` 已在代码中落地(以仓库实况为准)。

## 12. 对接接缝分析(供下游 AI 评审,非已实现机制)

### 12.1 两个系统的哲学高度一致

| 共同不变量 | Preset 侧 | Harness 侧 |
|---|---|---|
| 确定性事实先行 | compiler_inspect"只检索确定性代码事实" | "deterministic extraction produces the facts" |
| 有界输出 | 20K 预算 + 行/条上限 + 修剪器 | 紧凑 JSON + file:line 指针 + 预算护栏 |
| 证据指针、不猜 | bundle 是线索;vendored/截断即不完整信号 | 每论断 file:line;歧义必须问;heuristic 必须标注 |
| 人在回路知识 | Repository Contract | 工作流文件唯一事实源 + findings 文档层 |
| 可观测性 | analyze-session.mjs(会话级) | 运行报告(查询数/文件数/token,任务级) |

### 12.2 职责分工与重叠

- **compiler_inspect**:通用、零安装、无索引、单调用有界 bundle(git/rg 级);强项是便宜的锚定证据
  (定义语法 + 上下文、引用、测试、工作树 diff、scoped git 历史)。弱项:正则定义启发式、无 MLIR 实体
  语义(dialect/pass/pipeline/pattern 不是一等实体)、无持久知识。
- **mlir-repomap**:MLIR 感知持久索引 + 实体图谱 + 溯源 + 评审记忆 + finding 生命周期 + 漂移;代价是
  需安装 CLI、构建索引、管理新鲜度。注意 `evidence` 命令也含实体主文件近期 git 历史——与
  compiler_inspect 的 history 节有重叠;`changed` 与 compiler_inspect 的 diff --stat 亦部分重叠。
- 自然分工:有索引的 MLIR 仓库中,**结构性实体问题**(pass 档案、pipeline 位置、测试覆盖、约束/意图、
  评审记忆)由 repomap 查询回答;**无索引覆盖的轻量锚定**(未入图的符号、工作树 diff、任意仓库)由
  compiler_inspect 补位。两者都把串行 grep 挤出工作循环。

### 12.3 preset 侧已有的六个可对接面(按改动量排序)

1. **Repository Contract 通道(零代码)**:在目标编译器仓库 AGENTS.md/契约中登记 `mlir-repomap`
   的安装与 `index`/`status` 命令、测试目录(→ `contract_test_dirs`)、vendored/子模块/生成目录边界
   (→ `exclude_dirs`),并在 do-not-rediscover 规则中加入"pass/pipeline 结构问题先用 mlir-repomap"。
   这完全符合 preset 的 contract-first 设计,契约成为两个工具共同的约束源。
2. **preset 本地 skill(零引擎代码)**:preset 的 `skill-filesystem` 已把 `PRESET/skills/` 挂入 skill 层。
   仿照 `adapters/zcode/` 三个薄 skill,在 preset skills 下放置指向 `HARNESS/docs/workflows/` 的薄 skill
   (保持"方法论零内联"的 thin-adapter 规则),`whenToUse` 描述沿用 zcode 的触发边界(仓库级映射 /
   具名 pass / 具名 pipeline)。
3. **goal 模板通道(零代码)**:preset 已挂 `tool-goal`;`adapters/deepseek-harness/goal-templates/`
   本就是为 DeepSeek-Harness 式 agent 设计的,可作为 goal 投放。前置条件:`MLIR_COMPILER_HARNESS`
   环境变量——注意 preset 组成中 `shell-env` 属 host-plane,该变量必须在 **host 进程环境**中存在,
   preset 自身无法注入。
4. **analyze-session.mjs 观测扩展**:集成后用同一分析器度量新工具采纳情况。注意:repomap 经 bash
   调用,分析器只见 bash 计数;若需精确采纳指标,需扩展分析器(解析 bash 命令中的 `mlir-repomap`
   前缀)或未来包装为注册工具。
5. **preset 插件注册 `mlir_repomap` 包装工具(有代码量)**:仿 compiler-inspect 插件模式,在 preset 侧
   注册一个经 CLI(或进程内 QueryService)查询的工具。方向合规(引擎不依赖 agent;agent 依赖引擎是
   允许方向),但需评估相对接缝 2/3 的增量价值,且与 harness 规划中的 MCP(Phase 5 计划)职责重叠。
6. **compiler_inspect 增加 repomap 数据源(最深)**:bundle 的 definitions/references/tests 节在有索引
   仓库改由图谱供给(置信度标注随之升级)。侵入性最大,改变工具"git/rg 级、零依赖"的定位,需最强证据
   才值得。

### 12.4 张力点与待决策问题(建议下游 AI 逐一裁决)

1. **"第一步调谁"**:核心策略第 5 条要求有锚点任务**先调 compiler_inspect**;conventions.md 要求
   **RepoMap before source**。两者都是"确定性工具先行",但在有索引的 MLIR 仓库中存在顺序竞争。
   候选方案:按任务类型路由(架构映射/pass 分析/pipeline 审计 → 工作流先行;其余锚点任务 →
   compiler_inspect 先行)——需要生产会话证据(analyze-session 可提供)支持后再改 policy 文本。
2. **重复调用风险**:compiler_inspect 的 definitions/references/tests 与 `pass` dossier、`symbol`、
   `tests` 查询在常见 pass 分析任务中重叠;两侧各有预算护栏,但组合策略(互补查询集)未被任何一方定义。
3. **新鲜度混合**:compiler_inspect 读实时工作树(永远新鲜);repomap 读索引快照(stale 需先 index)。
   组合使用时,证据的新鲜度来源应在输出中可区分。
4. **产物写入与最小补丁原则**:工作流会向目标仓库写 `docs/compiler-architecture/` 文档;这与 preset
   "语义最小补丁"不冲突(分析任务不改 pass 源码,goal 模板已明示),但 checkpoint/验证纪律是否适用于
   "纯文档产出"任务值得明确。
5. **域边界确认**:`mlir-compiler-harness` 本身不是 DeepSeek Harness,对它的开发/维护工作属于编译器
   工具域,留在 Compiler Dev 会话合规;只有修改 DeepSeek Harness/Cordis/DSH Web 时才触发 Creator-mode
   移交。
6. **policy/skill 文本的更新落点**:若采纳路由方案,需同步改三处且保持不重复——核心策略
   (compiler-inspect-v3-5.cjs 的 CORE_POLICY,注意热更新需重命名文件)、skill
   (skills/compiler-development/SKILL.md)、以及目标仓库契约;harness 侧 conventions.md 是其仓库的
   事实源,preset 侧不应复制其内容。

### 12.5 给下游 AI 的建议分析顺序

1. 先读第 3–4 章(工具契约)与 11.2(查询契约),建立两个接口的精确对照。
2. 用 12.3 的六个接面逐个评估成本/收益,注意接缝 1(契约通道)是其他接面的地基。
3. 对 12.4 的每个张力点给出裁决与所需证据类型(生产会话指标 / 对照实验 / 人工评审)。
4. 产出物建议:一份"任务类型 → 第一步工具 → 查询序列 → 证据合并规则"的决策表,以及对 preset 三个
   文本落点(policy/skill/契约模板)的具体修改草案。

---

## 13. Phase 2:Production Knowledge Observation Loop(2026-09-07 已实现)

> 第 12 章的接缝 2("repo 侧四个查询已存在,缺路由入口")由上一阶段的 `compiler_knowledge`
> 集成闭合;本章描述本阶段新增的**观测层**:让正常 CompilerDev 工作自动产生非敏感的
> architecture feedback evidence,不要求人工记录 case。反馈协议由 mlir-compiler-harness 拥有
> (`adapters/compiler-dev/feedback-schema.md` v2 / ADR-025 / workflow-contract.md);本 preset
> 只做 observation 与 candidate 生成。

### 13.1 分层事实(仍遵守第 10 章不变量)

```text
Agent Workflow(路由 + 查询 + 源码工作)          ← preset/compiler-knowledge-v3.cjs
Observation Plane(去敏 JSONL 流,gitignored)    ← driver 自动追加
Offline Plane(分析 / 候选 / 审核 / 汇总 / 导出) ← scripts/*.mjs,Node-only
Feedback Contract(协议与校验器)                ← mlir-compiler-harness(唯一事实源)
```

明确不做:在 CompilerDev 实现 compiler graph logic、自动写 mlir-repomap graph、自动改变 finding
status、把 Agent reasoning 当事实持久化、自动修改 mlir-compiler-harness。没有 candidate→curated
的自动晋级;没有从摘要到"应实现 Phase X"的自动推论。

### 13.2 Route decision(`compiler_route` 工具)

每个真实任务开始时,模型发一次 `compiler_route`:仅记录 route kind、`knowledge_expected`、
`confidence`、reason category(enum,禁止自由文本)、可选稳定 target id(如
`pass:hfusion-merge-vf`)——**不记录 prompt**。route kind 枚举:
`pass-review / finding-review / pipeline-audit / anchored-code-analysis / single-file-edit /
build-test / commit-pr / environment / git-operation / log-forensics / other`。保守路由:只有
high-confidence 的 pass/pipeline/finding 角度才 `knowledge_expected=true`;声明 skip 是正确结果
(与 v2 协议一致:`knowledge_expected=false` 且零调用不是 failure)。目标不是提高调用率,而是
**正确路由率**。always-on 策略段(order 115)承载该不变量,skill 承载判断细节(与 3.1/5 的分工
模式相同)。

### 13.3 Correlation 模型

- `correlation_id` = `k` + 16 hex 随机位,由 `compiler_route` 在任务开始时铸造;不含用户名、
  prompt、repo path 个人信息;不跨 session 猜关联。
- 插件内 per-agent(per-Session)状态保存当前 id(standing-scope 单次挂载,多 session 共享模块
  实例,故必须按 `exec.agent.id` 分键);任务切换 = 新 route = 新 id。
- 每次 `compiler_knowledge` 的查询记录与返回 envelope 的 `delivery.correlation_id` 都携带该 id:
  route 决策、查询流、离线分析器三方以 id 关联(会话日志里 route 调用与查询结果均可见 id,
  JSONL 流补充时长/大小/diagnostics 等运行面细节)。

### 13.4 Runtime 流(gitignored)

| 流 | 位置 | 一行记录 |
|---|---|---|
| 路由决策 | `analysis/feedback/routes/<date>.jsonl` | ts, correlation_id, route, knowledge_expected, confidence, reason, target? |
| 知识查询 | `analysis/feedback/queries/<date>.jsonl` | ts, correlation_id, command, name(target), repo, head, refreshed, duration_ms, result_chars, diagnostics, truncated, error |

查询流**禁止**记录:result body、source text、prompt、reasoning。写入均为 best effort,失败不影响
查询本身。运行时开销:一个 4 字段工具调用 + 每次查询一行 JSONL;观察层不注入 prompt 内容。

### 13.5 离线分析器与搜索分类(scripts/analyze-session.mjs 扩展)

- Route/adoption/temporal 指标见第 8 章。adoption 只按**已声明**路由计:eligible =
  `knowledge_expected=true` 的组;missed = eligible 且零次 knowledge 调用。未声明路由的查询归入
  ungrouped,不产生 adoption 结论。
- **搜索分类(precision 优先于 recall)**:对每个 bash 搜索/读取调用,以"该调用之前 knowledge/
  inspect 结果已返回的 file:line 指针集合"为参照:
  - `verification-read`:命令引用了已指针化的文件(如 query 返回 `foo.cpp:1406` 后
    `sed -n '1390,1420p' foo.cpp`)——契约允许的验证读取,不是 gap;
  - `discovery-search`:未命中指针的 repo 级 grep/rg/awk/find(如 query 后 `rg AttrName`
    全仓)——potential coverage gap 信号;
  - `uncertain`:产物/日志路径、生成树、无法判定者——报告但**绝不判 gap**。
- search-after-knowledge 只统计 discovery-search 且组内先有 knowledge 调用者;verification
  read 与 uncertain 单列。

### 13.6 离线闭环工具(全部 Node-only,stdlib)

| 脚本 | 输入 | 输出 |
|---|---|---|
| `collect-feedback.mjs` | session.jsonl[.zstd] + queries 流 | `analysis/feedback/candidates/`(gitignored)v2 candidate(`origin: automatic`) |
| `review-feedback.mjs` | candidate.json `--accept`/`--reject` | accept:校验→strip runtime 字段→`origin: curated`→写入 `analysis/feedback/`(可选 Python 校验器交叉核对);reject:移入 `candidates/rejected/`。**不自动 commit** |
| `summarize-feedback.mjs` | sessions + streams + candidates | 结构化计数摘要(仅 counts,无架构推论) |
| `export-feedback-bundle.mjs` | `--since` + 各流 | tar.gz bundle(manifest/summary/route-summary/query-summary/curated-feedback/,可选 counts-only candidate-summary);**不含 session transcript** |
| `regression-cases.mjs` | `cases/`(gitignored)+ `analysis/case-baseline.json` | 逐 case 重放对比;drift 非零退出;`--update` 重新背书 |

candidate 类型(保守定义):`query-sufficient`(positive evidence,刻意保留)、
`query-insufficient`(仅 `possible_gap`,不断言需要什么新 feature)、`adoption-missed`
(expected=true + confidence=high + 0 调用,`query: null`)、`query-operational`(stale/refresh/
not-found/truncation/diagnostics/error 信号)。未声明路由、status-only 组、正确 skip 一律不产 candidate。
隐私:bundle 导出 fail-closed——任一 staged 文件出现 prompt/messages/transcript/source-text/
credential 类 key、`/home/<user>` 绝对路径、私钥块或超大文件即中止导出且不留 bundle;报告只给
文件名与 key 名,不给值。测试用 `COMPILER_DEV_FEEDBACK_DIR` 重定向反馈根目录做全隔离。

### 13.7 案例回归(第 16 节要求的落地)

9 个 2026-09-05/06 生产会话(上一阶段案例报告的语料)放入 `cases/` 后经
`regression-cases.mjs` 重放:基线 `analysis/case-baseline.json` 只含指标数字(session 短 id +
counts),重放确定性通过;其中全部 9 个会话 `compilerKnowledgeCalls=0`(集成前基线)、
`compilerInspectCalls` 合计 11,与案例报告一致。旧 cases 由此成为**回归语料**而非持续手工维护的
case 来源。

---

## 14. Phase R1:Ripwire 通用代码上下文后端(2026-09-07 已实现)

> 目标:`compiler_inspect` 获得一个 **CodeContextProvider 接缝**,以 Ripwire
> (`redhat-et/ripwire`,zero-dependency C++23 CLI)为首选通用源码上下文提供者,保留原 rg/git 检索为
> legacy/回退,且不改动 mlir-compiler-harness、不新增第四个模型侧工具、不打破既有输出契约。
> 集成面刻意只取一个能力:`--pack-task --json`。

### 14.1 数据流

```text
compiler_inspect(input, backend?)
        |
        +-- backend policy: auto | ripwire | legacy      ← input > COMPILER_INSPECT_BACKEND > auto
        |
        +-- CodeContextProvider(仅通用源码检索交换)
        |       +-- ripwire   → compiler-context-backend.mjs
        |       |                 RIPWIRE_BIN → PATH;spawn 参数数组;--pack-task --json
        |       |                 --token-budget=5084(由 CompilerDev 预算推导,见 14.3)
        |       |                 --exclude=<dir>/(契约 exclude_dirs 逐个映射)
        |       |                 → normalizePackTaskResult → source_context + source_disclosures
        |       +-- legacy-rg → 原 collectDefinitions/References/Vendored/Tests(原样保留)
        |
        +-- CompilerArtifactProvider(与后端无关,always 运行)
        |       git 状态/diff/history + MLIR 日志取证(log_files)
        |
        +-- 观测:analysis/feedback/context/<date>.jsonl(每次源码检索尝试一行,去敏)
```

`auto`:Ripwire 可用即用;不可用/失败/弱结果 → 受控 legacy 回退,`fallback_reason` 取有限枚举
(`ripwire-not-found` / `ripwire-invocation-failed` / `ripwire-invalid-output` / `ripwire-timeout` /
`ripwire-weak-result` / `backend-policy-legacy`)。`ripwire`:显式请求,失败返回 degraded 结果
(`source_context.degraded=true, error=<reason>`),**绝不静默换 legacy**。`legacy`:强制 rg/git(A/B 与回归)。

### 14.2 契约演进(向后兼容)

- 输入新增可选:`backend`(enum auto/ripwire/legacy)、`task`(检索任务短语,可选,不入观测流)。
- 输出新增必填:`backend`(ripwire|legacy-rg)、`fallback`、`fallback_reason`、`source_context`(nullable)、
  `source_disclosures`(nullable;weak/ambiguous/truncated/counts_floor/各节 kept/total/budget 事实)。
- 既有字段全部保留且仍必填;legacy 路径下 `source_context=null`,行为与 v1.2 一致(VERSION 1.2→1.3)。
- 渲染:新增 `Context backend: <backend> (fallback: <reason|none>) | weak= … ambiguous= … truncated= …
  counts_floor= …` 一行(离线分析器按此聚合)与 Source context 节(标题明示
  "generic retrieval/ranking evidence — NOT an mlir-repomap semantic fact")。

### 14.3 预算映射(单一总预算,不叠天花板)

`MAX_TOTAL_CHARS=20000` 不变;通用上下文切片 12000 字符;Ripwire token 目标按其计价下限 ~2.36 B/token
推导:`--token-budget=5084` ⇒ 原始 JSON 天花板 ~11.8 KB,天然落在切片内;normalizer 再裁剪并披露每一次裁剪
(`bounding_notes`)。 Ripwire 自身的截断标记(ranking_capped / kept<total / bodies_omitted /
over_ceiling)原样映射进 `source_disclosures.truncated/counts_floor`,绝不吞掉。

### 14.4 AscendNPU-IR 语料边界(实测,2026-09-07)

- Ripwire 抓取自带内置目录黑名单(kCrawlSkipDirs:`third_party`/`build`/`out`/`target`/…,下划线拼写),
  且默认尊重 `.gitignore`;`build*/`(7G+2.9G)因此被剪。
- **实测差异**:`third-party/`(连字符,4.3G vendored)不在其黑名单 — 朴素抓取 >6min、RSS >12GB;
  契约 `exclude_dirs:["third-party"]` → `--exclude=third-party/` 后冷 ~2.2s / 热 ~1.2s。
  结论:契约 exclude_dirs 通道是 AscendNPU-IR 上的**必要项**,不是可选项。
- 锚点文件位于被抓剪目录时计 `outside_corpus` 并写入 Unresolved("not-retrieved ≠ absence"),
  同时对 vendored 类目录补一跳窄幅 legacy vendored pass;绝不由"Ripwire 无结果"推出语义不存在。
- 弱结果(ranking 为空)在 auto 下回退 legacy 并注明;显式 `backend:'ripwire'` 保留弱结果原样
  (`disclosures.weak=true`)供 A/B。

### 14.5 认知边界(硬不变量)

Ripwire 的一切输出都是**检索/排序证据**:1-hop caller 边是 name-based 近似;`ambiguous` 计数由返回行派生
(同名多文件)。Ripwire 结果不写 mlir-repomap 图、不改 finding、不自动成为 curated evidence、不进语义
SQLite;也不与 `compiler_knowledge` 做语义锚点融合(Phase R2 候选)。观测流与知识流仅共享 per-agent
correlation id(`compiler-observation-state.mjs`,进程内 Map,opaque id),无任何语义耦合。

### 14.6 验证与回归

- 单测 `scripts/test/compiler-context-backend.test.mjs`(28 项):二进制发现/缺失/失败/abort、显式 legacy、
  auto 回退、显式 ripwire 不静默换 legacy、成功 JSON 规范化、弱/歧义/截断/ floors 保留、越界裁剪披露、
  非 JSON 输出、契约排除映射、outside_corpus、log 取证不受影响、schema/渲染契约、观测流隐私与聚合;
  Ripwire 以 stub 二进制注入,不依赖真实安装。
- 全套 85 测试通过;`regression-cases.mjs` 9/9 基线无漂移(旧会话零 Ripwire 调用 = 诚实基线,不回填)。
- 真实仓库 A/B(AscendNPU-IR,backend 由输入选择):A=MergeVecScope、B=AutoVectorizeV2、
  C=RegBase pipeline builder;Ripwire 热态 ~2.4-2.5s / 5.3-7.5KB bundle,legacy ~1.4s / 4.4-5.8KB;
  两后端均零回退、输出有界。细节见实现报告与 `analysis/feedback/context/` 观测流(快照已留存报告内)。

### 14.7 文件清单(Phase R1 增改)

| 文件 | 变更 |
|---|---|
| `compiler-context-backend.mjs` | **新增**:CodeContextProvider(发现/生成/规范化/预算/观测) |
| `compiler-observation-state.mjs` | **新增**:per-agent correlation id 共享注册表 |
| `compiler-inspect-driver.mjs` | v1.3:backend policy + provider 分支 + 新输出字段 + 观测 |
| `compiler-inspect-v3-5.cjs` | 由 v3-3 改名扩展(R1:schema/renderer/240s guard;R1.5 rollout 默认随之再改名):schema/renderer/240s guard/`?v=1.4` |
| `compiler-knowledge-v3.cjs` | 由 v2 改名:route 铸造 id 时同步发布到共享观测状态 |
| `agent.cordis.yml` | 两行指向新插件文件名 |
| `scripts/analyze-session.mjs` | backend 分解 / fallback 原因 / weak 计数 |
| `scripts/test/compiler-context-backend.test.mjs` | **新增** 28 项测试 |

---

## 15. Phase R1.5:Production Canary 与晋升证据闭环(2026-09-07 已实现)

> R1.5 不改两个引擎,只加强 compiler-dev-harness 的**观测与发布平面**:把 R1 的
> "Ripwire 技术上可用"推进到"拥有可复核的生产证据通道"。

### 15.1 Rollout 语义(R1.5 原状;R1.7 已将默认改为 auto,见第 16 章)

```text
input backend  >  COMPILER_INSPECT_BACKEND  >  REPOSITORY_DEFAULT_BACKEND_POLICY
(显式诊断)        (诊断覆盖)                    (R1.5 时 = legacy;R1.7 Gate B 起 = auto)
```

- R1 的矛盾已消除:此前 `auto` 是缺省,装上二进制即切流量,与 `KEEP_RIPWIRE_EXPERIMENTAL` 相悖。
  R1.5 曾将仓库默认改为 **legacy**;`ripwire` = 显式实验;`auto` = 显式能力型 A/B 实验
  (Ripwire 可用即用、失败受控回退)。常量 `REPOSITORY_DEFAULT_BACKEND_POLICY`
  (compiler-context-backend.mjs)即发布开关:**变更默认 = 一次经评审的提交**,绝不是安装二进制。
- 无百分比灰度、无随机路由、无模型/身份参与分配;每次调用的实际 backend 与 fallback 原因
  在结果、渲染文本与观测流三处始终可见。驱动 VERSION 1.3→1.4(默认值属检索协议行为)。
- **R1.7 更新**:R1.6 修正并钉住归因正确性(Gate A)之后,该常量已改为 `auto`(Gate B,
  驱动 VERSION 1.5)。本节保留 R1.5 时的语义作为历史记录。

### 15.2 证据闭环数据流

```text
Production Task
      |
      v
compiler_route
      |
      +---- compiler_knowledge
      |
      +---- compiler_inspect
                |
                +-- experimental backend policy (default legacy; ripwire/auto explicit)
                |
                +-- context observation (analysis/feedback/context/, counts only)
      |
      v
session analyzer
      |
      +-- discovery-after-knowledge
      +-- discovery-after-inspect      (ordering only, never causality)
      +-- verification-after-inspect
      +-- backend / fallback / weak (session- and route-level)
      |
      v
counts-only summary (summarize-feedback --context)
      |
      v
context-summary.json (bundle export; raw stream never ships)
      |
      v
evaluate-context-backend.mjs (per-provider objective metrics, observational)
      |
      v
human promotion review
```

**明确声明:无自动晋升;无语义图写入;无自动 R2 触发。** 评述比较是观测性的
(会话不是受控实验);配对比较刻意不实现(拒绝从 prompt 猜配对)。

### 15.3 分析器新增语义(Workstream C)

- `discovery-after-inspect`:同一 route 窗口内,一条 discovery 搜索发生在某 `compiler_inspect`
  结果之后(按 seq 排序,归属最近一次结果的 backend)。**只表示时序**,不表示 Ripwire 失败;
  与 `discovery-after-knowledge` 同为 coverage-gap 信号。
- `verification-after-inspect`:同一窗口内,指向 inspect 已返回文件的验证读取发生在结果之后
  —— 通常是证据被使用的正面信号。
- route 组新增:`inspectCalls / inspectBackends / inspectFallbacks / inspectWeakResults /
  firstInspectStep / discoveryAfterInspect / verificationAfterInspect`;会话级新增
  `searchAfterInspectByBackend`(按最近先行结果归属)。uncertain 搜索永不进入 after-inspect 计数;
  无 route 声明的 inspect 调用诚实保持 ungrouped;旧会话无 Context backend 行 → 零/未知,不回填。

### 15.4 汇总与导出(Workstream D/E)

- `summarize-feedback.mjs`:`--context <dir>`;新增 `context` 节(total/by_provider/by_policy/
  fallbacks/fallback_reasons/weak/truncated/outside_corpus/total_duration_ms/total_result_chars)
  与 `search.discovery_after_inspect / verification_after_inspect`;依旧 counts-only。
- `export-feedback-bundle.mjs`:新增 counts-only `context-summary.json`;**原始 context/*.jsonl
  永不入包**;manifest 自动列出;既有 fail-closed 隐私扫描覆盖全部暂存文件。

### 15.5 晋升门槛(文档化,不自动执行)

- **候选晋升**:足够数量的真实编译任务上——回退率与弱结果率低;语料排除在契约下受控;
  上下文/工具体积无明显回归;discovery-after-inspect 不劣于 legacy 且趋于更低;
  无反复的必备符号/文件检索缺失;无正确性或工作流回归。
- **维持实验**:样本不足;Ripwire/legacy 互有胜负;反复回退;大量截断;discovery 未见减少。
- **拒绝**:系统性缺失实现上下文;不可接受的延迟/资源;持续性语料不兼容;工作流质量退化。
  不设无证据的数值阈值;判定由人复核。

### 15.6 离线评述工具(Workstream F)

`scripts/evaluate-context-backend.mjs --sessions <log...> [--context <dir>] [--since] [--output]`:
按 provider 输出 objective counts(调用/回退/弱/截断/外语料、时延/体积、discovery-after-inspect、
首检先于首编辑等),自带诚实性声明(观测性比较、无因果、无评分、无决定)。

---

## 16. Phase R1.6 + R1.7:归因完整性与 auto-by-default 生产发布(2026-09-07 已实现)

> R1.6 先让证据可信(归因正确性),R1.7 才把默认切到 `auto`(零决策的日常工作流)。
> 顺序不可逆;两个内部 Gate 均以测试钉住。

### 16.1 确认并修复的归因缺陷(Gate A)

R1/R1.5 的 v1 观测记录把"提供者尝试"折叠进"实际服务的提供者":auto→Ripwire 失败→legacy 兜底
会被记成 `provider=legacy-rg, fallback=true, fallback_reason=…` —— Ripwire 尝试的结果、时长与体量
全部丢失;显式 Ripwire 失败的 degraded 调用甚至记成 `provider=ripwire`(实际上什么都没服务)。

**Context Observation Protocol v2**(`schema_version: 2`)把四层独立事实分开:

```text
1. requested policy   backend_policy = auto | ripwire | legacy
2. provider attempts  attempts[]: { provider, outcome, reason?, duration_ms, result_chars, weak?, truncated? }
                      outcome ∈ served | weak | error | timeout | invalid-output | not-found
                      (复用 fallback-reason 词表,单一失败分类法;绝不存 stderr)
3. delivered context  served_provider = ripwire | legacy-rg | null;delivery_state = served | fallback | degraded
4. post-delivery      会话分析器按 SERVED backend 归属(见第 15.3 节)
```

硬规则:**尝试可靠性按尝试的 provider 分组;交付与交付后的行为按服务的 provider 分组**。
`auto → Ripwire error → legacy served` = Ripwire error +1、legacy served +1,**绝非 legacy error**
(该中心回归由测试逐字钉住)。成本语义:`attempt.duration_ms` 只计一个 provider 边界
(Ripwire = pack-task 子进程;legacy = rg 收集块);`total_duration_ms` 是整次 compiler_inspect 调用
(git/history/diff/日志取证/渲染含入);`delivery_result_chars` 是最终渲染工具体——唯一可跨
provider 比较的尺寸;attempt `result_chars` 是 provider 边界尺寸(Ripwire=原始 JSON;legacy=渲染包),
**不跨 provider 比较**。显式 Ripwire 失败:`backend='none'`、`delivery_state='degraded'`、
渲染 `Context backend: none (… | delivery=degraded: <reason>)` —— 绝不宣称有 provider 服务过。
v1 历史文件不改写;`normalizeContextObservation()` 在聚合/评述侧恢复逻辑 v2(仅在有据可推时推断,
否则 unknown)。

### 16.2 auto-by-default 数据流(Gate B)

```text
normal compiler task
       |
       v
compiler_route
       |
       +-- compiler_knowledge            (mlir-compiler-harness, unchanged)
       v
compiler_inspect — default policy = auto
       |
       +-- Ripwire attempt (--pack-task --json)
       |       +-- success ---------------+
       |       +-- failure / weak         |
       |               |                  |
       |               v                  |
       |           legacy fallback        |
       +----------------------------------+
                   |
                   v
            served context (one bounded bundle; backend + delivery_state + fallback reason disclosed)
                   |
                   v
             Agent behavior
                   |
          +--------+--------+
          |                 |
          v                 v
 attempt telemetry     session analysis
 (context JSONL v2)    (served-backend attribution)
          |                 |
          +--------+--------+
                   |
                   v
            promotion evidence (human review)
```

明确声明:**attempt reliability ≠ delivered-context effectiveness;fallback 失败归属尝试的
Ripwire;交付后的行为归属实际服务的 provider;auto 是正常工作流,legacy 是兜底/控制后端;
显式 ripwire 保持严格(失败即 degraded,绝不静默换 legacy);无自动 R2**。不实现 shadow paired
execution、百分比/随机/身份路由;不新增模型侧工具;不新增 Ripwire 动词;发现
`discovery-after-Ripwire` 或 `outside_corpus>0` 属高价值观察,由人复核,绝不自动成为实现需求。

### 16.3 未来决策树(仅文档,不实现)

```text
production evidence
      +-- Ripwire reliable + useful        → keep auto/default
      +-- repeated generic retrieval gaps  → improve Ripwire adapter / normalization
      +-- repeated semantic-anchor gaps    → consider R2 Semantic Anchor Fusion
      +-- evidence too ambiguous           → consider paired shadow evaluation
```

---

## 17. Phase T1:通用 Code Explanation / Teaching 能力(2026-09-08 已实现)

目标:让"解释/梳理/讲给他人/slides 前置材料"这类请求进入**同一个**通用 workflow,而不是按 subject 重新设计 harness。职责边界保持:mlir-compiler-harness/Ripwire/git = 确定性证据;本 preset = 理解 + 验证 + 解释;presentation 系统 = storyboard/排版/slides(本仓库不做排版)。

### 17.1 分层(确定性半区 vs 推理半区)

```text
compiler_explain plan        → subject 骨架 + evidence 计划 + 扩展字段 + readiness 清单 + 受众问题(确定性)
compiler_inspect / compiler_knowledge / git / 测试运行 → 事实(source/graph/runtime/historical fact)
agent reasoning              → mechanism stages(源自源码推导)、mental_model、why、context、decisions、
                               storyline、visual specs(semantic only)、semantic review 判词
compiler_explain validate    → schema + evidence discipline(引用可解析、fact/reasoning 不混淆)(确定性)
compiler_explain readiness   → 机械 readiness 门 + 记录 semantic review(确定性检查 + 人工判词落盘)
compiler_explain stale       → provenance HEAD / source-file sha256 对比(确定性)
```

### 17.2 Artifact 模型(Teaching Artifact Protocol v1)

Bundle:`analysis/explanations/<date>-<slug>-<type>/{subject,evidence,dossier,handoff,readiness}.json`(curated 后作为案例数据提交;与 feedback 协议同类所有者)。核心抽象:

- **AnalysisSubject**(`subject.json`):`subject_id/subject_type/name/repository/source_locations/scope/related_entities/why_this_subject` + 完整 provenance(repository/branch/HEAD/analyzed_at/tool_versions/runtime_verification/source_files sha256)。
- **Evidence ledger**(`evidence.json`):七类陈述(source_fact/graph_fact/runtime_fact/historical_fact/reasoning/hypothesis/unknown),source_fact 强制 refs、graph_fact 强制 tool/command、historical_fact 强制 commit/refs——class 的语义由其工具负担保证。
- **TeachingDossier**(`dossier.json`):common core(mental_model、need/responsibility/observable_outcome、system_context 上下游因果、inputs/outputs、mechanism.stages 源码推导、implementation/conceptual 双视图、canonical_example(test>production>probe>reconstructed)、state_transitions、decisions、strategies+comparisons(≥2 才允许)、contracts、constraints/invariants/assumptions(status)、boundaries(六类、必须引用证据——"没看到"是 unknown 不是 unsupported)、placement(可 not_applicable)、ownership、complexity、key_takeaways)+ **恰好一个**匹配 subject_type 的 extension(pass/function/algorithm/class/subsystem/pipeline/data_structure/module/workflow/component_group)。
- **PresentationHandoff**(`handoff.json`):adaptive storyline(role 自由文本,禁止固定 pass 叙事)、learning_objectives、semantic visual specs(12 种 kind;nodes/edges/groups/ordering;出现 x/y/width/height/color 等布局键即校验失败)、must/optional visuals、bounded evidence_index。**Handoff ≠ Slides**。
- **ReadinessReport**(`readiness.json`,工具写出):READY ⇔ 机械门通过 ∧ semantic review 已记录且判 ready(10 个通用受众问题 + 类型自适应问题全部 sufficient)∧ 未 stale。字段齐全永远不等于 READY(§30/§31 的结构化编码)。

### 17.3 防 Pass 中心与防过拟合(硬不变量)

- `pipeline_position/legality/before_ir/after_ir/pass_option/attribute_*` 只存在于 `pass` extension;common core 无一涉及。
- Extension registry(`EXTENSION_KEYS`)是唯一按类型分支的表;readiness 的类型检查同样只查匹配 type 的 extension。新增 subject 类型 = 增一行 registry,零特殊分支。
- 通用层(schema/tool/validator/skill)不得出现任何具体 subject 概念(MergeVecScope、VF、scheduler、buffer 等);它们只能存在于 artifact 数据(案例数据)中。
- 无可解释内容时 readiness 拒绝(无 mental_model、无 fact 证据、声明 branching 却无 decisions 等),不允许用占位内容凑齐字段。

### 17.4 文件清单(Phase T1 增改)

| 文件 | 内容 |
|---|---|
| `scripts/teaching-schema.mjs` | 协议 v1 validators + 机械 readiness 门 + staleness(纯函数,无 I/O) |
| `compiler-explain-driver.mjs` | plan/validate/readiness/stale 实现(bundle IO、git spawn、env `COMPILER_DEV_EXPLAIN_DIR`) |
| `compiler-explain-v1.cjs` | 本地 Cordis 插件:`compiler_explain` 工具 + always-on code-explanation 段(order 116) |
| `skills/code-explanation/SKILL.md`(+`references/teaching-artifact-guide.md`) | 条件性 workflow 指南 + 字段手册 |
| `scripts/test/teaching-schema.test.mjs`、`scripts/test/compiler-explain.test.mjs`、`scripts/test/teaching-dogfood.test.mjs` | 43 + 12 + 10 项测试(schema/可选字段/readiness/semantic 门/staleness/工具面/dogfood 语义回归 + generic 层反过拟合扫描) |
| `agent.cordis.yml` | 新增 `compiler-explain` row |
| `analysis/explanations/…`(dogfood) | 案例数据:`2026-09-08-mergevecscope-pass/`(Case A,pass,presentation,READY)、`2026-09-08-memref-alias-state-class/`(Case B,class,standard,READY) |

与既有能力的边界:不重新实现 call graph/pass graph/attribute index/git history(消费 `compiler_knowledge`、`compiler_inspect`、git);不做 PPT renderer/图布局(visual spec 止于语义);feedback 协议与观测闭环保持原样(explain 任务经 `compiler_route` 以 `anchored-code-analysis`/`other` 声明)。

---

### 附录:事实来源

- Preset:`preset.yml`、`agent.cordis.yml`、`compiler-inspect-v3-6.cjs`、`compiler-inspect-driver.mjs`(v1.5)、
  `compiler-context-backend.mjs`(v1.2,rollout 默认常量 + 观测协议 v2 + v1 规范化)、`compiler-observation-state.mjs`、
  `compiler-knowledge-v3.cjs`(`compiler_route` + `compiler_knowledge` + 路由段)、`compiler-knowledge-driver.mjs`
  (v2.0,correlation/diagnostics/truncation 标注)、`skills/compiler-development/SKILL.md`、
  `REPOSITORY_CONTRACT_TEMPLATE.md`(R1.5 增 source-context exclusions)、`scripts/analyze-session.mjs`、
  `scripts/{feedback-schema,collect-feedback,review-feedback,summarize-feedback,export-feedback-bundle,
  regression-cases,evaluate-context-backend}.mjs`、`scripts/test/`
  (6 个测试文件 + fixtures)、`analysis/case-baseline.json`、`README.md`、`analysis/2026-09-06-case-feedback-analysis.md`
  (案例反馈分析报告,v1.2 改动的依据)、`analysis/2026-09-07-knowledge-integration-validation.md`、
  `analysis/2026-09-07-phase2-observation-loop.md`(Phase 2 实施与验证记录)、
  `analysis/2026-09-07-phase-r1-ripwire-context-backend.md`(Phase R1)、
  `analysis/2026-09-07-phase-r1-5-ripwire-production-evidence-loop.md`(Phase R1.5)、
  `analysis/2026-09-07-phase-r1-6-r1-7-context-attribution-auto-rollout.md`(Phase R1.6+R1.7)、
  `analysis/2026-09-08-phase-t1-teaching-explanation.md`(Phase T1:teaching 能力实施与 dogfood 报告)、
  `analysis/explanations/2026-09-08-*`(dogfood bundle:subject/evidence/dossier/handoff/readiness)。
  Phase R1 的实现依据另见
  上游 `redhat-et/ripwire`(c7914e8dc8429a318ffe24f857077e2b1d52d62e)`src/packtask.h`、`src/ingest.h`、
  `docs/COMMANDS.md` 与第 14 章实测记录。
- Harness:`docs/architecture/{overview,query-api,schema,status}.md`、`docs/workflows/{repo-map,pass-analysis,pipeline-audit}.md`、
  `docs/goal.md`、`adapters/{README,deepseek-harness/README,deepseek-harness/conventions}.md`、
  `adapters/deepseek-harness/goal-templates/pass-analysis-goal.md`、`adapters/zcode/`、
  `repomap/pyproject.toml`、`repomap/src/mlir_repomap/{query,cli}.py`(pipeline_stages 落地核实)。
