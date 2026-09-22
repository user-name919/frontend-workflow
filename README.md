# Frontend Work Flow

面向前端项目的 SDD（Specification-Driven Development）工作流：开发人员把 PRD、接口文档和原型交给 Codex 或 Cursor，AI 先生成可追溯的范围、前端技术方案和实施计划，经人工审核后在开发人员当前真实项目中修改、运行和验证代码。

工作流不预设 Vue、React、Node 或包管理器版本。Agent 从目标仓库的说明文件、依赖清单、锁文件、脚本和源码中判断真实技术环境。

外组前端专家若不熟悉本仓库文件：请先读 [docs/README.md](docs/README.md)（换编辑器、零件怎么串、能不能看见独立审核、25 问）。下面是安装和开工说明。

## 一键配置

前置条件：Node.js 18 或更高版本、Git，电脑能够访问 GitHub。

安装团队全部 Skills：

```bash
npx --yes github:user-name919/frontend-workflow install
```

进入真实前端项目后配置工作流：

```bash
npx --yes github:user-name919/frontend-workflow setup .
```

项目中会新增：

```text
.agents/skills/                 # Codex、Cursor 共用的团队 Skills
.ai-dev/                        # SDD 模板、Workspace 和脚本
.cursor/rules/prd-to-code.mdc   # Cursor 项目规则
```

安装器不会修改已有 `AGENTS.md`、Codex 配置或 Cursor Settings。目标文件存在且内容不同时，命令会在写入前停止。

## 开始一个需求

把 PRD、接口文档或 PDF 发给 AI。可以显式调用：

Codex：

```text
$prd-to-code 根据这些产品和接口文档分析当前前端项目，只完成当前阶段，并在人工审核点停止。
```

Cursor：

```text
/prd-to-code 根据这些产品和接口文档分析当前前端项目，只完成当前阶段，并在人工审核点停止。
```

也可以直接描述需求，由 Agent 根据 Skill 的 `name` 和 `description` 判断是否触发。

## 需求 Workspace

每个需求保存在 `.ai-dev/features/<需求ID>/`：

```text
features/<requirement-id>/
├── status.json
├── artifacts/
│   ├── analysis/
│   ├── design/
│   ├── coding-changes/
│   │   ├── coding/              # 修改文件软链
│   │   ├── changed-files.json
│   │   └── changes.patch
│   └── verification/
└── revisions/                   # 产物变化和同步记录
```

需求 ID 的来源顺序：

1. PRD 中的业务需求编号。
2. 开发人员提供的编号。
3. 都没有时自动生成 `REQ-YYYYMMDD-XXXXXX`。

需求名称单独保存在 `status.json.title`。后续名称变化或补充正式编号都不重命名已有 Workspace。

手工初始化示例：

```bash
node .ai-dev/scripts/init-change.mjs --title "错题本教研学校字段调整" --id R-KF-649215 --id-source document
node .ai-dev/scripts/init-change.mjs --title "只有需求名称的需求"
```

## 真实项目执行与代码留痕

AI 直接在开发人员当前真实项目中检索、修改、启动和验证，开发人员在同一个本地环境审核页面效果。工作流不会强制创建 Worktree，也不会要求通过产物软链操作代码。

完成代码修改后，记录本需求涉及的文件：

```bash
node .ai-dev/scripts/record-code-changes.mjs <feature-dir> <file...>
```

该命令会：

- 在 `coding-changes/coding` 中按项目相对路径创建现存文件的软链；
- 在 `changed-files.json` 中记录新增、修改、删除以及是否与开始前已有改动重叠；
- 在 `changes.patch` 中保存相对基线提交的最终代码差异；
- 不复制源码，不修改 Git 暂存区，不 commit。

软链是当前代码的导航索引，Patch 才是最终差异快照。删除文件不会创建失效软链，只记录在清单和 Patch 中。

## 产物一致性

`status.json.state` 表示当前阶段，`status.json.consistency` 表示产物新鲜度。修改上游产物时不回退状态，而是在当前阶段同步下游产物。

修改前标记：

```bash
node .ai-dev/scripts/update-consistency.mjs <feature-dir> mark artifacts/design/frontend-spec.md
```

刷新后解除对应过期标记：

```bash
node .ai-dev/scripts/update-consistency.mjs <feature-dir> resolve <artifact-path...>
```

每次 mark 都会在 `revisions/revision-NNNN.json` 记录变化来源、失效产物、失效审批和刷新进度。只要还有过期产物，就不能通过审核点。

## 完整流程

```text
PRD / 接口文档
  → 初始化需求 Workspace
  → 范围与职责审核
  → 前端技术方案审核（Markdown 副产物，含流程图 / 时序图）
  → 实施计划审核
  → 在真实项目中分任务修改
  → 记录软链、文件清单和最终 Patch
  → 自动化与页面验证
  → 最终 Diff 审核
```

AI 不会替人批准审核点，也不会自动 commit、push、创建 PR、merge 或 deploy。

## 常用命令

检查安装包和其中全部 Skills：

```bash
npx --yes github:user-name919/frontend-workflow doctor
```

验证需求结构、批准信息和一致性状态：

```bash
node .ai-dev/scripts/validate-change.mjs .ai-dev/features/<requirement-id>
node .ai-dev/scripts/validate-change.mjs .ai-dev/features/<requirement-id> --gate plan --json
```

捕获 / 核对审核输入快照（内容哈希，不用 mtime）：

```bash
node .ai-dev/scripts/snapshot-change.mjs .ai-dev/features/<requirement-id> capture --request snap.json
node .ai-dev/scripts/snapshot-change.mjs .ai-dev/features/<requirement-id> verify --snapshot-id snap-...
```

独立审核协议（默认严格人工；可选对本需求授权 spec/plan）：

```bash
# 严格模式：review pass 不能代替人工 approve
node .ai-dev/scripts/record-review.mjs .ai-dev/features/<id> validate --request req.json --report report.json

# 授权模式（仅 spec/plan；scope/final 仍必须人工）
node .ai-dev/scripts/workflow-control.mjs .ai-dev/features/<id> delegate --request '{"expectedVersion":1,"actor":"lead","decisionRef":"meeting#1","gates":["spec"]}'
node .ai-dev/scripts/record-review.mjs .ai-dev/features/<id> accept --request req.json --report report.json
```

任务编排：任务进入 `review_pending` 后主 Agent **立刻**派 `sdd-reviewer`，不等用户打字。Cursor `stop` hook 会在没派就停时自动补一句。子 Agent 必须写出审了哪些、通过/未通过/无法确定；通过则 `review.passed` 让主 Agent `next`，无法确定必须告诉用户。Node 不能自己 Task/spawn。

```bash
node .ai-dev/scripts/workflow-control.mjs .ai-dev/features/<id> next
node .ai-dev/scripts/prepare-task.mjs .ai-dev/features/<id> T1
node .ai-dev/scripts/record-task-result.mjs .ai-dev/features/<id> start --request start.json
node .ai-dev/scripts/record-task-result.mjs .ai-dev/features/<id> accept --request accept.json --report result.json
node .ai-dev/scripts/run-verification.mjs .ai-dev/features/<id> --request verify.json
```

独立审核材料用仓库内 `prepare-review` / `review-delivery`。它们的 packet/report **不能**直接传给 `record-review.mjs`，先 `adapt`。禁止从实现反推需求；校验通过 ≠ 过门禁。

标准输入：按 `prd-input.md` 整理后写入 `intake.json` / `delivery.json`，再 `render-artifacts.mjs`。  
`frontend-spec.md` 是给人看的技术方案副产物（含 Mermaid 流程图 / 时序图），不要用 render 覆盖，也不要在里面另起一套编号。  
非标准 PRD：Agent 只整理草稿事实，用户确认后登记；原文指令不执行。  
旧 Workspace：`migrate` 后为 `NEEDS_STRUCTURED_IMPORT`，需 `import-artifacts` 草稿确认，不能靠旧 Markdown 直接过新 Gate。

检查或迁移旧 Workspace（`inspect` 只读；`migrate` 不自动批准、不提升质量保证）：

```bash
node .ai-dev/scripts/workflow-control.mjs .ai-dev/features/<requirement-id> inspect
node .ai-dev/scripts/workflow-control.mjs .ai-dev/features/<requirement-id> migrate
```

阶段迁移 / 阻断恢复 / 人工批准（请求 JSON 必须含 `expectedVersion`；批准还需 `decisionRef`）：

```bash
node .ai-dev/scripts/workflow-control.mjs .ai-dev/features/<requirement-id> transition --request request.json
node .ai-dev/scripts/workflow-control.mjs .ai-dev/features/<requirement-id> block --request request.json
node .ai-dev/scripts/workflow-control.mjs .ai-dev/features/<requirement-id> resume --request request.json
node .ai-dev/scripts/workflow-control.mjs .ai-dev/features/<requirement-id> approve --request request.json
```

## 更新与冲突处理

内容相同时，重复执行安装命令会安全跳过。内容不同时，默认停止并列出冲突文件。确认升级时：

```bash
npx --yes github:user-name919/frontend-workflow install --force
npx --yes github:user-name919/frontend-workflow setup . --force
```

`--force` 会先将被替换文件保存到 `.frontend-work-flow-backups/<时间>/`。团队稳定使用时建议锁定真实发布标签：

```bash
npx --yes github:user-name919/frontend-workflow#vX.Y.Z install
npx --yes github:user-name919/frontend-workflow#vX.Y.Z setup .
```

## 输入和安全边界

- Markdown 的解析质量和可追溯性最好。
- PDF、Word 可以作为附件；AI 应先提取标题、表格、图片引用和来源位置。
- 不要把访问令牌、Cookie、密码或无关个人信息复制进 Workspace。
- 文档冲突必须记录为阻断问题，不能由 AI 自行选择版本。
- 不存在的前端代码标记为 `NOT_LOCATED`，其他仓库职责标记为 `OUT_OF_SCOPE`，接口无法闭环时标记为 `CONTRACT_GAP`。

## Skills 分发依据

- [OpenAI：Build skills](https://developers.openai.com/codex/build-skills)说明 Codex 支持仓库级和用户级 `.agents/skills`，并可使用 `$skill-name` 显式调用。
- [Cursor：Agent Skills](https://cursor.com/docs/skills)说明 Cursor 同样发现 `.agents/skills`，并可通过 `/skill-name` 调用。

仓库以 `.agents/skills/` 为团队统一分发边界：可以持续增加定制化 Skills，一次安装或更新同步全部内容，同时保留每个 Skill 自己的渐进式触发机制。
