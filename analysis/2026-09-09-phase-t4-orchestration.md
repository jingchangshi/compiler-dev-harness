# Phase T4 — Explanation Workflow Orchestration & Productionization(实现报告)

- 日期:2026-09-09
- Repository:`jingchangshi/compiler-dev-harness`,`main`
- Starting HEAD:`7161b75aa07882f5f2ba83a56a9f227b37fd7c8e`(与 prompt 记录一致,实现前重新确认)
- Starting working tree:clean
- Ending HEAD:见 §11(实现完成后 push 的 commit)

---

## 1. Repository-First Audit(§1 十四问,基于实现前源码)

1. **单 subject workflow 的 deterministic primitives**:`compiler_explain plan / validate / readiness / stale`(`compiler-explain-driver.mjs` + `scripts/teaching-schema.mjs`)——bundle scaffold、schema+证据纪律校验、机械 readiness 门 + semantic review 记录、HEAD/文件 hash staleness。
2. **composition workflow 的 deterministic primitives**:`compose-preflight / compose-plan / compose-validate / compose-render`(`compiler-compose-driver.mjs`)——child 门(READY+FRESH、唯一 subject id、同仓同 HEAD)、composition 骨架、imports hash 校验 + 交叉检查、derived `system-story.md`;staleness 递归。
3. **presentation consumer 的 deterministic primitives**:`scripts/preflight-handoff.mjs` 单一消费门(CONSUMABLE / NOT_CONSUMABLE / STALE_PRESENTATION_INPUT / UNSUPPORTED_SCHEMA)+ `presentation-manifest.json` 消费溯源(记录 handoff/dossier/composition sha256 与 source_head)。
4. **仍依赖 agent 手工连接的步骤**:发现 bundle 目录(靠记忆/ls)、逐个 `stale` 判断复用、决定 reuse/refresh/create、手工拼 `bundle_dirs`、决定是否重新 compose、决定 deck 是否需要重建、跨步骤完成度跟踪、中断后恢复——全部没有工具支撑。
5. **是否已有 bundle discovery/catalog**:没有。agent 必须自己知道 `analysis/explanations/` 下有哪些 bundle。
6. **是否有 request-level execution state**:没有。没有任何 run/plan 级协调工件。
7. **stale child 如何被发现/刷新**:agent 对每个记忆中的 bundle 手工跑 `stale`,再自行决定重分析范围。
8. **missing child 如何被发现**:没有任何机制——agent 只能靠先验知识断定"没有 bundle"。
9. **能否自动复用 system bundle**:不能。`compose-plan` 总是生成新的带日期 bundle id,没有组件集合恒等比较。
10. **正常 workflow 会写哪些文件进 harness worktree**:全部 bundle 与 system story 都默认写进 tracked 的 `analysis/explanations/`(唯一默认根);普通使用必然 dirty harness repo。
11. **runtime 与 curated 是否分离**:没有。唯一根就是 curated 目录;只有 `COMPILER_DEV_EXPLAIN_DIR` 这个 override,没有默认 runtime 区。
12. **是否有单 subject 人读 Markdown renderer**:没有。只有 T3 的 system-story.md;单 subject 只有 JSON bundle。
13. **多 subject 自然语言为何不能一句话执行**:上述 4–9 的缺口合计 = 没有 control plane。每一步Coordination 都靠 agent 记忆与手工命令,既不可靠也不可恢复。
14. **orchestration vs semantic reasoning 的边界**:discover/resolve/reuse/refresh planning/依赖排序/artifact state/resume/输出覆盖/最终验证 = orchestration(本次实现);机制重构、mental model、bridges、storyline、semantic review = agent reasoning(未动)。

## 2. Control Plane 设计(Request → Catalog → Resolver → Planner → DAG → Gates)

新增 `compiler-orchestrate-driver.mjs`(纯 Execution Plane,无知识层、无 schema bump),以新命令族挂载到既有 `compiler_explain` 工具:

```text
User Request(subjects + outputs,无 bundle path)
     ↓ run-plan
Artifact Catalog(每次推导:runtime store + curated store;readiness/freshness 重算;无持久索引)
     ↓
Subject Resolver(subject_id → name → normalized/condensed name → type canonical id;
                 0 匹配 → CREATE;≥2 身份 → AMBIGUOUS 显式返回候选,禁止静默挑选)
     ↓
Lifecycle Planner(REUSE = READY+FRESH+深度兼容+同仓同 HEAD;REFRESH = stale/HEAD 漂移/深度不足;
                  composition 复用 = 组件集合恒等+递归 fresh+无 open conflict;
                  presentation 复用 = deck manifest 的 handoff(+composition) hash 一致+preflight CONSUMABLE)
     ↓
Execution DAG(subjects → composition → doc:<subject>/doc:system → presentation;依赖确定性)
     ↓ run-status(节点真值从 artifacts 重推导;自动渲染派生文档;NEXT_ACTIONS + child work packets)
     ↓ run-finalize(最终门:所有 requested deliverables 逐项验证 → COMPLETE | blocked_at_child |
                    blocked_at_composition | presentation_invalid)
```

语义半区归属不变:orchestration 绝不生成 mechanism/mental model/bridge/storyline/semantic review;它只声明"现在该做什么、哪些已做好、哪些可复用"。child work packet 是 compact 自包含的(subject/type/repository/HEAD/target runtime bundle root/required depth/why/required outputs/existing artifact),独立节点标记 `parallelizable`,由既有 DeepSeek Harness subagent 能力消费——driver 内不做任何 agent spawning。low-level primitives 全部保留。

## 3. Runtime vs Curated Artifact Lifecycle

| | Runtime(正常使用,gitignored) | Curated(显式晋升,tracked) |
|---|---|---|
| 根 | `analysis/runtime/{explanations,presentations,runs,documents}/<repository>/` | `analysis/explanations/`、`analysis/presentations/` |
| 内容 | 解释 bundle、run state、派生文档、presentation 工程 | dogfood/regression/architecture fixtures |
| 写入方 | 正常解释任务 | 仅开发者显式 promote(工具永不自动 git add/commit runtime artifacts) |

- `.gitignore` 新增 `analysis/runtime/`;默认零配置、无需环境变量;`COMPILER_DEV_EXPLAIN_DIR` 语义保持(替换 runtime explanations root)。
- Reuse curated bundle 时,派生文档渲染进 runtime store `documents/<repository>/<bundle-id>/`,tracked 树零污染。
- 旧 HEAD bundle 不删除,分类 STALE/HISTORICAL;GC 与自动晋升为显式非目标。

## 4. Dogfood A — 真实 warm multi-subject 请求(AscendNPU-IR @ `90037fe`)

请求(仅 subject 名 + 期望输出,零 bundle path):

> 梳理 HFusionFlattenOps、PropagateReshape、AutoVectorizeV2、MergeVecScope、MarkStrideAlign、EnableStrideAlign 的机制,分别形成文档,解释它们在 RegBase SIMD pipeline 中的协作关系,并形成整体 slides。

- `run-plan`(depth=standard,outputs=artifacts+documents+system_story+presentation)→ run `run-2026-09-09-48f4e3db`:
  - **6/6 subjects REUSE**(curated fixtures READY+FRESH+深度覆盖;semantic re-analysis = 0)
  - **composition REUSE_COMPOSITION**(`2026-09-09-regbase-vector-pipeline-pipeline`:组件集合恒等 + 递归 fresh)
  - **presentation REUSED**(manifest handoff hash 与当前 handoff.json 一致)
- `run-status`:7/7 派生文档(`explanation.md` ×6 + `system-story.md`)渲染进 runtime store,全部 current
- `run-finalize`:**COMPLETE**,`re_analysis_avoided: 6`
- 有价值的副验证:同一请求若请求 presentation 深度,planner 对 5 个 standard 深度的 child 正确判 **REFRESH(深度升级)**——深度兼容模型真实生效,而不是"目录存在即可复用"。
- 过程中发现并修复一个真实生产化缺陷:最初 `bundleRef` 字段名错位导致 curated 复用时把派生文档写进了 tracked 的 `analysis/explanations/`(§59 违规)。修复后文档路由到 runtime store,并以 `git status` 验证 tracked 树干净。

## 5. Dogfood B — Mixed Lifecycle fixture

临时 git 仓库 + runtime store 构造:A=READY+FRESH、B=STALE(创建后 HEAD 前进)、C=MISSING、D=两个不同 subject 共享同一 canonical id(`dogb-shared-tool`)。请求 `[A, B, C, D]`:

```text
DogB A           → REUSE     (READY + FRESH + depth standard)
DogB B           → REFRESH   (head drift: analyzed at 854262…)
DogB C           → CREATE    (no matching bundle yet)
dogb-shared-tool → AMBIGUOUS (matches 2 distinct subjects: dogb-d-one-pass, dogb-d-two-pass)
work packets: DogB B (REFRESH), DogB C (CREATE)   ← 只为真正缺失的部分生成
run-finalize: complete = false | state = blocked_at_child   ← AMBIGUOUS 未静默选择,run 拒绝宣称完成
```

## 6. Dogfood C — 非 Pass 单 subject

> 解释 MemrefAliasAnalysisState 并形成文档。(subject_type = **class**)

- `run-plan` → REUSE(curated `2026-09-08-memref-alias-state-class`,presentation 深度覆盖 standard 请求)
- `run-status` → `explanation.md` 渲染进 runtime store,current
- `run-finalize` → **COMPLETE**,documents 1/1
- 证明 orchestration 不是 multi-Pass 特化(generic orchestration 代码同时通过 anti-overfitting 扫描)。

## 7. Resume / Idempotency / HEAD Drift / Runtime 清洁

- **Resume 跨 session**:process 1 plan(`run-2026-09-09-ab23a86c`,含一个 missing subject)→ process 2 以相同请求 `run-plan`(无 run id)→ `resumed = true`、同一 run id;process 2 `run-status` 不带 id 也能找到 open run。单测 `resume: partial completion…` 进一步验证:部分完成后只剩未完成节点可执行,已完成节点 observed_action = reused。
- **Idempotency**:同请求重复 plan → 同一 run、无重复 bundle(单测 + Dogfood A 多轮重跑);同仓同 HEAD 同 subject 同深度已有适用 artifact → REUSE。
- **HEAD drift 失效**:单测(HEAD 前进 → REFRESH,原因含 head drift/source changed)+ Dogfood B 实测;composition 递归 fresh 使 system/presentation 同步失效。
- **Runtime store 清洁(硬验收)**:单测断言正常 run 前后 harness `git status --porcelain` 不变、`analysis/runtime/` 已 gitignore;Dogfood A/C 后实测 tracked 树无任何新增。

## 8. Metrics(§73/§44)

| 指标 | Dogfood A | Dogfood B | Dogfood C |
|---|---|---|---|
| requested subjects | 6 | 4 | 1 |
| resolved automatically | 6/6 | 3/4(D 显式 AMBIGUOUS) | 1/1 |
| ambiguous | 0 | 1(候选全量返回) | 0 |
| reused | 6 | 1 | 1 |
| refreshed | 0(计划正确产出;fixture 未实际刷新) | 1(计划) | 0 |
| created | 0 | 1(计划) | 0 |
| child semantic re-analysis avoided | **6** | —(fixture 无真实语义工作) | **1** |
| composition reused / rebuilt | reused / 0 | — | — |
| documents generated | 7/7(runtime store) | — | 1/1 |
| presentation reused / rebuilt | reused / 0 | — | — |
| **manual bundle paths supplied by user** | **0** | **0** | **0** |

## 9. Tests(§60–§63)

- 新增 `scripts/test/orchestration.test.mjs`:25 tests,覆盖 catalog(发现/元数据/origin/无持久索引/unreadable 可见)、resolver(exact/normalized/condensed/canonical/AMBIGUOUS/CREATE)、lifecycle(REUSE/HEAD-drift REFRESH/深度不足 REFRESH/CREATE/BLOCKED)、composition 复用(集合变更强制重组)、DAG(single/multi/依赖)、resume、idempotency、final gate(子未就绪/open conflict/presentation hash 失配 → 拒绝;全绿 → COMPLETE)、runtime 清洁、gitignore、renderer(derived/adaptive/确定性)、cross-origin(真实 curated 系统故事复用)、anti-overfitting。
- 既有 `compiler-explain.test.mjs` 注册测试同步更新至新命令面(13 commands + 2 个 always-on policy section)。
- 全套 `node --test scripts/test/*.test.mjs`:**263 tests / 255 pass / 8 fail**;8 个失败与实现前基线**逐一相同**(Ripwire 环境:missing binary、seam fallback ×3、observation v2、H2、M3、rollout)——**无新增 failure identity**。
- `scripts/regression-cases.mjs`:实现前后均 **no drift**(9 sessions)。
- T1/T2/T3 能力回归:single-subject 协议、preflight 消费门、递归 staleness、composition imports/conflicts、system story、presentation manifest 均未重写,全部既有测试保持。

## 10. CI

仓库无 CI 配置(.github 等不存在)。按 §64 记录:**NO CI CHANGE**,CI hardening 留后续。

## 11. Git

- 最终 commit:`<filled after push>`
- push result:`<filled after push>`
- working tree after push:`<filled after push>`

## 12. Architecture Review(§71)

1. 用户还需要提供 bundle path?**否**——只给 subject 名与输出(三个 dogfood 均为 0 path)。
2. 用户/agent 还需手工决定 reuse/refresh/create?**否**——planner 分类,agent 只消费 work packet 与 AMBIGUOUS 决策。
3. stale child 自动被发现?**是**——catalog 重算 freshness(HEAD + 文件 hash + composition 递归)。
4. fresh READY child 零重分析复用?**是**——Dogfood A 6/6,re-analysis avoided = 6。
5. system bundle 可复用?**是**——组件集合恒等 + 递归 fresh → REUSE_COMPOSITION。
6. presentation 可复用?**是**——manifest handoff hash 一致 + preflight CONSUMABLE → reused。
7. partial run 可 resume?**是**——request signature 匹配即恢复,跨进程验证。
8. 重复请求幂等?**是**——同 signature resume,不重复建 bundle。
9. 正常使用还会 dirty harness repo?**否**——runtime store gitignored,curated 派生文档进 runtime store。
10. runtime/curated 生命周期清楚?**是**——路径、写入方、晋升方式、文档均有明确契约。
11. orchestration 成为新知识层?**否**——run.json 是 coordination state,真值从 artifacts 重推导;无新 schema、无新知识模型。
12. semantic reasoning 仍在 agent?**是**——driver 无任何语义生成;文档渲染与 system-story 同为 derived view。
13. subagent 只是既有能力消费?**是**——driver 仅标记 `parallelizable`,不 spawn。
14. generic orchestration 通过 heterogeneous subjects?**是**——class(Dogfood C)、pass(Dogfood B fixture、canonical id)、pipeline(Dogfood A composition)同一代码路径;anti-overfitting 扫描通过。
15. low-level primitives 仍可独立使用?**是**——全部保留且测试通过,orchestration 只在其上组合。

## 13. Architecture Verdict

**EXPLANATION_WORKFLOW_PRODUCTION_READY**

依据:三个 dogfood 全部通过(含 0 手工 path、0 重分析、AMBIGUOUS 显式、final gate 真实拒绝不完整 run);resume/idempotency/HEAD-drift/runtime-cleanliness 有单测与实测双重证据;既有 T1/T2/T3 测试无新增失败身份;§59 硬验收(不 dirty tracked 树)在单测与真实 dogfood 中均验证(含一次真实缺陷的发现与修复)。

## 14. Before / After T4(§74)

**Before**:
```text
natural request
→ agent 手工发现 bundle 目录(记忆/ls)
→ 手工逐个 stale / compose-preflight
→ 手工拼 bundle_dirs、决定 recompose、决定 deck 重建
→ 手工跟踪完成度,中断即丢失
→ 用户必须懂 compose 命令与 bundle path
```

**After**:
```text
natural request
→ run-plan(catalog → resolution → REUSE/REFRESH/CREATE → DAG + work packets)
→ agent 只做真正缺失的语义工作(独立 child 可 subagent 并行)
→ run-status 确定性 re-validate + 自动渲染派生文档
→ run-finalize 逐项验证全部 deliverables → COMPLETE
→ 用户全程只说"想理解什么、要不要文档和 slides"
```

## 15. Known Limitations

- 一个 run 使用单一全局 depth;混合深度需求(如"children 用 presentation、system 用 standard")只能靠深度兼容单向覆盖(request ≤ existing 可复用),反向会触发整体升级。真实数据出现需求前不扩展。
- presentation manifest 匹配用 bundle_id / bundle_dir;跨仓库 bundle_id 撞名的理论可能未处理(现实中 bundle id 含日期+slug+type)。
- subject.json 本身损坏的 bundle 无法归属 subject(catalog 保留但匿名),planner 按 CREATE 处理;其余 artifact 损坏 → BLOCKED/REFRESH 正常。
- presentation 的实际 deck 生产仍是 consumer skill 的语义工作;orchestrator 通过 manifest hash + preflight 门验证其结果。
- GC、自动晋升、多仓库 composition、版本对比故事:明确非目标(§70)。

## 16. Recommended Next Phase(§75,用证据选择)

**Candidate A — Production Evidence for Explanation Workflow**:orchestration 已稳定,下一步应从真实日常任务收集 reuse/refresh 率、ambiguity 频次、artifact 失败与 semantic rework 数据,再决定是否优化。Candidate B/C/D 的触发证据尚未出现。
