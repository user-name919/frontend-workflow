# 独立审核 Skills v1

## 解决什么问题

prepare-review 约束“给审核者什么材料、标准从哪里来”；review-delivery 约束“如何逐项核查、如何给出有证据的结论”。不是给模型一个专家身份就保证质量，而是让标准、版本和结果可以复查。

本版新增两个 Skill、共享 Node 校验器和 18 项自动测试，无第三方运行依赖。现有安装器会发现同级 Skill 目录，两者应一起安装。

## 实际使用

对执行 Agent 说：

> 使用 prepare-review，为这次改动准备 task 阶段审核包。项目根目录为实际业务仓库，需求在指定 PRD，范围为指定改动。请读取实际代码与项目规范，不补造业务规则，列出未决问题并完成 seal/check。

得到 sealed packet 后，启动未参与实现的新 Agent：

> 使用 review-delivery，审核这个 sealed packet。直接检查需求和实际产物，输出 report.json 并执行 report 校验。不要修改实现；需要补证据时明确返回准备者，不把自检当独立审核。

共享脚本位置：`.agents/skills/prepare-review/scripts/review-contract.mjs`。命令参数及完整 JSON 见 prepare-review/references/contract.md。

| 场景 | 怎么处理 | 谁继续 |
|---|---|---|
| 连续两份答卷被占用，代码只跳一次 | revise，给出输入输出与代码位置 | 实现 Agent 修复 |
| 测试没跑或日志已过期 | needs_evidence，补测并重新封装 | Agent |
| 产品未决定网络重试次数且影响当前验收 | needs_human，列明选项与影响 | 产品/负责人 |
| 重试次数属于范围外新增想法 | 非阻塞记录，不卡住当前交付 | 后续需求 |
| 代码或需求在审核后变化 | 摘要失效，重新准备并复审 | Agent |

## 与现有工作流的关系

这是独立审核组件，不接管状态机。其 packet/report 使用独立 v1 契约，**不能直接传给现有 record-review.mjs**。P05 通过 `record-review.mjs adapt`（`lib/review-adapter.mjs`）做 request/ruleId/报告映射；`authorizesGate` 恒为 false。不要仅凭本校验器返回 ok 就推进流程或取消 `scope`/`final` 人工门禁。

## 验证与已知边界

- 自动测试覆盖：需求覆盖、禁止实现作为唯一业务依据、坏输入、过期材料、路径逃逸、自审冒充、缺证据、失败伪装通过、结论分流和测试执行记录。
- 无专用 Skill 的基线模型已能发现示例缺陷，不能声称本版提高了发现率；这版主要验证材料标准化与可审计交接。小样本不构成提效/准确率数据。
- 摘要只能检测已登记文件变化，不发现所有遗漏文件，也不是签名；独立身份和证据真实性仍需运行环境与审核者保证。
- 独立 Agent 同样可能误判。正式减少人工门禁前，应以真实需求积累漏检、误报、补证次数、人工介入率和耗时，不能只统计格式通过率。
- 新跑的验证日志需先登记到材料包并重新 seal；不得为了满足格式伪造结果。

运行验证：`node --test test/review-skills.test.mjs`，全量回归：`npm test`。
