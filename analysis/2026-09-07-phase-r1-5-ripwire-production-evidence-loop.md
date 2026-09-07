# Phase R1.5 实施报告:Ripwire 生产 Canary 与晋升证据闭环

日期:2026-09-07 · 起始 HEAD:`71aa7fe4cfee7b5bf42d1509a7a6987fff641bb2`(main,与 origin 同步)

## A. Repository state

- 起始 HEAD:`71aa7fe4cfee7b5bf42d1509a7a6987fff641bb2`
- 最终 HEAD / 推送 SHA:见提交记录(R1.5 单一提交序列,推送后以 `git ls-remote origin refs/heads/main` 核对一致)
- 变更文件(实现 + 文档 + 测试 + 报告):
  - `compiler-context-backend.mjs`(v1.0→v1.1:rollout 默认常量 `REPOSITORY_DEFAULT_BACKEND_POLICY='legacy'`)
  - `compiler-inspect-driver.mjs`(v1.3→v1.4:默认策略语义;backend 模块 import 加 `?v=1.1`)
  - `compiler-inspect-v3-4.cjs` → **`compiler-inspect-v3-5.cjs`**(改名,随描述/默认值变更;`?v=1.4`)
  - `agent.cordis.yml`(行指向 v3-5)
  - `scripts/analyze-session.mjs`(after-inspect 计量 + route 组字段 + backend 归属 + 报告行)
  - `scripts/summarize-feedback.mjs`(`--context` + context 节 + search 扩展;导出 `jsonlRecords`)
  - `scripts/export-feedback-bundle.mjs`(`context-summary.json` + `CONTEXT_DIR`)
  - `scripts/evaluate-context-backend.mjs`(**新增**)
  - `scripts/test/context-evidence.test.mjs`(**新增**,18 项);`scripts/test/analyze-session.test.mjs`(报告行断言更新)
  - `REPOSITORY_CONTRACT_TEMPLATE.md`(source-context exclusions 节)
  - `README.md`、`ARCHITECTURE.md`(§15 + 一致性修正)、本报告

## B. Repository audit 发现的具体缺口(改动前)

1. **实验态/默认值矛盾**:R1 的 `resolveBackendPolicy` 缺省为 `auto` —— 只要安装 ripwire 二进制,生产流量即切至 Ripwire,与 R1 报告的 `KEEP_RIPWIRE_EXPERIMENTAL` 直接矛盾(工具描述还写明 "auto (default)")。
2. **观测流未入闭环**:`summarize-feedback.mjs` 无 context 聚合与 `--context` 参数;`export-feedback-bundle.mjs` 无 context 工件。
3. **缺 discovery-after-inspect**:分析器只有 `discovery-after-knowledge`;inspect 结果的指针虽参与搜索分类,但"inspect 之后"的时序归属完全缺失,route 组无任何 inspect 字段。
4. **晋升证据无载体**:没有任何离线面能按 provider 比较 objective metrics。
5. **Repository Contract 缺口**:模板没有 source-context exclusions 节,`third-party/`(连字符)类目录无契约通道(仅存在于 R1 报告文字)。
6. **文档漂移**:README 仍写 `compiler-knowledge-v2.cjs`;ARCHITECTURE 多处仍写 v3-3/v2;热更新说明缺 backend 模块的 `?v=` 规则。

## C. Architecture implemented

```text
Production Task
      |  compiler_route (correlation id)
      +-- compiler_knowledge          (mlir-compiler-harness, unchanged)
      +-- compiler_inspect
            backend policy: input > COMPILER_INSPECT_BACKEND > REPOSITORY_DEFAULT('legacy')
            CodeContextProvider: ripwire(--pack-task --json, explicit/only capability) | legacy rg
            CompilerArtifactProvider: git/diff/history + MLIR log forensics (unchanged)
            context observation: analysis/feedback/context/<date>.jsonl (counts only, best-effort)
      v
session analyzer: backend/fallback/weak; discovery-after-{knowledge,inspect};
                  verification-after-inspect; per-route inspect fields
      v
summarize-feedback (--context) → counts-only JSON
      v
export-feedback-bundle → context-summary.json (raw stream never bundled, fail-closed privacy)
      v
evaluate-context-backend → per-provider objective metrics (observational, no decision)
      v
human promotion review (gate documented in ARCHITECTURE.md §15.5)
```

## D. Public behavior changes

- **缺省后端由 auto 改为 legacy(核心变更)**。不传 `backend` 时行为与 R1 之前一致(rg/git 检索),且不再有"装二进制即切流量"的隐式晋升。`backend:'ripwire'` 与 `backend:'auto'` 显式可选;`COMPILER_INSPECT_BACKEND` 优先级低于显式输入。无百分比灰度、无随机、无模型/身份路由;每次结果的 `backend`/`fallback`/`fallback_reason` 与渲染行、观测流三处一致可见。
- 驱动 `budget.version` 1.3→1.4;插件文件 v3-4→v3-5(热更新约定);工具描述同步改写。
- 兼容性:既有输入/输出字段全部保留;旧会话(无 Context backend 行)分析结果为零/未知,不产生回退解释。case 基线零漂移(9/9 ok)。

## E. Observation schema(非敏感字段;context 流)

`ts, correlation_id, backend_policy, provider, mode, duration_ms, result_chars, truncated, weak, fallback, fallback_reason, repo(basename), file_count, symbol_count, ranked_symbols, bodies, tests, outside_corpus`

禁止字段(运行时写入器与导出隐私扫描双侧把关):prompt/task 文本、源码体、Ripwire 原始输出、shell 命令、stderr、reasoning、绝对用户路径、凭据。写入保持 best-effort:遥测失败绝不使编译任务失败。

## F. Analyzer changes:精确定义

- **discovery-after-inspect**:同一 route 窗口内,一条分类为 `discovery-search` 的 bash 搜索,其 seq 晚于窗口内某次 `compiler_inspect` 结果的 seq。归属 backend = 该搜索之前最近一次 inspect 结果的 backend。**它只表示时序先后**,是 coverage-gap 信号,不构成"Ripwire 失败"或任何因果结论;uncertain 搜索不进入计数。
- **verification-after-inspect**:同一窗口内,指向 inspect 已返回文件的验证读取晚于该结果 —— 通常是返回证据被按契约使用的正面信号。同样只是时序。
- route 组字段:`inspectCalls/inspectBackends/inspectFallbacks/inspectWeakResults/firstInspectStep/discoveryAfterInspect/verificationAfterInspect`;会话级 `searchAfterInspectByBackend`、`inspectTruncatedResults`、temporal.`inspectBeforeSearch`。无 route 声明的 inspect 调用保持 ungrouped;无 backend 行的历史结果不参与归属。

## G. Tests

- 新增 `scripts/test/context-evidence.test.mjs`:18 项(rollout 4、分析器 10、流聚合 2、bundle 1、evaluation 1)。
- 全套:`node --test "scripts/test/*.test.mjs"` → **104/104 通过**(86 既有/更新 + 18 新增)。
- 回归:`node scripts/regression-cases.mjs` → 9/9 会话零漂移(基线未改:新字段为零默认值,旧语料无 Ripwire 调用即诚实基线)。

## H. Regression corpus

9 个 2026-09-05/06 会话重放与 `analysis/case-baseline.json` 完全一致;未回填、未重解释;`BASELINE_FIELDS` 未扩展(新分析器字段为零默认,不进基线)。

## I. Production evidence(严格分层,不混用)

1. **真实生产观测:无。** `cases/` 中不存在 post-R1 的 CompilerDev 生产会话(9 个均为 pre-R1)。未伪造、未声明生产晋升证据。真实 dogfood 是下一个运营步骤。
2. **真实仓库直接验证(AscendNPU-IR @ 90037fe33)**:R1.5 冒烟通过完整管线 —— 显式 `auto` + 真实 ripwire 二进制(Ripwire 服务,ranked 7 / bodies 4,~3.3s,观测行 provider=ripwire)与仓库默认(legacy 服务,~1.7s,backend_policy=legacy)两次真实驱动调用 → 会话分析器(after-inspect: verification 1,backend 归属 ripwire;inspect@3 先于 edit@6)→ summarize(context total 2, by_provider {ripwire:1, legacy-rg:1})→ evaluate(逐 provider 指标 + 诚实声明)→ bundle 导出(`context-summary.json` 计数正确,原始流未入包,fail-closed 隐私通过)。
3. **fixture/合成验证**:18 项新测试覆盖 §20 全部要求(rollout 优先级、分析器 10 场景、聚合/`--since`、bundle 导出与隐私、evaluation)。

## J. Remaining uncertainty

- **R2 是否正当:证据不足,暂不提议。** 唯一的 body 级调用点缺失案例(R1 Case A 的 `mergedFunc.verify`)仍是 n=1;`discovery-after-inspect` 与 `verification-after-inspect` 需要真实 dogfood 会话积累后才能判断此类缺口是否复现。
- 观测性配对 A/B(离线 pair manifest)未实现 —— 无真实配对数据,实现即投机;留待有真实配对需求时。
- `tests_to_run` 在 AscendNPU-IR 恒为 0 的机理仍未深究(诚实披露,不影响本阶段)。

## K. Next-stage decision

**READY_FOR_PRODUCTION_DOGFOOD**

依据:rollout 语义已诚实(默认 legacy,晋升=一次显式默认变更);证据闭环(观测流→分析器→汇总→导出→评述)已在真实仓库上端到端验证;104/104 测试、9/9 回归零漂移。缺的不是机制,而是真实生产会话数据 —— 下一步是在 Compiler Dev 日常工作中 dogfood(`backend:'ripwire'` 显式实验或设 `COMPILER_INSPECT_BACKEND`),积累观测流后由人复核晋升门槛;`READY_TO_PROPOSE_R2` 仅在真实证据出现后成立。
