# Phase T6:Semantic Visual Fidelity & Control-State Modeling(2026-09-09)

目标:把"流程图看起来合理,但执行语义不准确"从人工 reviewer 才能发现的问题,升级为 compiler-dev-harness 中可声明、可验证、可回归的系统能力。交付 `protocol + semantic model + deterministic validation + presentation consumer support + regression tests + MergeVecScope dogfood + report + commit + push`。producer/consumer 所有权边界不变:producer 拥有语义,consumer 拥有几何;visual 新增的只是语义(semantic roles / stage mapping / edge kinds / state lifecycle / control regions),不是 geometry。

## 1. Repository HEAD 与 source provenance

- 本仓库:harness `main` = `c9c7cb3`(Phase T5 报告之后,origin 新增一条与教学/展示机制无关的 host/workspace commit:`contracts/` + `scripts/prepare-workspace.mjs` + `workspace-prepare.test.mjs`;不影响本阶段机制,但其测试纳入回归基线)。工作自 `c9c7cb3` 起。
- 被分析源码:AscendNPU-IR curated bundle 记录的 HEAD `90037fe3371c`(master)。`MergeVecScope.cpp` sha256 `615ad771ca7b…` 在 `~/workspace/AscendNPU-IR` 与 `~/workspace/AscendNPU-IR-Dev`(7c41e2674)逐字节一致——自 T1 分析以来源文件未变,dossier 的 7 个源码阶段与全部 source facts 继续有效。T6 dogfood bundle 重录 `analyzed_at` 并保留原 provenance 头。

## 2. 架构审计(Q1–Q8,先于任何代码改动)

### Q1 TeachingDossier 如何描述机制/状态/控制流/数据流/分支/worked examples,够不够

`mechanism.stages[]`(`{name,what,where,key_functions,evidence_refs}`)+ `mutable_state`/`has_important_branching` 布尔 + 自由文本 `control_flow`/`data_flow` 数组 + `state_transitions[]`(phase/before/operation/after)+ worked examples(T5)。**不足以**表达 worklist / live ordered state / analysis state / IR state 的区别,也不足以表达 candidate construction、pre-check、legality check、rewrite、commit、requeue、backedge、finalization:状态只是 `state_transitions` 的文字 phase,没有"谁在哪个阶段创建/读/写/终结"的结构化生命周期,没有阶段间类型化控制关系。自由文本 `control_flow` 不参与任何判定。

### Q2 PresentationHandoff.visual 能表达什么

只有 `kind/title/nodes{id,label,role?}/edges{from,to,label?,role?}/groups/ordering`。没有 stage semantics、edge semantics、state lifecycle、branch meaning、loop semantics。**缺口即本阶段契约的来源**。

### Q3 consumer 能否区分不同性质的边

不能。所有边都是 `from→to(+自由文本 label)`;label 不被 geometry、manifest、readiness 任何一层消费。因此 normal-next/success/reject/skip/retry/requeue/backedge/data-dependency/state-read/state-update 的退化(全部画成无类型箭头)不产生任何确定性信号。**label 是给读者看的,不是给系统校验的**——这就是"semantic fidelity 无机械保障"的机制根源。

### Q4 checker 能否发现 7 阶段被画成 6 个、Maintain & verify 被折叠

不能。几何 QA(T5)只判物理破损;manifest 覆盖只查 visual id→assets/slides 映射;readiness 只查字段形状。stage 是否被 visual 消费、是否被 silent fold,三层都不可见。T5 deck 的"机制总览"正是此失败:7 个源码阶段 → 6 个节点,"Maintain & verify"消失,QA 全绿。

### Q5 checker 能否发现 startVFs worklist 与 vfs live order 被合并

不能。dossier 没有状态实体与其 kind(live_sequence vs work_queue),visual 没有状态引用,任何"把两个序列画成一个节点"的行为无契约可违反。所需 semantic contract = 状态实体声明(kind + 生命周期)+ visual 对状态 id 的引用 + "跨 kind 聚合必须给出理由"的确定性规则。

### Q6 checker 能否发现 useScoreMat 被误述为每轮合并的可变状态

不能。需要 lifecycle model:`{created_in, read_in[], updated_in[], finalized_in}` 一旦声明,"初始化后只读"(updated_in=[])与"每轮 merge 同步"就是可机械判定的矛盾。T5 deck takeaway"三份状态(依赖闭包、分数矩阵、依赖图)——每次合并后必须同步"即真实案例:useScoreMat/useScoreTotal 在打分阶段一次性构建(:631-658)后只读。

### Q7 是否需要 split > semantic compression

需要。split > shrink(T5)只解决"文字缩小、几何压扁";T6 增加语义维度:一张图同时承载初始化/候选调度/合法性/改写/状态变更/循环反馈时,应拆成 2 张相关图,而不是把 7 个机制阶段压成 6 个大节点。实现为 bounded heuristic(`SPLIT_RECOMMENDED`:≥5 stage + ≥2 mutable state family + loop 边 + reject 族边),先 recommendation/warning,证据不足不以 hard gate 强推。

### Q8 deterministic validate 与 agent semantic review 的边界

- **deterministic**:标识符解析(stage 名/state id 是否存在)、声明集合比较(stage 是否全部 mapped/dispositioned、relation 是否被消费、状态访问是否与声明的 created/read/update/finalize 一致、跨 kind 聚合是否有理由)。
- **agent review(readiness.semantic_review)**:标签是否达意、merge_reason 是否诚实、图是否好教、storyline 是否自适应。
- 明确不做:自动从任意 C++ 推导完整 CFG、自动证明 diagram 与 source 观测等价、LLM 美学评分。

## 3. Root cause

机制总览图失真的系统性根因是**契约缺口链**:producer 只输出阶段散文与布尔标志(无状态实体/无类型化关系)→ handoff visual 只有无类型节点/边 → 所有校验层(几何/manifest/readiness)都只能校验"形状存在",无法校验"语义被消费"。于是静默折叠阶段、混淆状态角色、误述生命周期都能通过全绿 QA。

## 4. 选择的 semantic model(最小充分集)

- **producer**:`mechanism.states[]`(`kind` ∈ work_queue|live_sequence|analysis|derived|ir|accounting|other;`created_in/read_in/updated_in/finalized_in` 为 stage 引用)+ `mechanism.control_relations[]`(`kind` ∈ next|success|failure|reject|skip|requeue|retry|loop|finalize;允许自环;`condition` 可选)。
- **consumer**:`covers`(义务绑定声明)、node `mechanism_stages/state_refs`(+`*_merge_reason`)、edge `domain`(control|state|data)+ per-domain `kind` + `states`、`stage_dispositions`/`deferred_relations`(显式带理由的放弃)。
- **设计取舍(architecture-first)**:control 与 state/data **不共用一个 enum**——`edge_domain` 分离 + domain-specific kind,拒绝"一票否决路径"与"数据依赖"在同一命名空间里互相污染。
- **backward compatibility**:全部字段可选;义务绑定到 `covers` 声明与 producer 声明;旧 bundle(无声明)只产生 warning(`mechanism_claim_missing`),readiness 兼容(实测 curated 09-08 bundle 仍 READY)。

## 5. Rejected alternatives

- **完整 CFG/AST 搬进 TeachingDossier**:违背"最小但可靠"与 protocol v1 的体量;stage→stage 粒度已足以支撑总览图的 fidelity 校验。
- **用 NLP 理解任意中文 prose 来判矛盾**:不可判定、可被措辞绕过;改为 structured semantic metadata(`covers`/`mechanism_stages`/`state_refs`/`domain+kind`)。
- **让 presentation consumer 读源码反推状态生命周期**:违反 Case B(应修 producer 契约);`state_contract_gap` 检查把"声明了 mutable_state 却没有 states[]"判为 producer 契约失败。
- **SPLIT_RECOMMENDED 直接做 hard gate**:heuristic 阈值(5 stage/2 family)证据尚不足以普遍化;先 recommendation,deck 仍可通过语义校验。
- **给 visual 增加 x/y/color 等布局键以表达语义**:违反 ownership 边界;视觉区分(amber state 节点/dashed state 边)由 consumer 从语义字段确定性推导。

## 6. Schema / protocol 变更清单

| artifact | 变更 |
|---|---|
| dossier.mechanism | + `states[]`、`control_relations[]`(shape + stage 引用解析) |
| handoff.visual | + `covers`、`stage_dispositions`、`deferred_relations`;node + `mechanism_stages/state_refs/stage_merge_reason/state_merge_reason`;edge + `domain/kind/states` |
| readiness | + `visual_semantics` 检查(错误 → mechanical fail → NOT ready → preflight NOT_CONSUMABLE → 编排 final gate 拒绝 COMPLETE) |
| preflight digest | + `covers/stages_mapped/state_edges/control_kinds` per visual;`dossier_pointers.mechanism_states` |
| geometry engine | + 直线段守卫(相邻列/带直连仅当线段不穿第三方盒子,否则走廊 elbow;Liang-Barsky 判交)+ 语义→视觉编码(state 节点 amber、stage 节点 blue、state 边 dashed) |

## 7. Deterministic vs agent review 边界

deterministic gate(9 类 error + 1 warning + 1 recommendation):`stage_coverage`、`stage_merge_reason`、`branch_coverage`、`state_contract_gap`、`state_lifecycle_coverage`、`lifecycle_contradiction`、`lifecycle_stage_mismatch`、`state_role_collapse`、`control_relation_coverage`;`mechanism_claim_missing`(warning,向后兼容);`SPLIT_RECOMMENDED`(recommendation)。agent review 保留:标签措辞、聚合理由诚实性、教学效果。

## 8. Tests

新增 `scripts/test/visual-semantics.test.mjs` 17 tests(Goal §13.1–13.7 全覆盖:stage 覆盖用**真实 T5 失败 visual** fixture 复现并修复;lifecycle 矛盾;worklist vs live collapse;kinds;loop/requeue;split 推荐;反过拟合在 teaching-dogfood 扩展——名单 +1 文件、禁词 +9)。全套 `node --test scripts/test/*.test.mjs`:**302 tests / 294 pass / 8 fail**,失败集合与 T4/T5 基线逐项一致(3 个文件的 Ripwire 环境失败),零新增 failure identity。

## 9. MergeVecScope dogfood before/after

| 维度 | T5(失败模式) | T6(修复后) |
|---|---|---|
| 阶段结构 | 7 源码阶段压成 6 节点,"Maintain & verify"折叠进贪心循环 | V2A 显式 7 阶段全映射(s9 以 stage_merge_reason 聚合 Rewrite+Maintain & verify 并给理由) |
| 候选调度 | startVFs worklist 消失,vfs 与 worklist 混淆 | startVFs(work_queue)与 vfs(live_sequence)为两个状态实体,V2B 分列;WE-3 演示"再入而非递归" |
| 拒绝语义 | pre-check 与 tryMerge legality 合并 | dossier 两条 relation(skip/reject 分离)+ V2A 两种类型化边 + deck"两段拒绝"页 |
| 状态生命周期 | "三份状态每次合并后必须同步"(useScoreMat 被误述为每轮重算) | 9 个状态实体带生命周期声明;V2B 按 create/update/read/finalize 类型化 10 条 state 边;takeaway 修正为"初始化后只读" |
| 更新位置 | allDepsClosure/VFDependencyGraph 更新位置不可见 | patchCalls 内(闭包)vs 外层提交(图/队列/live 序列/计数)在 V2B 分列标注 |
| 删除语义 | "patchCalls 删除旧 VF"(歧义) | 旧 call 在 patchCalls 擦除 vs 旧 VF函数经 toRemoveVFs 循环后 erase,分开表达 |
| worked example | 2 个(WE-1/WE-2) | 3 个(+WE-3 贪心链式 vfs=[A,B,C] 实例,展示 vfs/startVFs/toRemoveVFs/图/闭包逐项变化) |
| 校验 | 几何 QA + manifest 覆盖 | + 语义校验 PASS(10 项 deterministic 检查)+ readiness `visual_semantics` |

dogfood 链路:`TeachingDossier(+states/relations/WE)→ PresentationHandoff(semantic visuals)→ preflight CONSUMABLE → spec_to_diagram(V1/V2A/V2B/V3/V4/V5)→ 几何 QA 全 PASS → check-visual-semantics PASS → slides.qmd(16 页)→ manifest(12 storyline/5 must-have/3 WE)→ check_project exit 0 → Quarto 渲染 _site/slides.html`。渲染核验:误导表述 0 处、修正表述在位、15 footer div、0 字面 `.footnote[`。浏览器截图 QA:环境无 chromium/playwright → **NOT_RUN_ENVIRONMENT**(不伪造 PASS)。

## 10. Known limitations

- 义务绑定 `covers` 声明:producer 不声明则只 warning(向后兼容的代价);SKILL 已把声明定为 presentation 深度的要求。
- `covers` 词表是最小集(mechanism/control_flow/state_lifecycle);data-flow fidelity(如"搬迁的是真实 IR 节点")暂无独立声明维度。
- lifecycle_stage_mismatch 仅在 from-node 恰好映射单一 stage 时判定(多 stage 节点天然歧义)。
- SPLIT_RECOMMENDED 阈值(5/2)是保守启发式,待更多 dogfood 校准。
- 直线段守卫覆盖 router/chain/grid 布局;column/vertical 布局维持 T5 行为(其通道/间隙按构造无节点)。
- 渲染 QA 的浏览器截图不可用(环境限制),以确定性几何 QA + HTML 文本核验代替。

## 11. Next recommended phase(T7 候选)

- **data-flow fidelity 契约**:把 `edge_domain=data` 从"允许"推进为"可校验"(表示边界、IR 形态转移的声明与消费)。
- **split 推荐证据化**:积累多 subject 的 SPLIT_RECOMMENDED 触发数据,评估是否升级部分条件为 hard gate。
- **composition 层语义**:system story 的 bridge 是否需要同等 stage/state 契约(跨 pass 的状态交接)。
- **worked example ↔ state lifecycle 联动校验**:WE 步骤引用的状态变化与 `mechanism.states` 一致性(目前靠 provenance + agent review)。
