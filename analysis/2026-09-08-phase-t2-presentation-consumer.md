# Phase T2:Presentation Consumer Closure(2026-09-08)

Goal:让 PresentationHandoff 成为 presentation system 的正式输入契约,关闭 Code Explanation → Presentation 的 producer/consumer 闭环;READY+FRESH 的知识包不经第二轮源码重分析即可转化为可追溯、可验证的技术 presentation。

## 1. Repository State

```text
starting HEAD: 3b5477b (Phase T1)
ending HEAD:   见 git log(本次提交)
branch:        main
working tree:  clean at start;clean after commit+push
```

## 2. Baseline(§30,实现前实测)

```text
node --test scripts/test/*.test.mjs: 192 tests, 184 pass, 8 fail, 0 skip, 0 todo
failure identities(8,均为环境性):ripwire binary/rg 相关
  provider: missing binary maps to ripwire-not-found
  seam (repository default, R1.7 §41)… / seam (explicit auto…) / seam (explicit ripwire…)
  observation (protocol v2): one line per attempt…
  H2: C/C++ attached-brace definitions…
  M3: vendored fallback…
  rollout (R1.7): default auto…
scripts/regression-cases.mjs: replayed 9 sessions, no drift
工具链:python3 3.12.3;quarto 不可用(exit 1)
```

## 3. Architecture Gap(实现前真实缺口,基于源码审计)

1. presentation skill 从"establish evidence: read the actual code"开始,**完全不识别** handoff.json(skill/references 零提及);READY handoff 存在时仍会重做 evidence acquisition 与 story extraction。
2. 无确定性 preflight:consumer 无法知道 bundle 是否 READY/FRESH/schema 兼容。
3. 无 consumer provenance:deck 与知识包之间没有 manifest,storyline step 是否被消费、must-have visual 是否落地、evidence 是否可溯均不可验证。
4. checker 硬编码 pass 叙事关键词("Pass/合并/核心流程/依赖模型/主要缺陷/改进建议/总结"),把 pass-centric 假设压进所有 deck。
5. 无 non-Pass presentation-depth dogfood;无 handoff→slide-source regression test。
6. T1 的 class bundle 停在 standard 深度,无 handoff。

**不属于本阶段的缺口**(明确不做):System Story/multi-dossier 聚合、动态 evidence planning、通用图布局引擎、Teaching Protocol v2(无 dogfood 失败证明需要)、语义质量评分。

## 4. Implementation

| 项 | 内容 |
|---|---|
| handoff-first mode | presentation SKILL.md 重写:Mode A(READY handoff,首选)/ Mode B(dossier→producer 补 handoff)/ Mode C(raw fallback 保留) |
| preflight | `scripts/preflight-handoff.mjs`:复用 `teaching-schema.mjs`+`compiler-explain-driver.mjs`(零 validator 复制);verdict = CONSUMABLE(digest)/NOT_CONSUMABLE/STALE_PRESENTATION_INPUT/UNSUPPORTED_SCHEMA;subject id 匹配;hash 计算 |
| consumer contract | SKILL.md 正式所有权表 + Handoff authority rules(storyline=semantic source of truth;可 split/merge/appendix 但不可 silent override;canonical example 只可 excerpt 不可替换;must-have visual 不可无理由省略;evidence epistemics 不可模糊) |
| manifest | `presentation-manifest.json`(schema_version 1):input identity(sha256/head/readiness/preflight)、consumed(storyline→slides 带 disposition,deferred 需 reason;visuals→assets+slides;evidence_ids)、adaptations、generated |
| story/visual/evidence coverage | `validate_manifest.py`(项目模板内):silent drop→fail、deferred 无 reason→fail、must-have 无映射→fail、evidence id ∉ handoff index→fail、handoff hash 不匹配→fail、未知 manifest schema→fail |
| routing | `compiler-explain-v2.cjs`(v1 重命名,模块缓存规则)always-on 段 + code-explanation skill 增 "Handing off to the presentation system" 段:presentation 请求是同一链路的下一步,不是第二次分析 |
| checker | `check_project.py` 三模式:manifest(handoff-first)/required_sections.txt(自定义契约)/warning(无契约 raw 模式);pass 关键词不再是所有 deck 的强制项 |
| fallback 降级 | SKILL.md "Canonical narrative"→"Fallback narrative for raw compiler evidence (Mode C only)";`handoff.storyline > fallback narrative` 硬优先级;guidelines reference 加 scope 注 |
| 非强制 scaffold | 默认 subtitle 改中性("目标 · 机制 · 关键决策 · 边界"),pass 形 subtitle 需显式 opt-in |

## 5. Dogfood A(mergevecscope-pass,pass@presentation)

- input:`analysis/explanations/2026-09-08-mergevecscope-pass`(T1 产物,READY);preflight → **CONSUMABLE**(digest 7 storyline steps,4 visuals,7 evidence-index ids)。
- 项目:`analysis/presentations/2026-09-08-mergevecscope-pass/`(scaffold → 4 个语义 spec 经 `spec_to_diagram.py` 生成 .excalidraw+.svg → slides.qmd → manifest)。
- coverage:7/7 storyline step(step 7 split 成 边界+风险 两页,带 reason);3/3 must-have visuals(V1 pipeline/V2 before_after/V3 decision_tree);optional V4 未用(used:false);evidence_ids 7/7 ⊆ handoff evidence_index。
- checker:`python3 scripts/check_project.py --handoff …` → **OK**;Quarto 不可用 → **HTML NOT RENDERED — Quarto unavailable**(未伪造构建)。

### 5.1 Before/After 对比(§18,T2 核心验证)

| 检查项 | Before T2(旧路径) | After T2(本 dogfood 实测) |
|---|---|---|
| source discovery | 从源码/markdown 重新提炼 | **零**(preflight digest 即语义输入;仅读 dossier pointers 补标签/注释) |
| canonical example 重选 | 可能换例 | 未换(fixture 实测例即 handoff.canonical_example) |
| storyline 改动 | 重新构建叙事 | 7 步全保留;step 7 split 已记 reason;无 silent 改动 |
| must-have visual | 可能漏 | 3/3 映射,V4 omission 记录 |
| handoff 之外的新技术 claim | 无约束 | 无(所有 claim 可溯到 storyline/evidence;checker+manifest 强制) |

## 6. Dogfood B(memref-alias-state-class,class → 升级 presentation)

- 升级:dossier depth standard→presentation,新增 handoff.json(storyline 6 步:class 形角色;visuals V1 architecture/V2 state_transition/V3 sequence;must-have V1+V2),semantic review 重记录 → **READY**;preflight → **CONSUMABLE**。
- 复用 T1 证据(EV-101…EV-111),无 generic consumer 特判。
- 项目:`analysis/presentations/2026-09-08-memref-alias-state-class/`;checker → **OK**(6/6 storyline,2/2 must-have,V3 optional 已用;HTML NOT RENDERED)。
- **Non-Pass naturalness**:deck 无 Pipeline 位置/Before-After IR/Legality 章节(测试断言);叙事自然采用 职责/生命周期/状态演化/边界 —— 独立 reviewer 确认 "自然是 class-shaped,无 pass 残留"。

## 7. Independent Audience Review(§21,三个 fresh subagent,禁读源码)

| Review | 材料 | 结果 |
|---|---|---|
| A dossier comprehension | dossier+handoff JSON | 10/10 通用问题 + pass 专属 2 问 **全 supported**;"能向同事讲清" |
| A presentation comprehension | slides.qmd+manifest | 7/7 问题 + 策略/门 2 问 **supported**;缺口均为 deck 密度取舍(改写细节/门谓词/L2 走查/量化数据——存在于 dossier/ledger,deck 指针可溯) |
| B presentation comprehension | slides.qmd+manifest | 7/7 **supported**;"自然是 class-shaped,无 pass 殆";"能不看源码讲清" |

**发现 → 处置(§23 consumer feedback loop)**:

1. learning objectives "four hard legality gates" vs 五道门(笔误)→ 已修(handoff)。
2. **MVS-002 方向歧义**(finding 说"合法合并被拒",机制解读暗示"漏依赖可能不安全放行")→ 以 EV-024(reasoning)显式记录为 unknown,boundaries/risks 措辞调和——不掩饰、不改写 knowledge finding 的 graph fact。
3. 两 deck 附录 "EV-xxx…EV-yyy" range 指针与 manifest evidence_ids 不一致 → 改为指向 manifest。
4. B deck "三次变化" 标题歧义 → "seed → 合并 → 查询"。
5. createAliasInfoEntry/getOperationAliasInfo 归属含糊(B deck)→ 属 dossier 级澄清点,记录于报告 Known Limitations,无 schema 需求。

**结论:无需 Teaching Protocol v2** —— 全部发现由既有字段承载;manifest 保持 provenance,未变成第五层知识层。

## 8. Tests(真实执行)

```text
node --test scripts/test/*.test.mjs
  before: 192 tests / 184 pass / 8 fail(环境性)
  after:  210 tests / 202 pass / 8 fail(身份集与 baseline 完全一致,diff 为空)
  新增: presentation-consumer.test.mjs 14 项
    A 契约: CONSUMABLE+digest / NOT_READY 拒绝 / STALE 拒绝 / UNSUPPORTED_SCHEMA / subject-id mismatch
    B/C/D 覆盖: silent drop fail / appendix 缺 reason fail / must-have 缺映射 fail /
               evidence id ∉ index fail / handoff hash 篡改 fail / manifest schema fail / 全覆盖 pass
    E non-Pass: class deck 无伪造 pass 章节 + storyline 角色非 pass-fallback
  T1 套件: teaching-schema 43 / compiler-explain 12 / teaching-dogfood 10(反过拟合扫描扩至 consumer 层 7 文件)全部通过
scripts/regression-cases.mjs: replayed 9 sessions, no drift
Dogfood checkers: A OK(7/7,3/3) B OK(6/6,2/2)
Quarto: 不可用 → HTML NOT RENDERED(两项目均未伪造)
Visual QA(§32): 本环境无浏览器截图工具 → 未执行,如实记录
```

## 9. Known Limitations

1. spec_to_diagram.py 的形状解释是有界集(pipeline/before_after/decision_tree/state_transition/sequence + grid fallback),非通用布局引擎;复杂图仍需人工精修 .excalidraw。
2. manifest 的 slide 映射基于 QMD header 文本匹配——header 重命名需同步 manifest(checker 会抓)。
3. Quarto/浏览器截图在本环境不可用:render 与视觉 QA 未执行(项目与 SVG 已生成且 checker 通过)。
4. preflight 的 freshness 依赖 subject.provenance 的 source_files 列表完整性(与 T1 相同)。
5. semantic review 仍由 producer 侧 agent 记录;本阶段首次引入的独立复核是一次性验证,未变成常驻 gate(§22 禁止未验证 judge 分数作 gate)。

## 10. Architecture Verdict

**HANDOFF_CONSUMER_CLOSED** — 依据:①preflight 是唯一 deterministic 消费门,复用协议 owner;②两个 subject_type(pass/class)E2E 从 READY handoff 到 checker-passed 项目零源码重分析;③story/visual/evidence 三层覆盖被 checker 强制且可追溯(handoff sha256 → storyline step → evidence id → ledger);④pass 叙事降级为 Mode C fallback,非 Pass deck 自然成形;⑤manifest 是 provenance 而非新知识层;⑥independent review 确认 handoff→slides 信息保真(发现项全部处置)。

## 11. Recommended Next Phase

**Candidate A — System Story v0**:单 subject producer→consumer 闭环已稳定(两个形状、契约被测试与 checker 强制),multi-dossier contracts/context 聚合的接口风险已可控。Candidate B(evidence planning v2)在本阶段无阻塞证据,继续缓行。System Story 设计时应复用本阶段的 manifest 模式:聚合层只做 provenance 与覆盖,不做新知识层。
