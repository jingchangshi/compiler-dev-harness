# MergeVecScope 示例故事板

仅作为结构示例；不能替代真实仓库验证。

## 推荐结构

1. **封面**：`MergeVecScope`；副标题仅保留 `目标 · Pipeline · IR · 合法性 · 缺陷`。
2. **为什么要合并 VF？**：说明目标是减少 VF 间数据搬运，而不是单纯减少函数数量；使用 `problem.excalidraw/.svg`。
3. **Pass 在哪里执行？**：同一张 pipeline 图展示 level=1 在 bufferization 前、level=2 在后。
4. **合并前**：最小示意 IR；指出两个 VF call、between ops、数据流。
5. **合并后**：一个 merged call；VF1 结果通过 IRMapping 变成内部依赖。
6. **核心流程**：收集 → 排序 → alias/依赖分析 → use score/VF graph → 贪心合并 → 更新状态 → 清理。
7. **依赖模型**：SSA、memory/alias、VF graph 三层关系必须分开画。
8. **tryMerge 在判什么？**：extract-kind、same-region、sync reject、pinned ops、movement、SplitMove、rewrite path。
9. **两条改写路径**：`mergeNoBetween` vs `mergeNoMemory`。
10. **主要缺陷**：用表格展示问题、证据、后果、优先级。
11. **改进建议**：P0 正确性、P1 稳健性、P2 收益。
12. **总结**：本质 / 价值 / 风险各一句。

## 写作规则

- 正文中文为主；保留必要 English identifiers。
- 标题保持短，不写成长句结论。
- 图中只放短标签，细节放正文。
- `.excalidraw` 是图的源文件，`.svg` 是 QMD 引用的构建输入。
- `slides.qmd` 是 presentation 的主要 source of truth，HTML 是 Quarto build output。
