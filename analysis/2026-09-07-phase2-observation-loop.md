# Phase 2 — Production Knowledge Observation Loop(实施与验证记录)

> 2026-09-07。本记录只含非敏感指标数字与机制事实;不记录 prompt、transcript 或源码内容。
> 反馈协议事实源:mlir-compiler-harness `adapters/compiler-dev/feedback-schema.md` v2(ADR-025)
> 与 `workflow-contract.md`;本仓只做 observation 与 candidate。

## 1. What was built

| 机制 | 落点 |
|---|---|
| `compiler_route` 工具(每任务一次路由决策;kind/expected/confidence/reason/target) | `compiler-knowledge-v2.cjs`(由 v1 改名,热更新约定) |
| per-task `correlation_id`(`k`+16hex,无用户/prompt/path 数据) | 插件 per-agent 状态 + driver 标注 |
| 查询记录扩展(correlation_id、route、diagnostics、delivery.truncated) | `compiler-knowledge-driver.mjs` v2.0 |
| 路由决策流 `analysis/feedback/routes/<date>.jsonl`(gitignored) | driver `logRouteRecord` |
| 分析器扩展:route/adoption/temporal/搜索分类 | `scripts/analyze-session.mjs` |
| Feedback Protocol v2 校验器 JS port(与 Python 实现交叉核对一致) | `scripts/feedback-schema.mjs` |
| candidate 生成(query-sufficient / query-insufficient / adoption-missed / query-operational) | `scripts/collect-feedback.mjs` |
| candidate→curated 审核(accept 校验+strip+origin: curated;reject 入 rejected/;不自动 commit) | `scripts/review-feedback.mjs` |
| 批量汇总(counts only,无架构推论) | `scripts/summarize-feedback.mjs` |
| bundle 导出 + fail-closed 隐私检查 | `scripts/export-feedback-bundle.mjs` |
| 案例回归(`cases/` → 基线重放) | `scripts/regression-cases.mjs` + `analysis/case-baseline.json` |
| 测试(4 个文件,57 例) | `scripts/test/` |

设计要点(细节见 `ARCHITECTURE.md` 第 13 章):conservative routing(目标 = 正确路由率,不是调用率);
precision-first 搜索分类(指针化验证读取 ≠ discovery;无法判定 = uncertain,绝不判 gap);
adoption 只按已声明路由计;未声明路由 / status-only / 正确 skip 不产 candidate;
positive evidence(query-sufficient)刻意保留。

## 2. Case regression replay(§16)

9 个 2026-09-05/06 生产会话(上一阶段案例报告语料)放入 gitignored `cases/` 后重放:

- `node scripts/regression-cases.mjs --update` 生成基线;重放 `no drift`。
- 基线(`analysis/case-baseline.json`,仅 session 短 id + 指标数字):
  - `compilerKnowledgeCalls` **全部 9 个 = 0**(knowledge 集成前基线,与案例报告一致);
  - `compilerInspectCalls` 分布 [0,0,1,1,1,1,2,2,3](合计 11,与案例报告"11 次调用"一致);
  - bash grep-like 搜索分布 [0,0,3,21,42,52,72,146,350](C4=146、C5=350:统计口径为分析器的
    grep/rg/awk/find 动词启发式,与报告的 ad-hoc 口径略有差异,以基线为准做回归);
  - humanTurns [1,1,1,1,2,2,2,4,6];峰值请求上下文逐 case 与报告一致量级(最高 ~199K)。
- 观测层对旧会话零干扰:route decisions = 0(旧会话无 `compiler_route` 调用),搜索分类照常输出
  (以 C5 为例:461 个 bash 搜索/读取调用 → discovery 133、verification reads 40、uncertain 288;
  旧会话无 knowledge 调用,故 search-after-knowledge = 0)。

## 3. Knowledge integration re-validation(§17)

三个验证任务、七条查询经 **v2.0 driver 实机重跑**(与工具执行路径完全一致;index 已 fresh):

| 任务 | 序列 | 查询 | 时延 | 交付 |
|---|---|---|---|---|
| MergeVecScope review(AscendNPU-IR) | review → finding-impact → evidence | 3 | ~3.5s each | envelope 完整,无截断 |
| AutoVectorizeV2 finding 复核 | finding-impact AV2-001 | 1 | ~3.6s | 24K 预算截断(与首轮验证一致,contract keys 完整) |
| Triton lowering(triton-ascend) | pipeline-stages ×2 → evidence | 3 | ~0.37s each | 无截断 |

7/7 查询服务成功,correlation id 一致贯穿;`make_ttir` 报告 diagnostics=9(即已知 query-coverage
gap:9/10 未解析 binding 名,首轮验证的人工发现现在被机械计数)。全程 **0 discovery grep**——
`7 queries / 0 discovery grep` 成功路径未被新观察层破坏;观察层仅追加记录,不改变任何结果内容。

## 4. End-to-end observation loop check

以合成观察会话 fixture(`scripts/test/fixtures/observation-session.jsonl`:1 个 sufficient 组、
1 个 adoption-missed 组、1 个 skip 组)+ 合成查询流,全链验证:

```text
analyze-session → routeMetrics(3 routed / 2 expected / 1 skip)、adoption(2/1/1)、
                  temporal(knowledge@2 < discovery)、search(discovery 1 / verification 1 / uncertain 1)
collect-feedback → 3 candidates(均通过 v2 校验;origin: automatic)
review-feedback  → accept ⇒ origin: curated 落盘;reject ⇒ rejected/ + reason
summarize        → counts 汇总一致
export-bundle    → manifest/summary/route/query/curated + candidate-summary;无 transcript;
                   注入 prompt 字段的 curated 文件 ⇒ fail-closed 中止,不留 bundle
```

隐私保证(实现 + 测试双层):流与 candidate 只含计数/步号/稳定 id/运行布尔;bundle 导出对每个
staged 文件做 JSON key 白名单外拒绝(prompt/messages/transcript/source text/credential/token/
reasoning 等关键词)、`/home/<user>` 路径、私钥块、凭据赋值形状、超大文件(>2MB)检查,任一命中
即中止且不留产物;报告只给文件名与 key 名。

## 5. Mount compatibility fix(发现的既有问题)

实机 mount 校验(运行时 `agentPresets.standingKeyFor('compiler-dev')`)暴露:当前 harness 构建的
tool output schema 校验器**不再接受 type 数组**(`type: ['object','null']`),导致 `compiler-inspect`
行(未改动的 v3-2 文件)令整个 preset 拒绝挂载。修复:`diff`/`first_divergence` 的 nullable 形状改为
`oneOf: [{type:'object'…}, {type:'null'}]`(行为不变),文件按热更新约定改名 `compiler-inspect-v3-3.cjs`
并同步组成行;`compiler_route` 的 `maxLength` 同样不在支持的 keyword 子集内,改为 execute 内截断。
修后 standingKeyFor 返回 mounted OK。校验器支持的 keyword 子集(type/oneOf/properties/required/
additionalProperties/items/enum/const + description/title/default/examples)已记入 README。

## 6. What this phase deliberately does NOT do

Python Pipeline Hardening、Attribute Value Provenance、Test Coverage Extraction、watchlist、MCP、
clangd、cross-repo semantic validation —— 等真实数据(下一批生产会话的 route/adoption/candidate
分布)再评审。`summarize-feedback.mjs` 与 `export-feedback-bundle.mjs` 的输出是给人看的 counts,
不输出任何"因此应该实现 X"。
