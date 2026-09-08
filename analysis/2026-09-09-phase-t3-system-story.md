# Phase T3 — System Story v0 / Multi-Subject Teaching Composition(最终报告)

日期:2026-09-08/09 · 分支:main · 目标:goal-c0eea158(Phase T3)

## Repository State

```text
starting HEAD  b7dc489 (Phase T2: presentation consumer closure)
ending HEAD    19764f9 (Phase T3: system story composition; report recorded in follow-up commit)
branch         main(jingchangshi/compiler-dev-harness)
tree at start  clean(与 origin/main 同步)
```

分析对象:AscendNPU-IR @ `90037fe3371cb88d50c42cd4e165075cbafe83b1`(master,分析期间未移动;该仓库只读)。

## Baseline

```text
tests before        206(pass 198 / fail 8)
failure identity    8 项全部为 Ripwire 环境依赖的既有失败:
  compiler-context-backend.test.mjs ×5(:235/:310/:324/:372/:481)
  compiler-inspect-driver.test.mjs ×2(:91/:124)
  context-evidence.test.mjs ×1(:88)
case regression     scripts/regression-cases.mjs → replayed 9 session(s): no drift
CI availability     no repository CI observed(无 .github/,无 status checks)
```

## Architecture Audit(为何 T1/T2 尚不能直接做 multi-subject story)

以当前源码为准的十条结论(goal §0):

1. **T1 Teaching Artifact Protocol v1 边界**:`scripts/teaching-schema.mjs`(纯函数)= 11 种 subject_type 的 common core + 恰一个 extension、七类 evidence ledger(按 class 强制工具负担)、机械 readiness 门、HEAD+file-hash staleness;`compiler-explain-driver.mjs` 持有 bundle IO(plan/validate/readiness/stale)。**完全单 bundle,没有任何跨 bundle 概念**(`ARTIFACT_FILES` 五件套、`validateBundle` 只看一个 bundle)。
2. **T2 consumer contract 边界**:`scripts/preflight-handoff.mjs` 一道确定性门(CONSUMABLE / NOT_CONSUMABLE / STALE_PRESENTATION_INPUT / UNSUPPORTED_SCHEMA)+ bounded digest,复用协议 owner 不复制 validator;deck 侧 `presentation-manifest.json` + `check_project.py` 强制覆盖。
3. `workflow`(participants/flow/contracts)、`component_group`(components/interactions)、`subsystem`(components/architecture_boundaries/external_interfaces)、`pipeline`(stages/stage_order_evidence/representation_boundaries)扩展字段均已存在——**系统故事需要的 schema 词汇已经就位**。
4. 不能引用另一个 explanation bundle:协议无任何 bundle 间引用机制。
5. evidence ledger 无法安全表达"事实来自另一个 READY child bundle":source_fact 强制 file:line refs、graph_fact 强制 graph 工具——把 child JSON 当 refs 是类别错误。**这是真实 protocol gap**(goal §12 预判正确)。
6. staleness 不递归:`stalenessForBundle` 严格单 bundle。
7. presentation preflight 可以消费"任何 schema 合法的 bundle dir"(loadBundle 忽略陌生文件),所以一个系统级 handoff **形状上**可通过;但 child 失新无从感知。
8. 无任何 multi-bundle/system-story 实现。
9. 可复用:全部 validators、readiness 门、loadBundle、staleness 原语、preflight 门、presentation skill + checkers、subject taxonomy。
10. 不可重做:evidence 纪律、dossier/handoff 校验、机械门、preflight、manifest checker、staleness 原语、visual spec 校验——全部原样复用,零重实现。

## Composition Design

```text
6 个 READY child bundles(1 复用 + 5 新建)
        ↓ compose-preflight(确定性门:READY+FRESH/唯一 id/同 repo/同 HEAD)
composition.json(provenance:dispositions/context nodes/bridges/representation
                 boundaries/imports(含 child evidence.json sha256)/conflicts)
        ↓
普通 TeachingDossier(subject_type=pipeline,presentation depth)
普通 PresentationHandoff(9 步 adaptive storyline + 4 semantic visuals)
        ↓ 同一个 preflight-handoff(CONSUMABLE)→ 同一个 presentation consumer
QMD + Excalidraw/SVG + manifest(checker PASS;Quarto 不可用,HTML NOT RENDERED)
```

新增文件:`scripts/composition-schema.mjs`(纯)、`compiler-compose-driver.mjs`(I/O);改动:`teaching-schema.mjs`(id space + composition 交叉检查挂接,向后兼容)、`compiler-explain-driver.mjs`(composition.json 载入、imports 解析、**递归 staleness** 单一入口)、`preflight-handoff.mjs`(imports 感知,无 system 特判)、`compiler-explain-v2.cjs`(v2.1:compose-preflight/plan/validate/render 四命令)。

关键决定:

- **composition.json 是 provenance,不是第五知识层**:requested_components ↔ components 双向集合相等(§29 无静默消失)、context-only 节点免 dossier、relation 自由文本(非 compiler enum)、每桥必有 flow_type(data_flow/control_flow 分离,§24)+ 跨越契约 + 证据。
- **递归 staleness 单一入口**:`stalenessForBundle` 对 composition bundle 聚合 system + 每个 child + child HEAD 漂移 + import hash 漂移;T2 preflight 经同一入口免费获得递归(§16),消费者零特判(§39)。
- **增量刷新**:compose-preflight 逐 child 报 verdict,只刷新被拒者(dogfood 中两次被拒的 child 修复后重跑,未触碰其余)。
- **异构与防过拟合**:generic 层零 compiler 概念(composition-schema/compose-driver 已加入 dogfood generic-layer 扫描);同 engine 直接吃 class+function fixtures(scripts/test/composition.test.mjs hetero/preflight 七拒绝)。

## Evidence Import Decision

```text
Protocol v1 sufficient —— schema_version 保持 1,未 bump v2
```

机制:evidence id space(parent ledger ∪ imports)。child 事实以 `alias::EV-ID` namespaced 引用;`composition.json.imports` 记录 alias → child bundle + subject_id + **evidence.json sha256** + head。child 缺失 / ref 不存在 / **hash mismatch** → compose-validate fail、readiness not_ready、preflight 拒绝。child 的 class 原样继承——**imported reasoning 永不升格为 fact**(测试:bridge 标 fact 却只引 child reasoning → fail;改标 reasoning → pass)。observed blocker(v1 无法表达之处)通过**新增 id space 解析器**而非 schema 变更解决:单 subject workflow 与全部 v1 bundle 行为不变(43 项 v1 schema 测试原样通过)。

## Dogfood(真实 multi-pass compiler story,非 synthetic)

Requested(用户候选名单,全部纳入):HFusionFlattenOps、PropagateReshape、AutoVectorizeV2、MergeVecScope、MarkStrideAlign、EnableStrideAlign。

- **canonical pass identity 与真实管线位置全部从源码解析**(不照搬 prompt 假设):`hfusion-flatten-ops`/`hfusion-auto-vectorize-v2`/`hfusion-merge-vf`/`propagate-reshape`/`hivm-mark-stride-align`/`hivm-enable-stride-align`;HFusion 级 `buildHFusionRegBasePipeline`(:567-592)、`hfusionAutoVectorizePipeline`(:399-466);HIVM 级 `bufferizationPipeline`(:227-270,L1/L2 互斥双位置)、`alignStoragePipeline`(:485-494)、post-bufferization 调用(:560,:695→:699)。
- **如实画出的非直线性**:L1/L2 是 if/else 互斥选项而非先后;PropagateReshape 的 HIVM 级位置 anti-regbase(regbase 上只在 HFusion pre-flatten 位参与);flatten→AV2 的紧邻是 Triton-path 条件(enableSIMDVFFusion ≡ enableTritonKernelCompile);`hfusion-flatten-ops` 与 `hivm-flatten-ops` 是**两个不同 pass**(context 节点显式防混淆)。
- **Bridges(7 条,全部 evidence-backed)**:reshape→flatten(precedes,fact)、flatten→AV2(normalizes-for,fact,high)、AV2→MergeVecScope(produces-for,fact,high:`hivm::isVF` 即 attr 契约)、merge→bufferize(precedes,fact)、bufferize→merge(enables,fact/medium)、mark→enable(marks-for,fact,high)、flatten→hivm-flatten(防混淆 boundary)。双向 reconciliation:各 child 的上下文声明与管线跨度一致(如 mergevecscope EV-012 ≡ SYS-EV-003),无 composition conflict(conflicts: [],依据见 composition notes);child 内部歧义(mergevecscope EV-024)留在 child。
- **Representation boundaries(4)**:多维 tensor → 1-D;scalar → VF callees(runtime frame);tensor → memref;unmarked → 标注 → aligned alloc(runtime frames)。
- **System mental model**:normalize → vectorize → merge → bufferize → merge → align 的九阶段端到端流;system invariants(签名不变、元素序不变、VF attr 为稳定契约、标注不悬挂)与 system boundaries(无全链测试、V1 可选但回退已除、anti-regbase 条件、membase stamp 无 reader)。
- **End-to-end example**:STITCHED 七帧(4 帧 compose 侧真实执行 + 2 帧 child 已执行 merge + 1 帧重构 bufferize),每帧标注来源,**显式声明非单次执行**(SYS-EV-015 unknown)。

## Reuse Metrics

```text
child bundles reused                    1(2026-09-08-mergevecscope-pass,READY+FRESH,零重分析)
   (另:memref-alias-state-class 作为 context 指引引用,未纳入组件集)
child bundles refreshed                 0(六个 child 全部 FRESH,无需刷新)
new child bundles created               5(flatten/reshape/av2/marksa/ensa,各自独立分析)
cross-component evidence queries        父 ledger 15 条:9 source_fact(管线跨度+pass 声明)+ 4 runtime_fact
                                        (bishengir-opt 真实执行:flatten/AV2+outline/mark/enable)
                                        + 1 reasoning(因果合成)+ 1 unknown(无全链测试)
child internal source re-analysis       0(READY+FRESH child 的 dossier 知识只经 imports 消费,
                                          未重读重推任何 child 内部机制;compose-validate/preflight
                                          只读 JSON 与 hash)
```

## System Presentation

```text
system handoff readiness  ready(mechanical 含 composition 交叉检查全 pass + semantic review 12/12)
preflight result          CONSUMABLE(scripts/preflight-handoff.mjs,零 consumer 特判)
storyline coverage        9/9 consumed(step 9 split,带 reason——manifest)
must-have visual coverage 2/2(V1 pipeline、V2 state_transition);optional V3 备用、V4 已用
checker result            check_project.py: structure OK + manifest coverage complete
                          (validate_manifest.py 含 handoff/dossier/composition sha256 交叉校验)
render result             HTML NOT RENDERED(quarto 不可用,诚实报告)
visual QA result          VISUAL QA NOT RUN(同上);SVG 几何做了程序化检查(0 overlap、内容包含于 viewBox)
```

## Audience Review(独立 fresh subagent,禁读源码)

**Round 1(只读 system-story.md)**:10 问 7 supported / 2 ambiguous / 0 missing-distorted。WHOLE>SUM:**明确通过**——"child 一页纸无法供给"清单:双路径分歧下的链序(Triton/非 Triton flatten 位置;L1/L2 互斥)、`hivm.vector_function`+no_inline 发现契约、mark schema 与 no-op/error 不对称、双同名 flatten 陷阱、四步表示阶梯、拼接例子的诚实边界——**非 concat 成立**。
**Round 2(只读 deck)**:10 问 6 supported / 3 ambiguous / 0 missing-distorted;诚实标注被评为最强面。修复清单及处置:

| 发现 | 处置 |
|---|---|
| handoff 证据索引 SYS-EV-015 重复、SYS-EV-007 悬挂 | 已修复(dedupe + 补录) |
| Frame 3 把 L1/L2 并在 bufferize 之前,与 L2 定义矛盾 | 已修复:拆为 Frame 3(L1)/Frame 5(L2)按链序排列,并注明"同一 pass 的两个互斥位置,非序列" |
| mark 32B vs enable 64B 无就地解释 | 已修复:两帧就地注明(BL=VL/8 默认 vs LCM 统一后,不同 fixture) |
| flatten→AV2 契约中 memref load/store 措辞混淆层级 | 已修复:契约收敛为 tensor 级,寄存器索引调整归 child |
| slide 6 "已移除 fallback" vs slide 10 "仍在" | 已修复:区分管线选项与失败语义两句话 |
| "六种表示" vs 图中状态数 | 已修复:改为"表示状态链"并显式计数(8 框含输入态;L1/L2 为互斥支路) |
| 三张 SVG viewBox 裁切/框重叠/L2 方向 | **generic 层修复**:spec_to_diagram/make_excalidraw 的布局与 viewBox 改为按实测文字宽度流式布局 + 内容包含式 viewBox(全部 deck 受益);V2 spec 重设计为无回边线性可选支路;程序化验证 0 overlap |
| 证据 ID 密度过高 / context 阶段黑盒无说明 | 已缓解:正文 ID 降密,map 页补黑盒说明;full index 仍在 handoff + story doc |
| 缺 first-use glossary / deferred 清单 / IR 片段 | deferred 清单已由 renderer 新增小节解决;glossary 与 IR 片段记入 Known Limitations |
| deck 未引用 V3.svg | 非静默丢弃:manifest optional_visuals 记录 disposition 与理由 |

## Tests

```text
baseline          206 tests / 198 pass / 8 fail(既有 Ripwire 环境失败集)
after             238 tests / 230 pass / 8 fail —— 失败身份集与 baseline 完全一致,零新增
new               scripts/test/composition.test.mjs 32 项:
                  preflight 七拒绝(READY+FRESH 通过/NOT_READY/STALE/UNSUPPORTED_SCHEMA/
                    重复 id/跨 repo/HEAD 漂移)
                  imports 五纪律(解析/缺失 ref/hash 漂移/class 保持/reasoning 不升格)
                  integrity 五项(coverage 双向/bridge 无证据/open conflict 阻塞/
                    context-only 允许/child detail 引用即合规)
                  system readiness(无 mental model/无端到端流/无 bridge/无边界 → NOT_READY;
                    完整 → READY)
                  presentation 回归(CONSUMABLE + child 失新→STALE_PRESENTATION_INPUT)
                  异构(class+function→component_group,零引擎改动)+ renderer + 反过拟合
                  真实 dogfood 回归(已提交 artifact:composition 校验/coverage 下限/
                    readiness/preflight/manifest checker)
existing suites   teaching-schema 43 ✓ · compiler-explain ✓ · teaching-dogfood ✓(扫描名单
                  扩至 composition 两个新文件)· presentation-consumer ✓
case regression   replayed 9 session(s) against the baseline: no drift
```

## Known Limitations

1. 无全链单一测试:端到端例子是显式标注的拼接帧;bufferize 帧为重构。
2. system-story.md 无 first-use glossary,IR 片段未内嵌(依赖 child dossier)。
3. v0 限同 repo/同 HEAD;multi-repo/版本对比未做(按 goal §56 排除)。
4. compose 无一键 orchestration:preflight→child 创建/刷新→compose→render→deck 仍由 agent 分步驱动。
5. Quarto 不可用:HTML NOT RENDERED、VISUAL QA NOT RUN(SVG 已程序化几何检查)。
6. deck 正文的证据 ID 对现场听众不可解析(已降密,索引在 handoff/story doc)。
7. membase(A2/A3)侧 placement 只作为边界提及,未成体系(child 材料可扩展)。

## Architecture Verdict(§59/§60 逐条)

1. 真正复用 child bundles?**是**(MergeVecScope 零重分析;compose 只读 JSON+hash)。
2. child evidence copy-paste?**无**(namespaced imports + hash 锚定;测试断言父 ledger ≤20 条)。
3. cross-component relations 有 provenance?**是**(每桥 evidence_refs,id space 强制可解析)。
4. 静默解决过 conflict?**没有**(conflicts 空且经双向 reconciliation 核实;测试证明 open conflict 阻塞)。
5. system story 是拼接?**不是**(audience WHOLE>SUM 复核:链序双路径分歧、跨 pass 契约、表示阶梯、诚实边界均"child 一页纸不可得")。
6. workflow/component_group/subsystem/pipeline 抽象足够?**是**(dogfood 用 pipeline;异构 fixture 用 component_group)。
7/8. 是否需要 Protocol v2?**不需要**(observed blocker 以 id space+imports 解决;schema_version=1 不变;43 项 v1 测试原样通过)。
9. T2 consumer 有 system 特判?**无**(preflight/checker 零改动即消费;imports 感知是 bundle 级 provenance 处理)。
10. 异构成立?**是**(class+function→component_group 零引擎改动)。
11. staleness 递归?**是**(system+child+HEAD+import hash;preflight 免改获得;测试覆盖)。
12. 增量刷新成立?**是**(compose-preflight 逐 child verdict,dogfood 中仅修复被拒 child)。

**SYSTEM_STORY_COMPOSITION_READY** —— 依据:真实 ≥6 组件 dogfood 全链闭环(child bundles→composition→system dossier→handoff→preflight CONSUMABLE→deck→checker PASS)、独立受众复核通过且 whole>sum 成立、既有测试零新增失败身份、递归失新/增量刷新/反过拟合/异构均有测试与真实使用佐证。

## Recommended Next Phase

**A. System Story Productionization(自动 orchestration)** —— 理由:dogfood 证明能力成立,但用户一句"梳理 A、B、C 并做 slides"仍需 agent 手工驱动 compose-preflight→子 bundle 创建→compose→render→deck 脚手架→manifest 六段流程;orchestration(自动发现 requested 组件的既有 bundle、自动门控、自动 deck 脚手架)收益最大。Evidence Planning V2(B)与 mlir-compiler-harness 图事实扩展(C)暂无必要:本次跨组件证据主要靠管线跨度源事实 + 4 次真实执行即可支撑全部 bridge。

## Git

```text
final commit    19764f9 "Phase T3: system story composition (multi-subject teaching closure)"
                (59 files, +13724/−58; followed by this report-record commit)
push            git push origin main → b7dc489..19764f9, remote main contains the commit
working tree    clean
```
