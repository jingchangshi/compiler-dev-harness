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
- `description: Standard coding capabilities with bounded compiler evidence, human Repository Contracts, and disciplined verification.`

目录结构:

| 文件 | 角色 |
|---|---|
| `preset.yml` | preset 元数据(name/description) |
| `agent.cordis.yml` | **agent-plane 组成**:挂载哪些插件/工具/提示段(第 2 章) |
| `compiler-inspect-v3-1.cjs` | 本地 Cordis 插件:always-on 核心策略段 + `compiler_inspect` 工具(第 3 章) |
| `compiler-inspect-driver.mjs` | 检索驱动,被插件 in-process import(第 4 章) |
| `skills/compiler-development/SKILL.md` | preset 本地 skill:条件性详细指南(第 5 章) |
| `REPOSITORY_CONTRACT_TEMPLATE.md` | 人类维护的仓库契约模板(第 6 章) |
| `scripts/analyze-session.mjs` (+`scripts/test/`) | 离线会话日志分析器,非模型侧(第 8 章) |
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
| compiler | `compiler-inspect` → `./compiler-inspect-v3-1.cjs` | 只贡献提示段 + 工具,消费 host 服务,不发布服务,无 realm(第 3 章) |
| 其余 | `tool-ask-user`、`tool-todo`(`allowParallelInProgress: true`)、`tool-web`(`fetch: false`,`searchTimeoutMs: 60000`) | web 服务与搜索 provider 在 host |

**Preset 明确不挂载**:LSP、hooks、notebook/view 等非标准工具;web fetch 被关闭(仅保留 search)。
条件禁用走 `!!js` 表达式(仅 shell 两行,按平台二选一)。

## 3. compiler-inspect 插件(compiler-inspect-v3-1.cjs)

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
- **driver in-process 运行**:`import(new URL('./compiler-inspect-driver.mjs?v=1.1', file://__filename))`。
  设计理由:driver 是固定、只读(git/rg)、参数不落 shell 的脚本,in-process 比 shell/沙箱往返少一类
  失败模式且不损失封闭性。60s AbortController 兜底,并透传工具调用的 abort 信号。
- URL 的 `?v=1.1` 用于击穿 host 进程的 ESM 模块缓存(见第 9 章)。

> 命名澄清:文件名 `v3-1` 是插件文件的演进代号;driver 内 `VERSION = '1.1'` 是检索协议版本,
> README 与工具描述均称 v1.1。两套编号并存,勿混淆。

## 4. `compiler_inspect` 接口契约(v1.1)

### 4.1 输入参数

| 参数 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `repo_root` | string | `process.cwd()` | 仓库根;缺 `.git` 时回退 `git rev-parse --show-toplevel`(子目录锚点可用) |
| `files` | string[] | `[]` | 文件锚点;根外路径被过滤,绝对路径转为相对展示 |
| `symbols` | string[] | `[]` | 符号锚点;去重后截前 12 个 |
| `history_window` | int | 6 | git log 窗口,1–30,越界抛错 |
| `include_tests` | bool | true | 是否检索覆盖测试 |
| `include_diff` | bool | true | 是否含工作树 `git diff --stat` |
| `contract_test_dirs` | string[] | `[]` | **来自 Repository Contract** 的测试目录;替换默认 test glob |
| `exclude_dirs` | string[] | `[]` | 追加到默认排除目录(默认排除:`.git`、`node_modules`、`dist`、`build`、`out`、`target`、`.cache`、`__pycache__`、`.venv`/`venv`、`.mypy_cache`、`.pytest_cache`、`.cxx`) |

### 4.2 检索管线(单次调用、一次往返)

1. Git 状态:`branch --show-current`、`status --short`(前 8 条);非 Git 工作树记入 `unresolved`。
2. **定义检索**(batched):符号集合拼成一条 ripgrep 交替正则,两遍——关键字声明形
   (`class|struct|union|enum|... name` / `name\s*[:=]`),`--max-count 6`、`-C 2` 上下文。
   排序规则:锚点文件内 match 行 > 其他文件 match 行 > 锚点文件上下文行 > 其他上下文行,同秩稳定。
   取前 10 条(`MAX_DEFINITION_ITEMS`)。
3. **引用检索**:`\b(symbols)\b` 单遍 batched,`--max-count 8`,取前 12 条。
4. **Vendored 回退**:仅当符号在非 vendored 树零匹配时,在 `third_party|3rdparty|vendor|external|submodules`
   内补查,取前 4 条;并写入 `unresolved` 提示"证据可能来自 vendored 树"。include/vendor glob 顺序利用
   ripgrep last-glob-wins 保证 vendored 默认被排除。
5. **测试匹配**:`contract_test_dirs` 非空则用它,否则默认 glob(`**/*test*` 等);取前 8 条。
6. **工作树变更**:`git diff --stat`(锚点文件或全仓库),取前 12 条。
7. **历史**:`git log -N --format='%h %s' -- <files| .>`;另对前 3 个符号做 `-S` pickaxe(各取 4 条)。
8. **Unresolved 诊断**:无显式锚点、符号零匹配(拼写/生成代码/实现专属名)、vendored 命中等,显式列出。

### 4.3 预算与输出

- 行级:每条 ≤280 字符(`MAX_LINE_CHARS`);每节 ≤12 条(`MAX_ITEMS`,定义节 10)。
- **总量硬预算 20000 字符**(`MAX_TOTAL_CHARS`):超限时按 References → History → Tests → Definitions
  优先级对最大节对半裁剪,`budget.truncated = true`。
- 输出 schema:`repository{root,branch,dirty}`、`anchors{files,symbols}`、`definitions[]`、
  `references[]`、`vendored_matches[]`、`tests[]`、`changes[]`、`history[]`、`unresolved[]`、
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
   `exclude_dirs`——契约约束进入 bundle 而不复制契约。bundle 是线索;`Vendored matches` 或 truncation
   标记 = 证据不完整,应收窄锚点而非扩大搜索。"最近 N commits"是搜索地平线。
2. **Repository Contract**:权威次序 = 人类契约 > 项目指令 > 源码 > 相关历史 > 推断。先读契约再做任何
   环境/构建/测试发现;契约命令只在用点验证,不换成推断流程。无契约时只发现本任务所需事实。
   **绝不持久化推断出的操作事实**;有用 workaround 以候选契约更新提议给人;仅当人类要求时才用模板起草。
3. **Checkpoint**:一行 `Decision; Evidence; Uncertainty; Patch implication`,在三个时机取——设计敏感
   编辑前、大型发现移交实现时、结论稳定后的长验证前。目的是**在 compaction 中存活**(摘要保留工程状态
   而原始证据被遮蔽)。是证据边界不是数据库;琐碎读取后不发仪式性 checkpoint。
4. **验证**:先窄验证,有理由才跑仓库规定的更广检查。失败四分类;疑似无关阻塞最多一次聚焦对照实验,
   证明无关后记录(阻塞、证据、它阻止了什么验证)并继续不受影响的检查;不为凑绿改环境/依赖文件。
5. **混合/域外工作**:混合请求按内部工作包分组,证据充分的包先行。Harness/preset/Cordis/Web/运行时
   基建工作移交 fresh Creator-mode 会话,交接带简短观察总结。

## 6. Repository Contract(人在回路)

`REPOSITORY_CONTRACT_TEMPLATE.md` 的字段:仓库身份/主分支、主编译器子系统、环境初始化(shell/Python/conda/
工具链/设备)、规范与增量构建命令、验证命令(fast/default、Python、MLIR-lit-FileCheck、C++、host-only、
加速器必需)、格式化/lint、**仓库边界**(禁改/禁广探目录、生成或 vendored 目录)、子模块策略、已知环境约束、
已知支持的 workaround、**do-not-rediscover 规则**(必须复用而非从构建文件/CI/脚本重新推导的事实)。

机制要点:

- 契约字段完成后即权威,只在用点验证。
- 每任务都用的事实放 AGENTS.md;更大的子系统材料放项目本地 skill/参考;不复制。
- `contract_test_dirs` 与 `exclude_dirs` 是契约进入 `compiler_inspect` 的两个参数通道(见 4.1)。
- agent 永不静默持久化推断事实;新 workaround 作为候选人类更新上报。

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
model steps、tool calls 按名分布、**`compiler_inspect` 调用数与首次出现 step**、skill 加载失败数、
token 记账(input/output/cacheRead)、**峰值请求上下文及 step**、首个 edit/write step、工具结果总量与
超 8KB 计数及最大 5 条、compaction 启停/错误数、per-turn 明细。

用途:preset 变更以真实生产会话数据评判(如早期压缩策略就源自该分析器对四个会话的审计)。

## 9. 运维细节(热更新)

- host 进程按文件 URL 缓存 preset 插件模块,生存期为进程生命周期:
  - 改 `compiler-inspect-v3-1.cjs` → **重命名文件**并同步组成行;
  - 改 `compiler-inspect-driver.mjs` → **bump 插件 import 的 `?v=` 查询**;
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
   (compiler-inspect-v3-1.cjs 的 CORE_POLICY,注意热更新需重命名文件)、skill
   (skills/compiler-development/SKILL.md)、以及目标仓库契约;harness 侧 conventions.md 是其仓库的
   事实源,preset 侧不应复制其内容。

### 12.5 给下游 AI 的建议分析顺序

1. 先读第 3–4 章(工具契约)与 11.2(查询契约),建立两个接口的精确对照。
2. 用 12.3 的六个接面逐个评估成本/收益,注意接缝 1(契约通道)是其他接面的地基。
3. 对 12.4 的每个张力点给出裁决与所需证据类型(生产会话指标 / 对照实验 / 人工评审)。
4. 产出物建议:一份"任务类型 → 第一步工具 → 查询序列 → 证据合并规则"的决策表,以及对 preset 三个
   文本落点(policy/skill/契约模板)的具体修改草案。

---

### 附录:事实来源

- Preset:`preset.yml`、`agent.cordis.yml`(307 行,含归属理由注释)、`compiler-inspect-v3-1.cjs`(77 行)、
  `compiler-inspect-driver.mjs`(321 行)、`skills/compiler-development/SKILL.md`(37 行)、
  `REPOSITORY_CONTRACT_TEMPLATE.md`(65 行)、`scripts/analyze-session.mjs`(367 行)、`README.md`。
- Harness:`docs/architecture/{overview,query-api,schema,status}.md`、`docs/workflows/{repo-map,pass-analysis,pipeline-audit}.md`、
  `docs/goal.md`、`adapters/{README,deepseek-harness/README,deepseek-harness/conventions}.md`、
  `adapters/deepseek-harness/goal-templates/pass-analysis-goal.md`、`adapters/zcode/`、
  `repomap/pyproject.toml`、`repomap/src/mlir_repomap/{query,cli}.py`(pipeline_stages 落地核实)。
