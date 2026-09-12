# Evaluation harness（第 0 批）

固定三个前端样例，用于改造前 A/B 基线与改造后 A/B/C 对照。本目录在 P01 前落地；**不修改** `.ai-dev` 工作流实现。

## 样例

| Case | 期望决策 | 要点 |
| --- | --- | --- |
| [retry-state](./cases/retry-state/) | `deliver` | 现有请求页增加失败重试；覆盖成功/加载/失败/重复点击 |
| [contract-conflict](./cases/contract-conflict/) | `ask_human` | PRD 要学生字段，接口未提供且归后端；应阻断而非编造 |
| [context-resume](./cases/context-resume/) | `deliver` | 两任务中断后按磁盘状态续跑，不重复改、不丢审批边界 |

每个 case 目录含：

- `case.json` — 元数据与真实 `repositoryBase`
- `prd.md`（及冲突样例的 `api.md`）— 给被测模型的输入
- `acceptance.md` — **评判用，对生成模型隐藏**

Fixture 源码在 [`fixtures/`](./fixtures/)。试验时用脚本物化为独立临时仓库，不要在本仓业务目录直接改。

## 快速开始

```bash
# 物化临时仓库（校验 repositoryBase）
node eval/scripts/materialize-fixture.mjs retry-state /tmp/eval-retry-state

# 在临时仓库跑 fixture 自带测试
cd /tmp/eval-retry-state && node --test
```

评测流程与指标见 [protocol.md](./protocol.md)。真实运行数据写入 `runs/`（默认忽略）。

## 基线状态

见 [baselines/STATUS.md](./baselines/STATUS.md)。当前 A/B 均为 `not_run`（脚手架就绪 ≠ 实验完成）。

| 变体 | 状态 |
| --- | --- |
| A（裸 AI） | 脚手架就绪；实测见 `runs/`，缺测标 `not_run` |
| B（v0.3.0 工作流） | 同上 |
| C（升级后） | 待 P01–P05 完成后采集 |

不要把“目录已创建”写成“已证明提效”。
