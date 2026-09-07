# Phase R1 实施报告:Ripwire 作为 compiler_inspect 的通用代码上下文后端

日期:2026-09-07 · 实施会话:Compiler Dev goal(Phase R1)· 对接上游:redhat-et/ripwire @ `c7914e8dc8429a318ffe24f857077e2b1d52d62e`

## A. Repository state

- 起始 HEAD:`d0010e12f9c276583ce9a286f119d53fadd03b17`(main,clean)
- 最终 HEAD:`e4b245f7aaafc02f738ad8b138bc1392f67482d3`(单次提交,包含全部 Phase R1 变更)
- 变更文件(15):
  - 新增 `compiler-context-backend.mjs`、`compiler-observation-state.mjs`、`compiler-inspect-v3-4.cjs`(由 v3-3 改名+扩展)、`compiler-knowledge-v3.cjs`(由 v2 改名+小改)、`scripts/test/compiler-context-backend.test.mjs`
  - 修改 `compiler-inspect-driver.mjs`(v1.2→v1.3)、`scripts/analyze-session.mjs`、`agent.cordis.yml`、`README.md`、`ARCHITECTURE.md`(新第 14 章)、`skills/compiler-development/SKILL.md`、`.gitignore`、两个旧测试文件的引用
- 对照仓库仅读:`mlir-compiler-harness`(未改动)、ripwire 上游(临时 clone 到 /tmp 供接口核对;构建产物仅用于本验证,集成自身不含任何安装/构建逻辑)。

## B. Architecture implemented

```text
compiler_inspect(input, backend?)
   → backend policy: input > COMPILER_INSPECT_BACKEND > auto
   → CodeContextProvider(仅通用源码检索交换)
        ripwire   → compiler-context-backend.mjs:--pack-task --json(参数数组 spawn)
                    --token-budget=5084(由 20K 总预算的 12K 切片按 ~2.36B/token 推导)
                    --exclude=<dir>/(契约 exclude_dirs)→ 有界规范化 source_context + disclosures
        legacy-rg → 原 rg/git 检索(原样保留,回退与 A/B 共用)
   → CompilerArtifactProvider(后端无关,always):git 状态/diff/history + MLIR 日志取证
   → 有界规范化结果(20K 硬预算 + Context backend 行)
   → 观测:analysis/feedback/context/<date>.jsonl(每源码检索尝试一行,去敏)
```

关键语义:`auto`=可用即 Ripwire,任何失败/弱结果→受控 legacy 回退(有限原因枚举,绝不静默);`ripwire`=显式,失败返回 degraded 结果,绝不冒充 legacy;`legacy`=强制 rg(回归/A/B)。"not retrieved" 永远不被表述为语义不存在;锚点位于 Ripwire 抓取黑名单/契约排除树时报告 `outside_corpus` 并对 vendored 类目录补窄幅 legacy vendored pass。

## C. Public/tool contract

- **保持兼容**:既有全部输出字段(`repository/anchors/definitions/references/vendored_matches/tests/changes/history/logs/unresolved/budget`)保留且仍必填;`include_tests/include_diff/contract_test_dirs/exclude_dirs/log_*/history_window` 语义不变;legacy 路径下 `source_context=null`,行为与 v1.2 一致(budget.version 1.2→1.3,两处断言随版本更新)。
- **新增输入**(均可选):`backend`(auto/ripwire/legacy)、`task`(检索任务短语;不入观测流)。
- **新增输出**(必填):`backend`(ripwire|legacy-rg)、`fallback`、`fallback_reason`(有限枚举:ripwire-not-found / ripwire-invocation-failed / ripwire-invalid-output / ripwire-timeout / ripwire-weak-result / backend-policy-legacy)、`source_context`(nullable:ranked_symbols/bodies/callers/tests_to_run/far/notes + provider/mode)、`source_disclosures`(nullable:weak/ambiguous/truncated/counts_floor/ranking_capped/各节 kept-total/bodies_omitted/budget 三元组/over_ceiling/bounding_notes)。
- **渲染**:新增一行 `Context backend: <backend> (fallback: <reason|none>) | weak=… ambiguous=… truncated=… counts_floor=…`(分析器的聚合锚点)与 Source context 节,节标题明示 "generic retrieval/ranking evidence — NOT an mlir-repomap semantic fact"。
- **预算**:20K 总预算不变;Ripwire token 目标从同一预算推导(单一预算,不叠天花板),normalizer 裁剪全部披露。

## D. Tests

- 新增 `scripts/test/compiler-context-backend.test.mjs`:28 项,覆盖二进制发现(RIPWIRE_BIN/缺失)、失败/abort/非 JSON、显式 legacy、auto 回退、显式 ripwire 不静默换 legacy、成功 JSON 规范化、弱结果、歧义派生、截断/floors 保留、越界裁剪披露、有界输出、契约 exclude 映射、outside_corpus、log 取证不受影响、schema/渲染契约、观测流隐私/关联/可见回退、分析器聚合、旧会话零基线。Ripwire 以 stub 二进制注入(RIPWIRE_BIN),不依赖真实安装。
- 既有 57 项测试全部通过(2 处 version 断言随 1.2→1.3 更新;插件导入路径随改名更新)。
- 案例回归:`regression-cases.mjs` 9/9 会话与基线**零漂移**;旧会话零 Ripwire 调用 = 诚实基线,未回填、未重解释。

## E. Real-repository validation(AscendNPU-IR @ 90037fe33,真实 checkout)

A/B 通过 backend 输入选择(无源码改动),经真实 `inspectCompilerRepository` 接缝运行;两边同样锚点、同样契约参数(`exclude_dirs:["third-party"]`、`contract_test_dirs:["bishengir/test"]`)。

| Case | Backend | 延迟(热) | 结果大小 | fallback | weak/truncated | 锚点命中 |
|---|---|---|---|---|---|---|
| A MergeVecScope(`MergeVecScopePass`/`runOnOperation`/`mergedFunc`) | ripwire | 2.55s | 7.5KB | no | weak=false / truncated=true(disclosed) | MergeVecScope.cpp ✓ createMergeVecScopePass ✓ runOnOperation ✓;`mergedFunc.verify` 调用点 ✗(legacy ✓) |
| A 同上 | legacy-rg | 1.47s | 5.0KB | no | — | 全部 ✓(文本引用级) |
| B AutoVectorizeV2(finding 复查角度) | ripwire | 2.49s | 6.5KB | no | weak=false / truncated=true | AutoVectorizeV2 ✓ + 两个 loop-carried pattern 名均 ✓(legacy 漏其一) |
| B 同上 | legacy-rg | 1.41s | 5.8KB | no | — | AutoVectorizeV2 ✓,pattern 命中 1/3 |
| C RegBase pipeline builder | ripwire | 2.43s | 5.3KB | no | weak=false / truncated=true | HFusionRegbasePipelines.cpp ✓ forRegbased ✓ RegbasePipelines ✓ |
| C 同上 | legacy-rg | 1.37s | 4.4KB | no | — | 同 ripwire |

补充事实:
- 冷抓取(配置排除后)~2.2s;`tests_to_run` 在本语料 3 例均为 0(诚实披露,ripwire 的 testmap 未映射锚点文件)。
- 歧义披露命中真实语料怪象:`bishengir/…` 与 `bishengir/hivmc/bishengir/…` 两份平行副本 → ambiguous=2(Case A)。
- **语料边界实测(§13)**:`third-party/`(连字符,4.3G)不在 ripwire 内置黑名单(下划线拼写);朴素抓取 >6min、RSS>12GB;契约 `exclude_dirs` 映射 `--exclude` 后即恢复 ~2.2s。gitignored `build*/`(约 10G)默认即被剪。
- discovery-search-after-context / 首读文件:本次为隔离 A/B,无生产会话日志可测,不做臆测;生产度量依赖观测流 + analyze-session(已就绪)。

## F. Findings

**Confirmed implementation facts**
- Ripwire `--pack-task --json` 结构稳定且机器可读:ranked/bodies/callers/tests/far + kept/total/capped 预算事实齐备,规范化无需发明任何字段;截断/下限语义完整可映射。
- 单一预算映射可行:5084-token 目标的天花板(~11.8KB)天然落在 12K 切片内,无双重上限。
- 显式 `ripwire` 失败的 degraded 路径、弱结果回退路径、outside_corpus 报告均有测试钉住。

**Measured observations**
- 三例任务形状上锚点覆盖与 legacy 相当且各有强项:结构/函数体/1-hop 调用面(ripwire)vs 廉价文本引用(legacy);Case B 上 ripwire 严格更优,Case A 的单一调用点文本 legacy 更优。
- 延迟:ripwire 热态 ~2.4-2.5s vs legacy ~1.4s(均在预算内;冷抓取一次性 ~2.2s,另有 >6min 的朴素抓取反例——必须走契约排除)。

**Remaining uncertainties**
- n=3 的隔离 A/B,无生产会话证据;analyzer 的 backend/fallback/weak 计数与 discovery-after-context 指标需真实会话积累。
- `mergedFunc.verify` 类"函数体内具体调用点"是否值得 Phase R2 的 semantic-anchor 融合或 `--for` 补充,待生产证据。
- `tests_to_run` 在 AscendNPU-IR 恒为 0 的原因(testmap 依赖测试目录命名/运行器约定)未深究。

**Future candidates**
- Phase R2:compiler_knowledge → 语义锚点规范化 → compiler_inspect/Ripwire(本阶段明确未做)。
- `--partition` fan-out、`--situ`/post-edit 集成、`bodies` 红acted 对比 legacy vendored 的 A/B 扩展。
- Repository Contract 模板增补一行:Ripwire 后端的 `exclude_dirs` 必须包含 `third-party` 类连字符 vendored 目录。

## G. Promotion decision

**KEEP_RIPWIRE_EXPERIMENTAL**

依据:集成在生产形态上成立(有界、可观测、回退可见、契约不破坏、85/85 测试 + 9/9 回归零漂移),且三例真实任务显示锚点覆盖与 legacy 相当、无一次回退或弱结果——足以否决 REJECT。但默认推广尚缺:(1) 真实生产会话的 backend/fallback/weak 与 discovery-after-context 度量(观测流与分析器已就绪,等待会话积累);(2) AscendNPU-IR 契约显式登记 `third-party` 排除(否则朴素抓取不可用);(3) Case A 暴露的"具体调用点"盲区没有结论。当前部署宿主无 ripwire 二进制,生产默认行为保持 legacy —— 这正是"实验性、按需启用"的准确定位。
