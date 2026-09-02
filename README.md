# Frontend Work Flow

面向前端项目的 SDD（Specification-Driven Development）工作流：开发人员把 PRD、接口文档和原型交给 Codex 或 Cursor，AI 先生成可追溯的范围、前端技术方案和任务计划，经人工审核后在隔离 Git Worktree 中逐项修改代码并验证。

工作流不预设 Vue、React、Node 或包管理器版本。Agent 从目标仓库的说明文件、依赖清单、锁文件、脚本和源码中判断真实技术环境，避免静态配置影响不同项目。

## 一键配置

前置条件：Node.js 18 或更高版本、Git，电脑能够访问 GitHub。

### 1. 安装到员工电脑

在任意目录执行一次：

```bash
npx --yes github:bi554lecex/frontend-work-flow install
```

安装器会把仓库 `.agents/skills/` 下的全部 Skills 同步到 `~/.agents/skills/`。团队成员不需要逐个选择或配置 Skill；每个 Skill 仍根据自己的 `name` 和 `description` 由 Agent 正常判断是否触发。安装过程不会修改 `~/.codex/config.toml`、Cursor Settings 或员工已有规则。

### 2. 配置一个前端项目

进入真实前端仓库后执行：

```bash
npx --yes github:bi554lecex/frontend-work-flow setup .
```

项目中会新增：

```text
.agents/skills/                 # Codex、Cursor 共用的全部团队 Skills
.ai-dev/                        # SDD 状态、Workspace 模板和脚本
.cursor/rules/prd-to-code.mdc   # Cursor 项目规则
```

安装器不会修改已有 `AGENTS.md`。如果目标文件已存在且内容不同，命令会在写入前整体停止。

### 3. 开始一个需求

把 PRD、接口文档或 PDF 附件发给 AI，然后使用：

Codex：

```text
$prd-to-code 根据这些产品和接口文档分析当前前端项目，只完成当前阶段，并在人工审核点停止。
```

Cursor：

```text
/prd-to-code 根据这些产品和接口文档分析当前前端项目，只完成当前阶段，并在人工审核点停止。
```

也可以直接描述需求；当内容与 Skill 的适用范围匹配时，Codex 或 Cursor 可以自动选择它。

## 实际执行流程

```text
PRD / 接口文档
  → 范围与职责审核
  → 前端技术方案审核
  → 实施计划审核
  → 创建隔离 Worktree 并建立 Workspace 软链
  → 分任务修改与验证
  → 最终 Diff 审核
```

每个需求位于 `.ai-dev/changes/<change-id>/`。计划审核通过后，工作流创建 `.ai-dev/worktrees/<change-id>/`，并通过需求目录中的 `project` 软链关联：

```text
.ai-dev/changes/<change-id>/project
  -> ../../worktrees/<change-id>
```

AI 只通过该软链检查和修改业务代码。Workspace 保存需求文档、Worktree 元数据、修改文件、Diff 摘要和验证结果；Worktree 用于隔离与留痕，不会额外创建 PR。最终仍由开发人员在真实项目中审核运行效果，并决定如何合并或清理。

## 产物修改与一致性

`status.json.state` 表示当前执行阶段，`status.json.consistency` 表示产物是否仍然有效。修改上游产物不会让流程退回旧阶段，而是将受影响的技术方案、任务、追踪关系或验证结果标记为过期，在当前阶段同步更新。

修改现有产物前：

```bash
node .ai-dev/scripts/update-consistency.mjs <change-dir> mark <artifact>
```

更新 `status.json.consistency.staleArtifacts` 列出的下游产物后：

```bash
node .ai-dev/scripts/update-consistency.mjs <change-dir> resolve <artifact...>
```

受影响的历史批准会失效，需要人工重新审核；当前 `state` 不回退。只要还有过期产物，就不能通过审核点。

## 常用命令

检查安装包及其中全部 Skills 是否完整：

```bash
npx --yes github:bi554lecex/frontend-work-flow doctor
```

手工初始化一个需求 Workspace：

```bash
node .ai-dev/scripts/init-change.mjs wrong-book-school "错题本教研学校"
```

计划审核通过后创建或复用 Worktree：

```bash
node .ai-dev/scripts/init-worktree.mjs .ai-dev/changes/YYYYMMDD-wrong-book-school
```

验证需求产物、批准信息和一致性状态：

```bash
node .ai-dev/scripts/validate-change.mjs .ai-dev/changes/YYYYMMDD-wrong-book-school
```

## 更新与冲突处理

内容相同时，重复执行安装命令会安全跳过。内容不同时，默认停止并列出冲突文件。

确认需要用仓库版本替换时：

```bash
npx --yes github:bi554lecex/frontend-work-flow install --force
npx --yes github:bi554lecex/frontend-work-flow setup . --force
```

`--force` 会先将被替换文件保存到 `.frontend-work-flow-backups/<时间>/`。项目内的备份不要提交到业务仓库。

团队稳定使用时建议把命令中的仓库引用锁定到已发布标签：

```bash
npx --yes github:bi554lecex/frontend-work-flow#vX.Y.Z install
npx --yes github:bi554lecex/frontend-work-flow#vX.Y.Z setup .
```

将 `vX.Y.Z` 替换成团队已经发布的真实标签。升级到新标签时，如果仓库内容发生变化，使用前文的 `--force` 命令完成备份和替换；团队成员不需要逐个维护 Skills。

## 输入文档建议

- Markdown 的解析质量和可追溯性最好。
- PDF、Word 可以作为附件提供；AI 应先提取标题、表格、图片引用和来源位置，再进入范围分析。
- 不要把访问令牌、Cookie、账号密码或无需处理的个人信息复制进 Workspace。
- 需求与接口文档冲突时必须记录为阻断问题，不能由 AI 自行选择一个版本实现。

## 安全边界

- AI 不会替人批准审核点。
- 没有计划批准时不能创建实施 Worktree。
- 工作流不会自动 commit、push、创建 PR、merge 或 deploy。
- 不存在的前端代码标记为 `NOT_LOCATED`，后端或其他仓库职责标记为 `OUT_OF_SCOPE`，接口无法闭环时标记为 `CONTRACT_GAP`。

## 设计依据

- [OpenAI：Build skills](https://developers.openai.com/codex/build-skills)说明 Codex 支持仓库级和用户级 `.agents/skills`，并可使用 `$skill-name` 显式调用。
- [Cursor：Agent Skills](https://cursor.com/docs/skills)说明 Cursor 同样发现 `.agents/skills`，并可通过 `/skill-name` 调用。

因此，本仓库以 `.agents/skills/` 为团队统一分发边界：仓库可以持续增加定制化 Skills，一次安装或更新同步全部内容，同时保留每个 Skill 自己的渐进式触发机制。
