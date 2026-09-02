# 真实项目执行与需求 Workspace 设计决策

## 目标

开发人员继续在当前真实前端项目中使用既有本地配置、依赖和运行环境。AI 直接在该项目中检索、修改和验证代码；需求 Workspace 只负责保存 SDD 产物、关联本次修改文件、记录最终 Diff，并追踪上游产物变化造成的一致性刷新。

## 最终结构

```text
.ai-dev/
├── features/<requirement-id>/
│   ├── status.json
│   ├── artifacts/
│   │   ├── analysis/
│   │   ├── design/
│   │   ├── coding-changes/
│   │   │   ├── coding/
│   │   │   ├── changed-files.json
│   │   │   └── changes.patch
│   │   └── verification/
│   └── revisions/
├── artifact-graph.json
└── scripts/
```

`coding-changes/coding` 中只保存指向真实项目内本次修改文件的软链。软链用于导航和聚合当前代码，不承担历史快照职责；`changed-files.json` 保存机器可读清单，`changes.patch` 保存最终代码差异。

## 需求 ID

1. 来源文档存在业务需求编号时，使用规范化后的业务编号。
2. 开发人员显式提供编号时，使用该编号。
3. 仅有需求名称时，自动生成 `REQ-YYYYMMDD-XXXXXX`。
4. 原始名称保存在 `status.json.title`；生成后的目录 ID 永不因名称变化而修改。
5. 后续获得正式编号时写入 `externalIds`，不重命名既有 Workspace。

## 代码执行边界

- AI 从真实项目根目录读取仓库说明、源码、依赖、未提交变更和本地可用命令。
- AI 在真实项目中直接修改和验证，开发人员在同一环境审核页面效果。
- 工作流不强制创建 Worktree，也不要求 AI 通过软链访问代码。
- 初始化时记录项目根目录、分支、基线提交和已有未提交文件；最终清单显式标记与已有修改重叠的文件。
- 工作流不自动 commit、push、创建 PR、merge 或 deploy。

## 产物一致性与修订

`status.json.state` 继续表示当前阶段，`status.json.consistency` 表示产物新鲜度。修改上游产物时：

1. 保持当前 state。
2. 根据 `artifact-graph.json` 标记所有传递下游产物。
3. 清除受影响的历史人工批准。
4. 在 `revisions/revision-NNNN.json` 记录变更来源、失效产物和刷新进度。
5. 所有失效产物刷新完成后，才允许通过审核点。

`revisions` 是事件记录，不代表工作流退回旧阶段。

## 被替换的设计

此前版本将需求 Workspace 的 `project` 软链指向隔离 Worktree，并要求 AI 只能通过该路径操作代码。该设计会让代码执行环境与开发人员当前项目环境产生差异，因此被本决策替换。Worktree 不再是默认工作流组成部分。
