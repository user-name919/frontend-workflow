# 真实项目执行与需求 Workspace 实施计划

**目标：** 将强制 Worktree 模式替换为真实项目直接执行，并实现分层需求 Workspace、自动需求 ID、代码软链清单、最终 Patch 和修订事件记录。

**架构：** `.ai-dev/scripts` 负责可重复的 Workspace 初始化、代码变更记录和一致性事件；Agent Skill 负责在人工审核点调用脚本。业务代码始终在开发人员当前项目中执行，Workspace 只保存关联和审计产物。

**技术栈：** Node.js 18+、Node Test Runner、Git、文件软链。

**设计依据：** `docs/decisions/2026-09-02-real-project-workspace.md`

## 全局约束

- 不复制外部工作流的文件名或完整目录结构。
- 不强制创建 Worktree。
- 不预设 Vue、React、Node 或包管理器版本。
- 不自动 commit、push、创建 PR、merge 或 deploy。
- 每个新增行为先运行失败测试，再实现最小代码。

## Task 1：需求 ID 与分层 Workspace

**文件：**

- 修改：`template/.ai-dev/scripts/init-change.mjs`
- 重组：`template/.ai-dev/templates/**`
- 创建：`test/init-change.test.mjs`

**步骤：**

1. 测试显式业务 ID 创建 `.ai-dev/features/<id>` 并保留原始标题。
2. 测试缺少业务 ID 时生成 `REQ-YYYYMMDD-XXXXXX`。
3. 测试生成 analysis、design、coding-changes、verification 和 revisions 目录。
4. 实现可导入的初始化函数与 CLI 参数解析。
5. 重跑初始化测试。

## Task 2：真实代码变更关联

**文件：**

- 创建：`template/.ai-dev/scripts/record-code-changes.mjs`
- 创建：`template/.ai-dev/templates/artifacts/coding-changes/changed-files.json`
- 创建：`template/.ai-dev/templates/artifacts/coding-changes/changes.patch`
- 创建：`test/code-changes.test.mjs`
- 删除：Worktree 脚本、模板和测试。

**步骤：**

1. 在临时 Git 项目中修改、增加和删除文件，测试输出清单状态。
2. 测试现存文件在 `coding` 中建立软链，删除文件不建立失效软链。
3. 测试 `changes.patch` 包含已跟踪和未跟踪文件的差异。
4. 测试工作区之外的路径被拒绝。
5. 实现最小记录脚本并重跑测试。

## Task 3：一致性修订记录

**文件：**

- 修改：`template/.ai-dev/artifact-graph.json`
- 修改：`template/.ai-dev/scripts/update-consistency.mjs`
- 修改：`test/consistency.test.mjs`

**步骤：**

1. 将产物图键更新为新的相对路径。
2. 测试 mark 保持 state 并创建递增的 revision 文件。
3. 测试 resolve 更新当前 revision 的刷新记录与剩余失效项。
4. 实现事件写入并重跑一致性测试。

## Task 4：校验、Skill 与文档收敛

**文件：**

- 修改：`template/.ai-dev/scripts/validate-change.mjs`
- 修改：`.agents/skills/prd-to-code/SKILL.md`
- 修改：`template/.ai-dev/workflow.md`
- 修改：`template/.cursor/rules/prd-to-code.mdc`
- 修改：`README.md`
- 修改：`package.json`

**步骤：**

1. 校验新的目录和必需产物。
2. 移除所有强制 Worktree 与 `project` 软链说明。
3. 写明真实项目执行、代码变更记录和需求 ID 规则。
4. 将版本更新为 `0.3.0`。
5. 搜索并确认无旧路径和外部项目名称残留。

## Task 5：完整验证

1. 运行 `npm test`。
2. 运行 `doctor`。
3. 检查 npm 发布包内容。
4. 运行 `git diff --check` 并检查最终差异范围。
