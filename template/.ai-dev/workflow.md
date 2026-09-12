# 前端 SDD 工作流

## Workspace

每个需求保存在 `.ai-dev/features/<requirement-id>/`：

```text
features/<requirement-id>/
├── status.json
├── artifacts/
│   ├── analysis/
│   ├── design/
│   ├── coding-changes/
│   │   ├── coding/
│   │   ├── changed-files.json
│   │   └── changes.patch
│   └── verification/
└── revisions/
```

来源文档存在业务编号时优先使用；只有需求名称时自动生成 `REQ-YYYYMMDD-XXXXXX`。生成后的 ID 永不随标题变化。后续获得的正式编号写入 `status.json.externalIds`。

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

`state` 只表示当前执行阶段，`status.json.consistency` 单独记录产物修订号、过期产物和最近一次变更。修改上游产物时保持当前 state，在当前阶段同步刷新下游产物，不通过回退状态重跑流程。

`status.json.schemaVersion` 当前为 `2`。所有状态写入经 `scripts/lib/workspace-store.mjs` 原子提交（`control.version` + 事件）。旧 Workspace 需先迁移，不可静默升级：

```bash
node .ai-dev/scripts/workflow-control.mjs <feature-dir> inspect
node .ai-dev/scripts/workflow-control.mjs <feature-dir> migrate
```

`inspect` 只读，不修改状态。迁移会备份到 `revisions/migration-v1-status.json`，标记 `control.artifactStatus=NEEDS_STRUCTURED_IMPORT`，**不**自动批准，也**不**提供新的质量保证。结构化导入：

```bash
node .ai-dev/scripts/import-artifacts.mjs <feature-dir> draft --request draft-input.json
node .ai-dev/scripts/import-artifacts.mjs <feature-dir> accept --draft revisions/import-draft.json --request accept.json
```

来源/需求/问题以 `artifacts/analysis/intake.json` 为权威；验收/任务以 `artifacts/design/delivery.json` 为权威。对应 Markdown 表格由渲染生成，禁止手工双维护：

```bash
node .ai-dev/scripts/render-artifacts.mjs <feature-dir>
```

阶段准入（结构检查 ≠ 语义正确）：

```bash
node .ai-dev/scripts/validate-change.mjs <feature-dir> --gate scope --json
node .ai-dev/scripts/validate-change.mjs <feature-dir> --gate plan --json
```

阶段迁移、阻断与恢复、人工批准：

```bash
node .ai-dev/scripts/workflow-control.mjs <feature-dir> transition --request request.json
node .ai-dev/scripts/workflow-control.mjs <feature-dir> block --request request.json
node .ai-dev/scripts/workflow-control.mjs <feature-dir> resume --request request.json
node .ai-dev/scripts/workflow-control.mjs <feature-dir> approve --request request.json
```

修改类请求必须包含 `expectedVersion`（等于当前 `control.version`）。`approve` 还必须提供人工决定来源 `decisionRef`。`BLOCKED` 恢复只回到 `control.blocked.suspendedFrom`，并重新校验前置批准；缺少 `suspendedFrom` 时需人工指定原阶段后再恢复。

## 产物一致性

修改已经生成的产物前，传入它相对需求 Workspace 的路径：

```bash
node .ai-dev/scripts/update-consistency.mjs <feature-dir> mark artifacts/design/frontend-spec.md
```

脚本根据 `.ai-dev/artifact-graph.json` 标记传递下游、清除受影响的历史批准，并在 `revisions/revision-NNNN.json` 保存事件。Agent 更新下游产物后，只对实际刷新的文件执行：

```bash
node .ai-dev/scripts/update-consistency.mjs <feature-dir> resolve <artifact-path...>
```

存在过期产物时不得通过审核点。`revisions` 是一致性演进记录，不代表状态回退。

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

1. 使用 `init-change.mjs` 创建需求 Workspace；记录需求 ID 来源和真实项目基线。
2. 用 `templates/prd-input.md` 或既有材料整理 `artifacts/analysis/intake.json`（来源、证据、需求、问题）；非标准 PRD 由 Agent 整理草稿，原文只作证据。
3. 运行 `render-artifacts.mjs` 生成 source-index / evidence / open-questions 视图。
4. 从摘录中移除凭据、访问令牌、Cookie 和个人数据。
5. 直接检查真实项目的说明文件、依赖清单、锁文件、脚本、构建配置、源码结构、Git 状态和已有本地改动。
6. 根据仓库证据判断框架、版本、包管理器、代码规范和可用命令，不使用预设项目类型。
7. 不得修改业务代码。
8. 写清 `scope.md` 后，将状态转为 `SCOPE_REVIEW`，然后停止。

## 审核点 1：SCOPE_REVIEW

人工确认目标仓库、前后端职责、排除项、冲突和未知事项。在记录 `approvals.scope` 前不得继续。

## 阶段 2：SPEC

1. 在 `artifacts/design/frontend-spec.md` 描述可观察前端行为。
2. 添加稳定需求 ID、验收标准和失败/空状态。
3. 除非已批准约束明确要求，否则不写入具体实现选择。
4. 更新 `artifacts/design/traceability.md`。
5. 将状态转为 `SPEC_REVIEW`，然后停止。

## 审核点 2A：SPEC_REVIEW

必须关闭阻断性问题，并由人工记录 `approvals.spec`。

## 阶段 3：PLAN

1. 将需求映射到真实项目中的文件、符号、路由、状态、API 和验证命令。
2. 生成 `artifacts/design/implementation-plan.md` 和 `artifacts/design/tasks.md`。
3. 标记未定位事项，不创建基于推测的文件。
4. 将状态转为 `PLAN_REVIEW`，然后停止。

## 审核点 2B：PLAN_REVIEW

人工审核文件范围、任务顺序、契约假设和验证方案，并记录 `approvals.plan`。

## 阶段 4：IMPLEMENTING

1. 确认当前真实项目根目录与 `status.json.project.root` 一致；不创建强制 Worktree。
2. 在开发人员当前项目中直接检索和修改代码，保留初始化时记录的已有修改。
3. 每次只执行一个已批准任务，差异限制在任务声明范围内。
4. 执行任务对应验证并更新任务和追踪关系。
5. 将本需求涉及的全部文件传给：

```bash
node .ai-dev/scripts/record-code-changes.mjs <feature-dir> <file...>
```

6. `coding-changes/coding` 只作为现存修改文件的实时导航；删除文件只记录在清单和 Patch 中。
7. 当范围变化或出现契约缺口时停止实施，在当前状态标记并刷新受影响产物后请求重新审核。

## 阶段 5：VERIFYING

1. 从真实项目脚本和配置确认实际存在的 lint、类型检查、测试和构建命令。
2. 执行自动化验收检查，并让开发人员在同一个真实项目环境审核页面效果。
3. 在 `artifacts/verification/verification.md` 记录准确命令、结果、人工检查和剩余风险。
4. 重新运行代码变更记录脚本，确保 `changed-files.json` 和 `changes.patch` 是最终状态。
5. 确认 `staleArtifacts` 为空，将状态转为 `FINAL_REVIEW`，然后停止。

## 审核点 3：FINAL_REVIEW

展示文件清单、最终 Patch、追踪关系、验证结果、未验证事项和回滚说明。人工记录 `approvals.final` 后才能进入 `COMPLETE`。工作流不会自动 commit、push、创建 PR、merge 或 deploy。
