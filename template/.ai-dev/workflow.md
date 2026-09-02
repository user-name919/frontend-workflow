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

`state` 只表示当前执行阶段，不承担产物版本管理。`status.json.consistency` 单独记录产物修订号、过期产物和最近一次变更。因此，修改上游产物时保持当前 `state`，在当前阶段同步刷新下游产物并重新完成受影响的人工审核，不通过回退状态重跑整个流程。

## 产物一致性

修改已经生成的产物前执行：

```bash
node .ai-dev/scripts/update-consistency.mjs <change-dir> mark <artifact>
```

脚本根据 `.ai-dev/artifact-graph.json` 标记传递下游产物，并清除受影响的历史批准。Agent 必须读取 `status.json.consistency.staleArtifacts`，在当前状态内更新相关产物。只对确实已经刷新的文件执行：

```bash
node .ai-dev/scripts/update-consistency.mjs <change-dir> resolve <artifact...>
```

存在过期产物时不得通过任何审核点。重新审核只恢复受影响的批准，不改变当前执行阶段。

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
3. 检查目标仓库自己的说明文件、依赖清单、锁文件、脚本、构建配置、源码结构和 Git 状态。
4. 根据仓库证据判断框架、版本、包管理器、代码规范和可用命令；不得依赖工作流预设的项目类型或版本矩阵。
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

1. 确认 `approvals.plan` 已由人工填写，然后执行 `node .ai-dev/scripts/init-worktree.mjs <change-dir>`。
2. 仅通过 `<change-dir>/project` 软链检查、修改和验证业务代码；该软链指向隔离 Git Worktree。
3. 检查 Worktree 的 Git 状态并保留已有修改。Agent 根据仓库自身证据选择依赖安装、测试和构建命令。
4. 每次只执行一个已批准的任务。
5. 除非新的发现已经过审核，否则每次差异都必须限制在任务声明的文件范围内。
6. 执行该任务对应的验证，更新任务状态和追踪关系。
7. 在 `code-change.md` 中记录分支、基线提交、当前提交、修改文件和 Diff 摘要。
8. 当范围发生变化、出现契约缺口，或无法确保验证可信时，停止实施；标记并刷新受影响产物，在当前状态请求重新审核。

## 阶段 5：VERIFYING

1. 从 Worktree 的仓库脚本和配置中确认实际存在的 lint、类型检查、测试和构建命令后再执行。
2. 执行能够自动化的验收检查。
3. 在 `verification.md` 中记录准确的命令和执行结果。
4. 更新 `code-change.md` 的最终修改文件和 Diff 摘要。
5. 列出需要人工执行的检查和剩余风险。
6. 确认 `staleArtifacts` 为空，将状态转为 `FINAL_REVIEW`，然后停止。

## 审核点 3：FINAL_REVIEW

展示代码差异、追踪关系、验证结果、未验证事项和回滚说明。在进入 `COMPLETE` 之前，由人工记录 `approvals.final`。工作流不会自动 commit、push、创建 PR、merge、deploy 或删除 Worktree；开发人员在真实项目中审核效果后自行决定集成和清理方式。
