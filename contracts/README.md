# Centralized Repository Contracts

本目录集中跟踪各目标编译器仓库的 agent 契约（`AGENTS.md` / `AGENTS.local.md`），
使契约演进在本仓库有统一的版本历史。agent 对目标仓库契约只能提案、不能直接写入；
将本目录中被批准的改动应用回目标仓库由人类完成。

## Layout

```text
contracts/
  AscendNPU-IR-Dev/
    AGENTS.md         repository-level contract（集中跟踪副本）
    AGENTS.local.md   host-specific contract（集中跟踪副本）
```

## AscendNPU-IR-Dev 副本来源与合并记录（2026-09-07）

- 基线：`/home/shijingchang/workspace/AscendNPU-IR-Dev/AGENTS.md` 与
  `AGENTS.local.md` 的当日快照，逐字复制。
- 在基线之上合并以下内容：
  - `AGENTS.md` §1 新增 **Source-context boundaries**（用户批准的建议文本）：
    `compiler_inspect` / Ripwire 的 source-context exclusions 固定为
    `third-party`、`build`、`build-*`、`out`；主语料为项目自有源码树，
    vendored/submodule 代码仅在任务明确需要时检查。
  - `AGENTS.md` §1 新增 **hivmc/ A5 mirror tree**（提案 4，
    `analysis/contract-proposals-2026-09-06.md`）。
  - `AGENTS.md` 新增 §15 **Compile Pipeline Log Forensics**（提案 1），
    原 §15 Updating This Contract 顺延为 §16。
  - `AGENTS.local.md` 新增 §3 **Toolchain Paths and Standard Repair (this host)**
    （提案 2，填补原编号空缺的 §3）。
- **未纳入**：提案 3（Triton-distributed-ascend 按-HEAD 跑 E2E 的批准程序），
  按用户指示暂忽略；提案 5 仅为已落地实现的核对清单，无需写入契约。
- 事实性修正：基线中所有 `third_party/` 拼写（§1/§4/§6）统一更正为
  `third-party/`（仓库实际目录与 submodule 路径均为连字符拼写；`.gitmodules`
  可证）。

## 同步策略

- 本目录是集中跟踪母本（tracking master）；目标仓库中的部署副本由人类
  按需从本目录回写。
- 修改目标仓库契约（或从目标仓库回灌更新）时，先更新本目录并在上方
  合并记录中追加一行，再形成独立 commit。
