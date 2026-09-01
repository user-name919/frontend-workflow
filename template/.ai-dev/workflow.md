# PRD-to-Code 工作流

## 状态

```text
INGEST
  -> SCOPE_REVIEW
  -> SPEC_REVIEW
  -> PLAN_REVIEW
  -> IMPLEMENTING
  -> VERIFYING
  -> FINAL_REVIEW
  -> COMPLETE
```

任何状态都可以转为 `BLOCKED`。只有在 `status.json` 中记录了人工批准后，才允许通过审核点。

## 证据标签

| 标签 | 含义 | 能否转为任务？ |
| --- | --- | --- |
| `CONFIRMED` | 来源文档中已明确说明 | 是 |
| `USER_CONFIRMED` | 已由人工审核者明确确认 | 是 |
| `CODE_EVIDENCE` | 已通过仓库代码直接证实 | 是，但必须与范围一致 |
| `INFERRED` | 合理但未明确写出的推断 | 否 |
| `CONFLICTED` | 不同来源之间存在冲突 | 否 |
| `CONTRACT_GAP` | 接口字段或职责归属无法端到端闭环 | 否 |
| `NOT_LOCATED` | 当前仓库中不存在对应实现 | 否 |
| `OUT_OF_SCOPE` | 属于后端、其他仓库或已排除的系统 | 否 |

## 职责分类

- `FRONTEND_BEHAVIOR`
- `BACKEND_DATA`
- `API_CONTRACT`
- `CROSS_REPOSITORY`
- `DESIGN_ASSET`
- `VERIFICATION`
- `UNKNOWN`

只有已批准的 `FRONTEND_BEHAVIOR`、`API_CONTRACT` 消费侧事项和 `VERIFICATION` 事项，才能进入当前仓库的实施计划。

## 阶段 1：INGEST

1. 在 `source-index.md` 中登记每个来源的标题、类型、路径、版本和敏感级别。
2. 从复制的摘录中移除凭据、访问令牌、Cookie 和个人数据。
3. 检查仓库规则、技术栈、Git 状态、相关命令和源码目录结构。
4. 如果 `.ai-dev/config.json` 中配置的 `frameworkGuide` 存在，则读取该文件。
5. 不得修改业务代码。
6. 生成 `scope.md`、`evidence.md` 和 `open-questions.md`。
7. 将状态转为 `SCOPE_REVIEW`，然后停止。

## 审核点 1：SCOPE_REVIEW

请人工确认：

- 目标仓库和功能边界；
- 前端、后端及跨仓库事项的职责归属；
- 已排除的需求；
- 尚未解决的冲突和未知事项。

在人工记录 `approvals.scope` 之前，不得继续。

## 阶段 2：SPEC

1. 在 `frontend-spec.md` 中描述可观察的前端行为。
2. 添加稳定的需求 ID 和验收标准。
3. 除非已批准的约束明确要求，否则不得写入具体实现选择。
4. 更新 `traceability.md`。
5. 将状态转为 `SPEC_REVIEW`，然后停止。

## 审核点 2A：SPEC_REVIEW

必须关闭所有阻断性问题，并由人工记录 `approvals.spec`。

## 阶段 3：PLAN

1. 将需求映射到当前文件、符号、路由、状态、API 和验证命令。
2. 生成范围精准的 `implementation-plan.md`。
3. 在 `tasks.md` 中将工作拆分为可独立验证的任务。
4. 标记所有尚未定位的事项；不得创建基于推测的文件。
5. 将状态转为 `PLAN_REVIEW`，然后停止。

## 审核点 2B：PLAN_REVIEW

必须由人工审核计划修改的文件、任务顺序、契约假设和验证方案，并在 `approvals.plan` 中记录批准信息。

## 阶段 4：IMPLEMENTING

1. 再次检查 Git 状态，并保留已有修改。
2. 每次只执行一个已批准的任务。
3. 除非新的发现已经过审核，否则每次差异都必须限制在任务声明的文件范围内。
4. 执行该任务对应的验证。
5. 更新任务状态和追踪关系。
6. 当范围发生变化、出现契约缺口，或无法确保验证结果可信时，停止实施并返回审核阶段。

## 阶段 5：VERIFYING

1. 执行已经配置且实际存在的 lint、类型检查、测试和构建命令。
2. 执行能够自动化的验收检查。
3. 在 `verification.md` 中记录准确的命令和执行结果。
4. 列出需要人工执行的检查和剩余风险。
5. 将状态转为 `FINAL_REVIEW`，然后停止。

## 审核点 3：FINAL_REVIEW

展示代码差异、追踪关系、验证结果、未验证事项和回滚说明。在进入 `COMPLETE` 之前，由人工记录 `approvals.final`。
