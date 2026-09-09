# Phase T5:Presentation Fidelity & Worked-Example Closure(2026-09-09,进行中)

目标:一次真实 MergeVecScope presentation dogfood 暴露的四类系统性缺口(Quarto footer 语义、图几何、语义列表渲染、worked example 不足),转化为
`protocol + deterministic implementation + deterministic validation + regression fixtures + real dogfood`。
不改 producer/consumer 所有权边界,不新增 subject 专属 generic 逻辑,凡 parser/geometry/manifest/DOM 可判定的问题一律确定性检测。

## 0. HEAD 审计(repository-first,先于任何代码改动)

审计对象:当前 `main`(c725c1f,T4 报告为最新提交)。逐条回答 Goal §2 的九个问题:

### Q1 Teaching Protocol / TeachingDossier 对 examples 的 schema 与 readiness 要求

- `scripts/teaching-schema.mjs`:`canonical_example = { provenance{kind∈test|production|probe|reconstructed, source},
  initial_state|inputs|result(string|mapping), execution_trace|important_states|boundary_examples(array) }`。
  `execution_trace` 条目**不校验结构**——实践中是长 prose 字符串,无 per-step evidence_refs、无与 mechanism stage 的映射。
- `handoff.canonical_example` 只允许 mapping(summary/reference),消费侧只拿到一段 summary 文本。
- 机械 readiness(`computeMechanicalReadiness`):`canonical_example` 仅对 `EXAMPLE_REQUIRED_TYPES`
  (pass/algorithm/pipeline/subsystem/workflow/component_group)且 depth≠overview 必填;检查内容只有
  `provenance.source` 非空。**逐步骤结构与证据指针都不是 readiness 条件**。

### Q2 PresentationHandoff 如何表示 canonical example / visuals / boundaries

- visuals:12 种语义 kind(architecture/pipeline/control_flow/data_flow/flowchart/decision_tree/
  state_transition/sequence/before_after/comparison/dependency_graph/ownership),`FORBIDDEN_VISUAL_KEYS`
  禁止 x/y/width/font 等布局键(semantic-only 不变量,保持)。
- canonical example:仅 `summary`+`provenance` 引用;没有 steps、没有 slide 级映射要求。
- boundaries:常见通过 visual spec 节点 role 表达;handoff 无独立 example→slide 契约。

### Q3 presentation consumer 如何从 semantic visual spec 生成 Excalidraw/SVG

- `spec_to_diagram.py`:每次解释一个 visual spec → 定位 JSON → 子进程调 `make_excalidraw_diagram.py`
  产出 `.excalidraw` + 同布局 `.svg`。定位决策有界:5 种布局(pipeline 流式换行链、sequence/state_transition
  垂直链、before_after 双列、decision_tree BFS 层级 + reject 右列、其余 grid fallback)。

### Q4 spec_to_diagram.py 每种 layout 的算法(与缺陷)

| layout | 算法 | 缺陷 |
|---|---|---|
| pipeline(链) | `measure()` 实测宽度,`MAX_ROW_WIDTH=1500` 流式换行 | 换行处 row→next-row 连接边是直线,会斜穿下一行节点(潜在 bug) |
| sequence/state_transition | 垂直链,实测宽度 | 同上,回边无路由 |
| before_after | role 分左右列,boundary 沉底 | 固定 `NODE_W` 间距,长 CJK 标签重叠 |
| decision_tree | BFS 层级;固定列距 `NODE_W+2*GAP_X=380`;reject 节点单列在最右 | **列距固定而渲染盒随 CJK 文本变宽 → 必然重叠**;层级数无上限 → 无宽度上限;reject 列所有入边为直线,横穿主链 |
| grid fallback | 实测宽度,3 列换行 | `flowchart/dependency_graph/comparison/architecture/ownership` 等 7 种合法 kind 静默落入 grid,role 语义(左/右对比)丢失 |

`measure()` 只算宽度、高度固定 `NODE_H=72`;`make_excalidraw_diagram.py` 渲染文本**不换行**,长标签在 SVG/excalidraw 中溢出盒子。

### Q5 make_excalidraw_diagram.py 当前 edge geometry

全部箭头 = 两点直线:按主轴方向从源盒边中点连到目标盒边中点。无 waypoint、无 elbow、无绕障;
边标签放中点。任何"越过中间节点"的边都直接穿过。

### Q6 check_project.py / validate_manifest.py 能查与不能查

- 能查:核心文件存在、可见 generator 文案、QMD 引用图片存在;manifest 覆盖(storyline 无 silent drop、
  deferred 必须带 reason、must-have visual→assets+slides、evidence id ⊆ handoff index、handoff hash 匹配、
  未知 schema 拒绝)。
- 不能查:**QMD 内容语义**(`.footnote[...]` 这类非 Quarto 语法原样进 HTML 无人拦截;`·` 分隔的伪列表)、
  **图几何**(节点重叠、边穿节点、超宽 aspect、投影后文字过小)、**example 映射**(handoff 例子是否真的进了 deck)。

### Q7 orchestration run-status / run-finalize 如何判定 presentation 完成

`compiler-orchestrate-driver.mjs` 的 presentation 状态 = 存在 manifest 且其记录的 handoff(+composition)
hash 与当前 bundle 一致 + preflight CONSUMABLE;final gate COMPLETE 需要该状态。**不运行项目 checker、
不检查几何与 QMD 语义**——一个 footer 语法错误、图重叠的 deck 仍可 COMPLETE。

### Q8 Phase T2 当时明确 deferred 的能力

T2 报告"明确不做"清单:**通用图布局引擎**、System Story(已由 T3 实现)、动态 evidence planning、
Protocol v2、语义质量评分。即:bounded 5 布局之外的几何质量(overlap/crossing/aspect/投影文字)当时被显式搁置,
仅以 SKILL.md 自然语言规则("node boxes must not overlap; edges avoid crossing nodes; split overloaded figures")
约束,无确定性检测。

### Q9 新 dogfood 是否提供足够 evidence 升级为正式 phase

是。失败 deck:`AscendNPU-IR-Dev/analysis/presentations/merge-vec-scope-slides/`(已渲染 `_site/slides.html`):

- **Failure A**:10 处 `.footnote[...]` 在渲染 HTML 中原样显示(`grep -o '.footnote\[' _site/slides.html` 可复现)。
- **Failure B**:V4(tryMerge 闸门链)SVG viewBox 4204×510,13 rect/19 arrow,全部两点直线,aspect≈10.1;
  V1 aspect 5.89、V6 aspect 7.15;多条 reject 边横穿主链节点。
- **Failure C**:`✘ 设计拒绝`/`✘ 未支持` 等块为普通段落 + `·` 分隔,HTML 中成为一整行 prose。
- **Failure D**:handoff.canonical_example 只有 summary;dependency model、greedy merge loop、闸门链、
  gap 搬迁、mergeNoBetween/mergeNoMemory、可变依赖状态同步等复杂机制均无逐步骤可追踪实例。

结论:T2 deferred 的 visual/layout QA 具备升级为正式 phase 的证据;同时 QMD 语法语义与 example 映射
属于从未被任何层覆盖的新缺口。

## 1. 方案(基于审计调整后)

所有权不变:producer 继续拥有语义(含 worked examples 的内容与 provenance);consumer 拥有全部几何与
QMD 形态。实现分四个工作流:

- **A. Quarto 语义契约**:`references/quarto-content-semantics.md` 固化 canonical forms(evidence footer、
  语义列表、columns、notes);模板 slides.qmd 中性化并示范 canonical forms;`styles.scss` 增加 footer 样式;
  `check_project.py` 增加确定性 QMD 检查(禁 `.footnote[`、`·` 伪列表判定)。
- **B. 图几何与确定性 QA**:`spec_to_diagram.py` 重写布局(实测宽高 + 文本换行、decision_tree 层级带宽
  换行 + reject 专用列 + gutter 通道路由、comparison/flowchart 显式布局、长边 elbow waypoint);
  `make_excalidraw_diagram.py` 渲染多行文本与 waypoint 折线;新增 `check_diagram_geometry.py`
  (节点重叠、边穿节点、aspect、1600×900 投影字号四类确定性检查,读 `.excalidraw` 真值),并入
  `check_project.py`。
- **C. Worked-example closure**(protocol v1 加性扩展):dossier `canonical_example.execution_trace`/新增
  steps 允许结构化条目(label/action/result/mechanism_stage/evidence_refs);handoff 新增 `worked_examples[]`;
  readiness 在 presentation 深度要求逐步骤实例;preflight digest 透传;manifest `consumed.worked_examples`
  映射;`validate_manifest.py` 强制覆盖(missing example mapping → fail)。
- **D. 编排 final gate 接线 + 回归 fixtures + dogfood**:presentation 节点状态纳入 checker 结果;
  失败 deck 的视觉 spec/QMD 模式固化为 regression fixtures;重新 dogfood 出新 deck 验证全链路。

## 2. 实现(提交 8774ff8 + 93eba95 + 后续提交)

### 2.1 Workstream A — Quarto 语义契约

- `references/quarto-content-semantics.md` 固化 7 类 canonical forms;模板 slides.qmd 中性化并示范;
  styles.scss 增加 `.reveal .footer`。
- `check_project.py` 的确定性检查:C1 `.footnote[` → error;C2 `·` 伪列表——段落或单个列表项内
  ≥3 个 `·` = error(2 个 = warning),frontmatter/围栏代码/表格/`::: footer` 内的指针行豁免
  (footer 内 `·` 是 canonical 的证据指针分隔符,见契约 §1)。

### 2.2 Workstream B — 图几何与确定性 QA

布局引擎重写后每种 visual kind 都有真实布局:

| kind | 布局 | 关键机制 |
|---|---|---|
| pipeline | 水平链,`MAX_BAND_WIDTH=1500` 流式换行 | wrap 连接经 gutter elbow,不再斜穿下一行 |
| sequence / state_transition | 垂直链 | 非前向边走右侧通道 |
| before_after / comparison | 双列 + 余部条带 | 实测列宽;跨列直线穿空隙 |
| decision_tree / flowchart | 单根 BFS 层级→列 | reject 专用列 |
| control_flow / data_flow / dependency_graph / architecture | 多根 BFS 层级→列 | unreachable 归尾列 |
| 其余 | grid 兜底 | — |

- 盒子尺寸 = 标签换行后逐行估宽 + padding,高度 = 行数×1.25×18 + 20;`spec_to_diagram` 与
  `make_excalidraw_diagram` 共享同一换行规则(测试钉住一致),长 CJK 标签不再溢出。
- 列按 1500px 换行成带;REJECT 角色节点进专用列;边路由:同带相邻列直连,其余走
  "列间走廊 → 带间 gutter →(跨带经左缘 margin)→ 目标列走廊"的确定性 elbow。
- `check_diagram_geometry.py`:G1 重叠 / G2 边穿节点 / G3 aspect(fail>20, warn>6)/
  G4 1600×900 投影字号(fail<12px, warn<16px)/ G5 标签溢出;输出逐文件 PASS/FAIL + ERROR 明细,
  exit 1 表示物理性破损。G3 只抓构型极端,可读性由 G4 决定(1274×64 的短标签单行 pipeline 是合法形态)。

### 2.3 Workstream C — Worked-example closure

- schema(v1 加性,向后兼容):step 条目主文本键接受 `label|action|description|state|what`
  (旧 `{description}/{state}` 数据继续有效),可选 `result` / `mechanism_stage`(对接
  `mechanism.stages` 名)/ `evidence_refs`(走既有账本解析);dossier 与 handoff 各新增
  `worked_examples`(dossier:完整步骤+provenance;handoff:`{id,title,summary,evidence_refs}` 语义引用)。
- readiness floor:presentation 深度 + example-required 类型 ⇒ canonical example 必须
  `execution_trace + steps ≥ 3` 条(旧 bundle Case A 6 条、Case B 3 条、T3 系统 bundle 7 条,全部通过)。
- `validate_manifest.py`:handoff 声明的每个 worked example 必须出现在
  `consumed.worked_examples`(consumed→slides 必须在 QMD;appendix/omitted→必须带 reason);
  silent drop = 失败。

### 2.4 Workstream D — final gate 接线与回归 fixtures

- `observedPresentationState`:hash 匹配 + CONSUMABLE 后运行 deck 自带
  `scripts/check_project.py`(120s 超时,错误截前 5 条);fail → pending + 原因,
  COMPLETE 被拒;pass → done;无 checker 的旧 deck → done(checker: unavailable)。
- 回归 fixture:`scripts/test/fixtures/mergevecscope-failed-deck-visuals.json`(失败 deck 的
  7 个真实 visual specs);测试断言新引擎输出零重叠/零穿边/V4 aspect<6,而旧式直连几何
  (手工构造 4000px 单行链)被 G2/G4 拒绝。

## 3. 验证

- 单测:新增 `presentation-fidelity.test.mjs` 13 项(kind→布局映射、实测盒宽、带换行、
  reject 列与 elbow、真实失败 specs 回归、旧失败模式被拒、QMD canonical/defect、
  模板- harness 脚本字节一致、worked_examples schema、legacy step 兼容、presentation floor、
  manifest example 覆盖);`orchestration.test.mjs` +1(checker fail 阻断 COMPLETE / fix 后 done);
  anti-overfit 扫描名单扩展至 15 个 generic 文件。全套 275 pass / 8 fail
  ——失败集合与 T4 基线逐项一致(3 个文件的 Ripwire 环境失败),零新增 failure identity。
- 几何回归(真实数据):失败 deck 的 V1–V7 specs 经新引擎重建后全部 PASS;
  旧 V4(excalidraw bbox 4000×396)被 G2×19 + G4(7.2px)+ G3(10.1)拒绝。

## 4. Real dogfood(2026-09-09)

对象:runtime bundle `AscendNPU-IR-Dev/analysis/runtime/explanations/AscendNPU-IR-Dev/2026-09-09-merge-vec-scope-pass`
(即失败 deck 消费的同一真实 bundle)。

1. **Producer 增量刷新**(契约要求,绝不改 hash 绕过):bundle 因 HEAD 漂移 stale
   (80db8e8→7c41e26,无关的 PropagateReshape 修复);分析过的 10 个源文件 sha256 逐字节未变
   → 重录 provenance(head/analyzed_at),并按 T5 新要求做 semantic top-up:
   - dossier.worked_examples 两条:WE-1「依赖建模如何阻止第三次错合并」(kind=test,5 步,每步绑
     mechanism stage + 账本事实 EV-007/010/011/012/013/014)、WE-2「tryMerge 闸门链逐门推演」
     (kind=reconstructed,5 步,EV-016~020/023/025,显式标注 RECONSTRUCTED);
   - handoff.worked_examples 声明 WE-1/WE-2;evidence_index 以 deck 实际引用补齐至 40 条。
   - `validate` 0 errors;`saveReadiness`(受众评审结论不变,reviewer note 如实记录刷新)→
     mechanical pass / READY;`staleness` false。
2. **Consumer**:preflight CONSUMABLE(digest 含 worked_examples + worked_examples_full)→
   scaffold → V1–V5 经 `spec_to_diagram.py` 生成 → 几何 QA 全 PASS → 手写 13 页 QMD
   (canonical footer/真列表/有序步骤实例)→ manifest(11/11 storyline,step 8 split 带 reason;
   5/5 must-have visuals;WE-1/WE-2 映射;30 个 evidence ids;2 条 adaptations 带 reason)→
   `check_project.py` exit 0 → `make render`。
3. **渲染对照(四类失败逐一关闭)**:

| 失败 | 旧 deck(merge-vec-scope-slides) | 新 deck(merge-vec-scope-slides-t5) |
|---|---|---|
| A footer | HTML 中 10 处字面 `.footnote[...]` | 0 处;13 个渲染 `.footer` div |
| B 几何 | V4 4204×510/aspect 10.1,19 条直边穿节点,投影字 7.2px | V4 ≈1500×640/aspect 2.4,9/19 边路由 elbow,投影字 ≥16px,几何 QA PASS |
| C 列表 | `✘ 设计拒绝` 等为一整行 prose | 真 `<ul>/<li>`;checker 对伪列表确定性报警 |
| D worked examples | canonical 只有 summary 段 | 2 个 `<ol>` 步骤列表页,manifest 强制映射 |

4. dogfood deck 以 `analysis/presentations/2026-09-09-merge-vec-scope-t5/` 入库(curated 证据;
   其 manifest.bundle_dir 指回 runtime bundle,hash 可复算)。

## 5. 边界与后续

- 几何 QA 作用于 `.excalidraw` 真值;人工精修后若引入重叠/穿边会被同一检查器拦截。
- 边路由是 bounded 启发式(走廊+gutter),不是通用布局引擎;G1–G5 是确定性底线,美学仍归人。
- `worked_examples` 的声明仍是 producer 的语义决策(哪些机制值得逐步实例);系统只强制
  "声明了就必须被 deck 映射"。T3 系统 story 的 bridge 级 worked examples 未在本次范围内。
- 旧 deck 项目(无 checker 脚本)在编排下仍可 reuse(checker: unavailable);重 scaffold 即获得全套 QA。
