# 评测协议（基线与对照）

本协议用于固定输入、固定验收、可比对记录。不得编造耗时、Token、模型 ID 或提效结论。

## 变体

| 变体 | 含义 |
| --- | --- |
| A | 无约束直接使用 AI（不安装/不走本工作流 Gate） |
| B | 现有 v0.3.0 工作流（改造前） |
| C | 升级后工作流（P01–P05 完成后） |

第 0 批只要求具备采集 A/B 的能力与样例；若当时无法运行，`outcome` 记为 `not_run`，禁止填 `0` 冒充已测。

## 单次运行步骤

1. 用 `node eval/scripts/materialize-fixture.mjs <case-id> <temp-dir>` 从 fixture 生成独立临时 Git 仓库。
2. 核对输出的 `repositoryBase` 与 `eval/cases/<case-id>/case.json` 中字段一致。
3. 仅向被测模型暴露 `inputFiles` 列出的材料；**不要**把 `acceptance.md` 交给写代码的模型。
4. 固定并记录：宿主工具名与版本、模型标识、workflow 仓库 commit、原始 prompt、材料 content hash、开始/结束时间。
5. 按 case 的 `expectedDecision` 评判：
   - `deliver`：应交付可验证改动并通过验收项；
   - `ask_human`：应指出缺口/冲突并等待确认，不得编造接口字段或越权实现。
6. 将运行记录写入 `eval/runs/`（该目录默认被 gitignore）。字段以 P06 Task 2 schema 为准；Task 2 落地前可用同名字段的 JSON 手工记录。

## 必记指标

| 字段 | 含义 |
| --- | --- |
| `wallClockMs` | 从开工到可验收或正确阻断的挂钟时间（含等待与审核） |
| `humanActiveMs` | 人工真正阅读、改稿、批准、纠偏的时间 |
| `humanInterventions` | 主动纠偏 / 补材料 / 批准次数（与 `userTurns` 分开） |
| `userTurns` | 对话轮次 |
| `outcome` | `delivered` \| `correctly_blocked` \| `failed` \| `not_run` |
| `acceptancePassed` / `acceptanceTotal` | 按隐藏验收文件逐项勾选 |

Token / 费用不可得时填 `null`，统计时计为 unknown，不得用估计值填满。

## A/B 基线采集（改造前）

对每个 case，在改造前尽量各跑至少 1 次 A 与 1 次 B：

- 同一 `caseId`、同一 `repositoryBase`、同一输入材料 hash、同一模型与工具版本才可与后续 C 配对。
- 失败样本必须保留，不得只留成功样。
- 若工具/模型不可用：写一条 `outcome=not_run` 的记录，并在 `limitations` 说明原因。

样例脚手架完成 **不等于** 基线实验完成。

## 操作者约束

- 同类提问使用固定答复脚本，不向某一变体额外泄题。
- 任何偏离（提示、改需求、跳过 Gate）写入该次 `limitations`。
- `contract-conflict` 正确阻断计为预期成功，不算“没写代码失败”。
