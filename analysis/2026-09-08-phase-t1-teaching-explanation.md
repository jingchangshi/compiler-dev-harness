# Phase T1:Presentation-Ready Code Explanation V1(2026-09-08)

Goal:建立通用的 Code Explanation / Technical Teaching Capability——repository-first 证据 → 机制理解 → 教学重构 → Presentation Handoff → readiness 门,适用于任意 subject 类型,而非某一种 pass 的专项解释。

## 1. Repository State

```text
start HEAD: 0254c63 (Skills: install compiler-architecture-presentation)
end HEAD:   见 git log(本次提交)
branch:     main
```

## 2. Architecture Audit(8 问)

1. **已有 code-understanding 能力**:`compiler_inspect`(v1.4,批量 rg/git/Ripwire 检索 + 日志取证)、`compiler_knowledge`(mlir-repomap 确定性查询:review/finding-impact/pipeline-stages/evidence/status)、两个 preset 本地 skill(compiler-development 工作流、compiler-architecture-presentation slides)。
2. **evidence 获取与保存**:工具 bundle 在会话内(预算内、有界);运行流 gitignored(`analysis/feedback/{routes,queries,context}`);curated JSON 提交在 `analysis/feedback/`(v1/v2 schema,ADR-025);dated markdown 分析报告。
3. **artifact model**:analysis/ 下的 markdown 报告 + curated feedback JSON(`scripts/feedback-schema.mjs` 为 mlir-compiler-harness 协议的 Node 移植)+ case-baseline.json 指标基线。
4. **case model**:`cases/`(gitignored)是导出的生产会话日志,经 `regression-cases.mjs` 重放对比指标——是会话行为回归语料,**不是**分析产物。
5. **mlir-compiler-harness / Ripwire 分工**:前者拥有确定性编译器知识图谱(review records、findings、guards、pipeline stages、file:line evidence、索引生命周期);后者是 `compiler_inspect` 后端策略之后的通用源码上下文 pack(ranked symbols、bodies、1-hop callers、tests-to-run)。
6. **是否已有 explanation/dossier/review 抽象**:无。最接近的是 presentation skill 的 pass-centric 叙事与 harness 侧 review records(都限 pass)。
7. **本 Goal 扩展点**:preset 组成新增 `compiler-explain` row(工具 + always-on 段)+ `skills/code-explanation/` skill + `scripts/teaching-schema.mjs` validators + `analysis/explanations/` artifact 区。它**消费** `compiler_inspect`/`compiler_knowledge` 作为证据源,不平行重建。
8. **绝不重复实现**:call graph / pass graph / attribute index / git history 数据库(Ripwire 与 repomap 已有)、日志取证、feedback 协议机器、PPT renderer、图布局引擎。

## 3. Generic Model(确定性半区 + 推理半区)

```text
AnalysisSubject (subject.json)
      ↓ 依据 plan 的 evidence 计划,用现有确定性工具取证
Evidence ledger (evidence.json)  —— source/graph/runtime/historical fact + reasoning/hypothesis/unknown
      ↓ agent 推理(标注 class)
TeachingDossier (dossier.json)  —— common core + 恰好一个 type extension
      ↓ presentation 深度派生
PresentationHandoff (handoff.json) —— adaptive storyline + semantic visual specs(≠ slides)
      ↓
ReadinessReport (readiness.json) —— READY ⇔ 机械门通过 ∧ semantic review 记录为 ready ∧ 未 stale
```

确定性半区(`compiler_explain` plan/validate/readiness/stale + validators):schema、evidence discipline(引用可解析、fact/reasoning 不混、boundary 分类必须引证)、机械 readiness 前置、provenance/staleness(HEAD + source-file sha256)。
推理半区(永远不做进工具):mechanism stage 命名(源码推导)、mental model、why、context、decisions、storyline、visual specs、semantic review 判词。

### Deterministic vs Reasoning(dogfood 实测归类)

- deterministic(工具直接产出):定义/位置、pass identity+options、pipeline placement、guards 位置、findings、测试存在性、执行结果、git 历史、alias dump。
- agent reasoning(已标注 class=reasoning):机制 stage 命名、mental model、L1/L2 动机、贪心循环解读、复杂度理由、storyline、visual 分镜、readiness 判词。

## 4. Type Extensions

`EXTENSION_KEYS` 注册表是唯一按类型分支的表;readiness 类型检查只查匹配 type 的 extension。11 类:pass/function/algorithm/class/subsystem/pipeline/data_structure/module/workflow/component_group/other。Pass 专有概念(pipeline_placements、ir_contract、legality、rewrite、attributes)只存在于 pass extension;common core 无一涉及(有测试断言)。新增类型 = 注册表加一行。

## 5. Dogfood A(复杂 pass,presentation 深度)

`analysis/explanations/2026-09-08-mergevecscope-pass/`(subject: pass,depth: presentation,READY)。

- 证据:23 条 ledger——source_fact 12、graph_fact 1(repomap review,索引 index --full 刷新 122.4s)、runtime_fact 2(实际执行 `build/bin/bishengir-opt` 跑 L1/L2 fixture:tensor 级 4 结果 merged call、memref 级 merged VF)、historical_fact 1(A5 移植 4ddead06f)、reasoning 3,含 knowledge findings MVS-001/MVS-002。
- 机制:7 个源码推导 stage(收集排序→依赖事实→打分→贪心循环→合法性门级联→两种改写→维护自验证),全部 file:line 溯源到当前 HEAD(纠正了知识图谱旧快照的行号漂移)。
- 教学:mental model、need/responsibility/outcome、上下游因果、4 个 decision、L1/L2 strategy+comparison、6 约束+2 不变量+2 假设、6 类 boundary(含 unknown)、5 takeaways、placement。
- Handoff:7 步自适应 storyline(非固定 pass 叙事)、4 个 semantic visual specs(pipeline/before_after/decision_tree/state_transition)、evidence index。
- Readiness:机械 pass → semantic review(10 通用 + 2 pass 专属问题,全部 sufficient)→ ready;`stale` 检查 not-stale。

## 6. Dogfood B(结构不同 subject,standard 深度)

`analysis/explanations/2026-09-08-memref-alias-state-class/`(subject: class——MemrefAliasAnalysisState,union-find 别名状态类,READY)。

- 与 Case A 的结构对照:无 pipeline、无 IR 改写、无 legality 故事;mutable_state 是等价类划分本身;canonical example 显式 RECONSTRUCTED;runtime_fact 来自 `--debug-only=hivm-utils` 的等价类 dump(观测到 subview∪block-arg 非单元素类与单元素 alloc/call 类)。
- 无 strategies/comparisons(类只有一条类型守卫分支——真实存在才生成);无 handoff(standard 深度可选)。
- 同一 common core、同一 readiness 门、同一协议版本零改动通过 → schema 未对 Case A 过拟合。

## 7. Anti-Overfitting Review

- **机械检查**:`teaching-dogfood.test.mjs` 对 generic 层三个源文件做 subject 专有词扫描(MergeVecScope/AutoVectorizeV2/FlattenOps/RegBase/HFusion/HIVM/tryMerge/mergeLevel/bufferiz)→ 零命中。该测试曾抓到 generic 模块**注释里**出现 fixture 名(已改写)——机制有效。
- **结构检查**:EXTENSION_KEYS 之外无任何按 subject 的分支;readiness 类型检查同理;readiness 在"声明 branching 却无 decisions / 声明 mutable_state 却无 transitions / 无 fact 证据 / mental model 符号堆砌"时拒绝,杜绝凑字段。
- **遗留泄漏**:无。generic 层的"pass"一词仅作为 11 种 subject 类型之一的注册表键(目标对象类型本身,不是对某 pass 的假设)。
- 过拟合反问:scheduler.py(用 function/class core)、C++ class(dogfood B 即是)、graph algorithm(algorithm extension 有测试)、MLIR pass(dogfood A)、多模块 subsystem(subsystem extension + workflow/component_group 类型)——均无需 generic 层改动。

## 8. Tests(真实执行结果,2026-09-08)

```text
node --test scripts/test/*.test.mjs
  tests: 192  pass: 184  fail: 8  skip: 0  todo: 0
  8 个失败为改动前已存在的环境失败(Ripwire 二进制/rg 环境),diff 前后失败集完全一致
本次新增:
  teaching-schema.test.mjs      43 pass(schema/可选字段/evidence discipline/readiness/semantic 门/staleness)
  compiler-explain.test.mjs     12 pass(插件注册/plan/validate/readiness 落盘/stale 真实 git 仓库)
  teaching-dogfood.test.mjs     10 pass(两个 dogfood bundle 语义结构 + generic 层反过拟合扫描)
scripts/regression-cases.mjs: replayed 9 session(s) against the baseline: no drift
```

Dogfood 过程反哺的修复:`explainRoot` 多余 `..` 路径 bug;`withEvidenceIndex` 非幂等;evidence 引用解析缺失(walkEvidenceRefs);computeReadiness 在机械失败时吞掉"semantic review missing"原因。

## 9. Known Limitations

1. Readiness 的 semantic review 依赖 reviewer 诚实——工具只强制"存在且自洽",不评审质量(按设计,§30)。
2. `plan` 的 evidence 计划是静态映射(按 subject type),不读取仓库实况;首次使用仍需 agent 判断锚点。
3. staleness 只覆盖 subject.json 记录的 source_files 与 HEAD;未触及的间接证据(如 pipeline 组成文件)需手工列入 source_locations。
4. 机制理解质量完全取决于会话内取证深度——协议保证结构与纪律,不保证洞察(mental model 质量是 semantic review 的职责)。
5. 无 System Story 聚合引擎(按 scope 只保证 contracts/context 可连接、schema 不阻碍未来聚合)。
6. dogfood 的 L2 fixture 执行依赖本地 worktree build(bishengir-opt);CI/其他环境需按 Repository Contract 重建。

## 10. Recommended Next Phase

1. **Presentation Handoff 消费验证**:用 compiler-architecture-presentation skill 实际吃掉 dogfood A 的 handoff.json 产出一套 slides,校准 visual spec 的词汇(下一阶段唯一的 handoff↔slides 闭环缺口)。
2. **readiness semantic review 的独立复核**:第二个 agent/会话仅凭 dossier 回答受众问题,与原 review 对比,量化"字段齐全≠可理解"。
3. **evidence 计划动态化**:plan 读取 Repository Contract(exclude_dirs/contract_test_dirs)与 repomap status,产出会话专属锚点建议。
4. **System Story v0**:跨 dossier 聚合 contracts(producer/consumer)与 system_context,输出多组件协作 story(本次仅保留前向兼容)。
