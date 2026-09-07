# Phase R1.6 + R1.7 实施报告:上下文归因完整性与 auto-by-default 生产发布

日期:2026-09-07 · 起始 HEAD:`da07d46a12179490090b4af44d50e19b3829d538`(main,与 origin 同步,clean)

## A. Repository state

- 起始 HEAD:`da07d46a12179490090b4af44d50e19b3829d538`
- 提交:① `Phase R1.6: fix context provider attribution (observation protocol v2)`;② `Phase R1.7: make auto the default context backend`(两段式:先证据正确性,后发布决策)
- 最终推送 SHA:`ef7b3ee86ba4fedbf26956f8ba2a2e6da16c83c6`(`git rev-parse HEAD` 与 `git ls-remote origin refs/heads/main` 核对一致)
- 变更文件:`compiler-context-backend.mjs`、`compiler-inspect-driver.mjs`、`compiler-inspect-v3-5.cjs`→`v3-6.cjs`、`agent.cordis.yml`、`scripts/analyze-session.mjs`、`scripts/summarize-feedback.mjs`、`scripts/export-feedback-bundle.mjs`、`scripts/evaluate-context-backend.mjs`、三个测试文件、README、ARCHITECTURE(§15 历史标注 + 新 §16)、本报告

## B. Repository-first findings:归因缺陷确认(非假设)

逐字审计 R1/R1.5 实现(`contextObservationRecord` 与驱动观测点)后,**§5 怀疑的归因缺陷确认成立,共三处**:

1. `provider` 只记录 SERVED 后端:auto→Ripwire 失败→legacy 兜底被记为 `provider: 'legacy-rg', fallback: true, fallback_reason: 'ripwire-invocation-failed'` —— Ripwire 尝试的 outcome/时长/体量在记录层丢失(驱动的 `ripwireAttempt` 元数据从未进入记录);
2. 显式 Ripwire 失败(degraded)被记成 `provider: 'ripwire'` —— 实际上没有任何 provider 服务过,违反"不得宣称服务过";
3. `duration_ms` 记的是整次调用(git+history+渲染含入)却被当成 provider 成本;legacy 的 `weak` 由 legacy 交付为空推导,Ripwire 弱尝试事实仅隐含在 fallback_reason 里。

## C. R1.6 architecture(policy / attempts / delivery / post-delivery)

四层独立事实(第 16.1 节,ARCHITECTURE.md):请求的 policy → 有序 provider attempts(有限 outcome)→ served_provider + delivery_state → 会话分析器按 served backend 归属交付后行为。硬规则:**尝试可靠性按尝试的 provider 分组;交付与交付后行为按服务的 provider 分组**。分析器职责保持"哪个 backend 实际服务了 compiler_inspect、Agent 之后做了什么"(`searchAfterInspectByBackend` 仍按 served backend,未改动归属);提供者尝试证据只属于 context JSONL。

## D. Observation protocol(v2 字段 + v1 规范化)

- v2 记录字段(全部非敏感):`schema_version: 2, ts, correlation_id, backend_policy, attempts[{provider, outcome, reason?, duration_ms?, result_chars?, weak?, truncated?}], served_provider, delivery_state, total_duration_ms, delivery_result_chars, weak, truncated, repo(basename), file_count, symbol_count, outside_corpus[, ranked_symbols, bodies, tests 仅在确有交付时]`。
- outcome 词表:`served|weak|error|timeout|invalid-output|not-found`(由 fallback-reason 词表映射,单一分类法;绝不存 stderr)。delivery_state:`served|fallback|degraded`。
- v1 兼容:`normalizeContextObservation()` 只在聚合/评述侧运行,历史文件永不改写。可推断处推断(如 v1 `provider=legacy-rg, fallback=true, fallback_reason=ripwire-weak-result` ⇒ Ripwire weak 尝试 + legacy served 交付;Ripwire 尝试时长/体量缺失则**不填**);歧义 v1 fallback(无 Ripwire reason)⇒ attempts 为空(unknown),绝不编造。v1 的 `result_chars` 语义按记录类型区分(Ripwire=provider JSON;legacy=渲染包),仅后者恢复为 delivery 尺寸。

## E. Attribution correctness(核心示例)

```text
policy=auto
  attempt 1: provider=ripwire, outcome=error, reason=ripwire-invocation-failed, duration_ms=<子进程耗时>, result_chars=0
  attempt 2: provider=legacy-rg, outcome=served, duration_ms=<rg 收集块耗时>, weak=<legacy 是否零命中>
  served_provider=legacy-rg, delivery_state=fallback
  => 汇总/评述:ripwire.error +1;legacy-rg.served +1;deliveries['legacy-rg'] +1;fallbacks +1
  => 且绝不产生 legacy-rg.error +1
```

该断言在三层钉住:运行时观测(v2 记录单测读取真实流)、`summarizeContextRecords`、`evaluate-context-backend`(Plane A/Plane B),测试逐字断言。degraded(显式 Ripwire 失败)单列:`backend='none'`、`delivery_state='degraded'`、渲染 `Context backend: none (fallback: none) | delivery=degraded: <reason>`;分析器单计 `inspectDegradedResults`,不计入 backend 交付,也不做交付后归属。

## F. Cost semantics(评述器使用的每个时长/尺寸)

- `attempt.duration_ms`:仅一个 provider 边界 —— Ripwire = pack-task 子进程;legacy = rg 收集块(definitions/references/vendored/tests)。不含 git 状态/history/diff/日志取证。
- `total_duration_ms`:整次 compiler_inspect 调用(startedAt→结束,含 git、history、diff、日志取证、渲染/预算裁剪)。
- `attempt.result_chars`:provider 边界输出 —— Ripwire=原始 `--json` stdout 字节;legacy=其填入的渲染包。**标注为不可跨 provider 比较**。
- `delivery_result_chars`:最终渲染 tool-result 尺寸 —— 唯一跨 provider 可比的"Agent 实际收到多少"。
- 评述器 `cost` 节同时给出 `total_attempt_duration_ms` 与 `total_call_duration_ms`,语义在输出内自述。

## G. R1.6 Gate result

**Gate A:通过**。提交顺序即为证明:R1.6 归因修复 + 归因矩阵测试先提交(`507f280`),Gate B 的默认翻转是其后独立提交。Gate A 时全套 104/104 通过、9/9 回归零漂移,且 §40 中心回归(auto+Ripwire error+legacy fallback ⇒ ripwire error+1、legacy served+1、无 legacy error)由测试逐字钉住。

## H. R1.7 behavior(Gate B)

- 仓库默认 `REPOSITORY_DEFAULT_BACKEND_POLICY`:'legacy' → **'auto'**(驱动 VERSION 1.5;插件改名 v3-5→v3-6 并同步组成行,遵循热更新约定)。
- 正常工作流:`dsh` 即可,用户不做任何 backend 决策;Ripwire 可用即用,失败/弱/超时/无效输出/缺二进制 → 受控 legacy 兜底,`Context backend: … | delivery=…` 行始终披露实际服务方与回退原因。
- legacy = 兜底 + 诊断/控制后端(`COMPILER_INSPECT_BACKEND=legacy`);显式 `ripwire` 保持严格(失败 degraded,绝不静默换 legacy);`COMPILER_INSPECT_BACKEND=auto` 现与默认等价。
- 优先级(测试钉住):显式输入 > env > 仓库默认 auto;`env legacy + 显式 auto ⇒ auto`、`env ripwire + 显式 legacy ⇒ legacy`。
- 无 shadow paired execution、无百分比/随机/身份路由(硬非目标)。

## I. Tests

- 命令:`node --test "scripts/test/*.test.mjs"` → **105/105 通过**(R1.6 归因矩阵 + v1 兼容 + R1.7 默认 auto 两分支,新增/改写约 14 项)。
- 关键新增:§40 中心归因回归;协议 v2 运行时记录断言(双 attempt、served/delivery、时长分层);显式 ripwire degraded(backend='none');§41 默认 auto 双分支(装/不装);§42 优先级四例;v1 混合流规范化(v1 ripwire served / v1 weak-fallback / v2 error-fallback / 坏行)。

## J. Historical regression

`node scripts/regression-cases.mjs`:9/9 会话与 `analysis/case-baseline.json` 零漂移;基线未改(新字段为零默认,不进基线);无历史数据回填。

## K. Real-repository smoke validation(非生产证据)

AscendNPU-IR @ `90037fe33` 冒烟三例:① 默认(无 backend 输入)+ 真实 ripwire 二进制 ⇒ policy=auto、Ripwire 尝试并服务(带真实 `exclude_dirs`);② 默认 + 受控二进制缺失(`RIPWIRE_BIN` 指向不存在路径,不破坏真实环境)⇒ Ripwire not-found 尝试、legacy 服务、`backend=legacy-rg / delivery=fallback / reason=ripwire-not-found` 归因正确;③ 显式 legacy ⇒ 控制路径功能不变。结果以运行输出为准记录于提交信息与测试。

## L. Natural production evidence

**自然生产 dogfood 会话数 = 0**(post-R1.7 尚无真实会话)。本 Goal 创建的是让后续自然 dogfood 自动积累证据的条件;未伪造、未提前宣称晋升证据。

## M. Remaining uncertainties

- body 级调用点缺口(如 `mergedFunc.verify` 类)是否在生产复现 —— 待 `discovery-after-Ripwire-delivery` 真实样本;
- `tests_to_run` 在 AscendNPU-IR 恒为 0 的机理未深究;
- outside_corpus 在真实契约使用下的发生率;
- Ripwire 冷抓取的资源成本(朴素无排除时已测 >6min/>12GB,契约排除后 ~2.2s)在生产中的分布;
- R2(Semantic Anchor Fusion)是否正当 —— 证据仍不足,维持"无自动 R2"。

## N. Final decision

**AUTO_DOGFOOD_READY**

依据:Gate A(归因正确性)先实现、先测试、先提交,中心回归逐字钉住;Gate B 在其之上把默认切到 auto,零配置工作流可用、缺二进制安全兜底且始终披露;105/105 测试、9/9 回归零漂移;真实仓库冒烟通过归因矩阵三例。下一步是自然 dogfood 积累证据,由人复核第 16.3 节决策树。
