# Frontend Work Flow

面向前端项目的 PRD-to-Code 工作流：开发人员把 PRD、接口文档和原型交给 Codex 或 Cursor，AI 先生成可追溯的范围、前端技术方案和任务计划，在人工审核后再逐项修改代码并验证。

当前版本优先支持 Vue 3 + TypeScript；Vue 2、React 可使用通用流程，但需要结合项目现有规范补充框架规则。

## 一键配置

前置条件：Node.js 18 或更高版本，电脑能够访问 GitHub。

### 1. 安装到员工电脑

在任意目录执行一次：

```bash
npx --yes github:bi554lecex/frontend-work-flow install
```

它会安装到 `~/.agents/skills/prd-to-code`。这是 Codex 和 Cursor 都能发现的用户级 Skill 目录，不会修改 `~/.codex/config.toml`、Cursor Settings 或员工已有的规则。

### 2. 配置一个前端项目

进入真实前端仓库后执行：

```bash
npx --yes github:bi554lecex/frontend-work-flow setup .
```

项目中会新增：

```text
.agents/skills/prd-to-code/   # Codex、Cursor 共用项目 Skill
.ai-dev/                      # 状态机、Workspace 模板和校验脚本
.cursor/rules/prd-to-code.mdc # Cursor 项目规则
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

## 工作流停在哪里

```text
PRD/接口文档
  → 范围与职责审核
  → 前端技术方案审核
  → 实施计划审核
  → 分任务修改代码
  → 自动化与人工验证
  → 最终 Diff 审核
```

AI 不会替人批准审核点，也不会因为使用本工作流就自动 commit、merge、push 或 deploy。

## 常用命令

检查安装包是否完整：

```bash
npx --yes github:bi554lecex/frontend-work-flow doctor
```

手工初始化一个需求 Workspace：

```bash
node .ai-dev/scripts/init-change.mjs wrong-book-school "错题本教研学校"
```

验证需求产物和状态：

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

团队稳定使用时建议锁定版本标签：

```bash
npx --yes github:bi554lecex/frontend-work-flow#v0.1.0 install
npx --yes github:bi554lecex/frontend-work-flow#v0.1.0 setup .
```

## 输入文档建议

- Markdown 质量和可追溯性最好。
- PDF、Word 可以作为附件提供；AI 应先提取标题、表格、图片引用和来源位置，再进入范围分析。
- 不要把访问令牌、Cookie、账号密码或无需处理的个人信息复制进 Workspace。
- 需求与接口文档冲突时必须记录为阻断问题，不能由 AI 自行选择一个版本实现。

## 设计依据

- [OpenAI：Build skills](https://developers.openai.com/codex/build-skills)说明 Codex 支持仓库级和用户级 `.agents/skills`，并可使用 `$skill-name` 显式调用。
- [Cursor：Agent Skills](https://cursor.com/docs/skills)说明 Cursor 同样发现 `.agents/skills`，并可通过 `/skill-name` 调用。

因此本仓库只维护一份开放 Agent Skill，项目规则与工作流产物继续跟随具体业务仓库版本化。
