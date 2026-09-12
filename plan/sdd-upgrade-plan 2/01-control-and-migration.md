# P01 状态控制与旧 Workspace 迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户指定其他模型执行本计划；不要求本对话启动执行或分派子代理。执行环境没有该 Skill 时，按本文任务和验收逐项实施。

**Goal:** 统一所有状态写入，提供可测试的阶段迁移与阻断恢复。

**Architecture:** 保留现有九个 state；状态、控制版本和审计事件一次原子提交。所有旧写入者接入同一存储模块，运行时不调用模型。

**Tech Stack:** Node.js >=18 / ES Modules / node:test / Markdown / JSON / Git。

**Spec:** [00-design.md](./00-design.md)，必须与本计划一起提供。

## Global Constraints

- Node.js >=18，ES Modules，node:test，无新增运行时第三方依赖。
- 包名保持 frontend-work-flow；业务代码执行根目录必须与 status.json.project.root 的真实路径一致。
- 默认使用开发者当前真实项目；不强制 Worktree，不更改已有 Git 暂存区，不自动 commit/push/PR/merge/deploy。
- Workspace 是需求记录；不得把软链当历史快照，不得覆盖初始化前的无关改动。
- scope 和 final 始终要求人工决定；spec 和 plan 默认也要求人工，仅在用户对本需求明确授权 delegated-review 后可由合格独立审核结果放行。
- 需求歧义、来源冲突、跨仓职责变化、接口契约缺口不能由 reviewer 自行转为确认事实。
- 同一真实工作区同时最多一个实现写入者；审核者不修改业务代码与审批记录。
- CLI 提供流程校验，不宣称能隔离拥有相同文件写权限的恶意 Agent；审批 actor 记录不是身份认证。
- 真实运行、人工试点和收益数据必须实测；fake driver 只验证编排逻辑。

工作目录：`/Users/tal/Desktop/frontend-workflow`。下列代码路径均相对这个仓库根目录；新增文件是设计目标，并非现有文件。只执行本计划。每个任务完成后审阅 diff；仅在用户已授权本地提交时 commit，否则保留 diff 与交接记录。


## 范围与前置

基于 a4e86ad。P01 只检查已有结构与审批记录；P02/P03/P04 将追加语义、快照和独立审核检查。不要在 P01 宣称已实现完整质量 Gate。

### Task 1：版本化存储与迁移

**Files**
- Create: `template/.ai-dev/scripts/lib/workspace-store.mjs`
- Modify: `template/.ai-dev/templates/status.json`
- Modify: `template/.ai-dev/scripts/init-change.mjs`
- Test: `test/workspace-store.test.mjs`

**Interfaces**
- `readFeature(featureDir): Promise<StatusV2>`，读取旧状态时返回 NEEDS_MIGRATION，不静默写盘。
- `migrateFeature(featureDir): Promise<StatusV2>`，已有 schemaVersion=2 时幂等。
- `mutateFeature(featureDir, {expectedVersion, event}, mutate): Promise<StatusV2>`。
- event 为 `{type, actor, data}`；存储层补充 sequence、at、beforeVersion、afterVersion。
- 导出纯函数 `migrateStatus(raw)` 供迁移与测试共用。

- [ ] 添加迁移、未知版本、幂等、损坏 JSON、并发版本冲突和锁冲突测试。迁移测试使用以下最小断言，实际 fixture 从当前 init-change 生成完整状态：

```js
const next = migrateStatus(legacy)
assert.equal(next.schemaVersion, 2)
assert.equal(next.state, legacy.state)
assert.deepEqual(next.project, legacy.project)
assert.equal(next.control.version, 0)
assert.equal(next.policy.mode, 'strict')
assert.throws(() => migrateStatus({...legacy, schemaVersion: 99}),
  error => error.code === 'UNSUPPORTED_SCHEMA')
```

- [ ] 运行 `node --test test/workspace-store.test.mjs`，确认因新接口缺失或未满足行为失败。
- [ ] 实现 migrateStatus，保留 ID/title/project/consistency/approvals 和未知业务扩展字段；新增设计中的控制字段。legacy 的 schemaVersion 缺失按 v1 处理，已知 v2 严格校验；未知版本拒绝。
- [ ] migrateFeature 写入前用独占文件创建保存原始 status 字节到 `revisions/migration-v1-status.json`；已有备份不覆盖。备份完成后才替换 status。迁移不自动批准、不补造历史事件。
- [ ] 实现 `status.lock` 独占锁和 `status.<nonce>.tmp` 原子 rename；重新读取磁盘版本后比较 expectedVersion，失败无写入。状态修改和 event 同时提交。finally 只释放本次拿到的锁；进程崩溃遗留锁返回 BUSY，说明检查进程后人工恢复的方法。
- [ ] 初始化生成 v2；readFeature 不负责猜测非法字段的修复。迁移旧 BLOCKED 缺少 suspendedFrom 时保留 blocked 并标记 requiredInput=“人工指定原阶段”，不得随意恢复。
- [ ] 运行单测和 `node --test test/init-change.test.mjs`；检查成功与失败分支均不破坏原 status。

### Task 2：合法迁移、批准、阻断与恢复命令

**Files**
- Create: `template/.ai-dev/scripts/lib/workflow-state.mjs`
- Create: `template/.ai-dev/scripts/workflow-control.mjs`
- Modify: `template/.ai-dev/scripts/validate-change.mjs`
- Test: `test/workflow-state.test.mjs`

**Interfaces**
- `evaluateTransition(status, to): {ok, errors}`，errors 为 `{code,message,artifact?,ruleId?}[]`。
- `transitionFeature(featureDir, to, options): Promise<StatusV2>`。
- `blockFeature(featureDir, {reasonCode,requiredInput,actor,expectedVersion})`。
- `resumeFeature(featureDir, {actor,expectedVersion})`。
- `recordHumanApproval(featureDir, {gate,actor,decisionRef,expectedVersion})`，gate=scope|spec|plan|final。
- CLI：`node .ai-dev/scripts/workflow-control.mjs <feature-dir> <migrate|inspect|transition|block|resume|approve> [--request request.json]`。
- inspect 直接只读原始 JSON，显示 schema 和迁移需求；不必先成功调用 readFeature，保证旧 Workspace 仍可检查。
- 所有修改 request 必须给 expectedVersion，approve 还需人工决定的来源 decisionRef；输出 JSON，错误写 stderr、退出 1。

- [ ] 编写迁移表驱动测试：主链每条合法边、跳过审核的非法边、COMPLETE 不能直接再开工、BLOCKED 只能 resume、缺上游批准、当前审核尚未批准不能离开。示例：

```js
assert.equal(evaluateTransition(scopeApproved, 'SPEC_REVIEW').ok, true)
assert.equal(evaluateTransition(scopeApproved, 'IMPLEMENTING').ok, false)
assert.equal(evaluateTransition(scopePending, 'SPEC_REVIEW').ok, false)
```

- [ ] 运行 `node --test test/workflow-state.test.mjs` 确认新行为失败。
- [ ] 实现严格相邻迁移；检查所需批准和已有 validator 的结构条件；BLOCKED 保存 suspendedFrom，resume 回原阶段但重新检查原阶段前置批准。缺历史批准时保持阻断，并允许先重审/补齐真实批准后再次恢复。
- [ ] approve 只接受当前 Gate 或因产物变化失效的上游 Gate，要求有明确 decisionRef；无授权时由宿主提问，不能自行填“user”。本地 actor 字符串仅用于审计，不当认证。
- [ ] 将 validate-change 的顶层执行改成 import-safe CLI guard，导出 `validateFeature(featureDir, options): Promise<{ok,errors}>`，保留旧 CLI 调用与 exit code。P02 之后它委托统一 Gate evaluator。
- [ ] 每种命令增加一个 CLI 黑盒测试：合法 JSON 输出，未知 action/缺字段/未知 state 失败且状态不变。
- [ ] 跑单测及旧 consistency 测试。不要在未实现的 request schema 里接受任意 JSON Patch 修改状态。

### Task 3：接入已有脚本与安装验证

**Files**
- Modify: `template/.ai-dev/scripts/update-consistency.mjs`
- Modify: `template/.ai-dev/scripts/record-code-changes.mjs`
- Modify: `.agents/skills/prd-to-code/SKILL.md`、`template/.ai-dev/workflow.md`
- Modify: `README.md`
- Test: `test/control-integration.test.mjs`、现有四个测试文件

**Interfaces**
- 保持 `markArtifactChanged`、`resolveArtifacts`、`recordCodeChanges` 现有签名。
- 对这些旧调用没有 expectedVersion 的情况：函数入口读取版本，最终 mutate 用该版本；并发更新不得静默覆盖。
- Skill 改用明确命令操作状态，批准记录仍来源于人工决定。

- [ ] 增加集成测试：生成真实临时 Git 项目 → setup → init → mark → resolve → record；最后 schemaVersion、control.version 和事件连续且旧字段仍在。
- [ ] 用人为冲突测试证明两次修改不会互相丢失：第一次提交后，第二次使用旧 version 必须 VERSION_CONFLICT。
- [ ] 替换旧脚本的直接 status writeFile，保留 revision 文件与 Patch 内容行为。revision 文件唯一创建，不覆盖旧记录；有未引用的失败产物不当成已提交状态。
- [ ] 更新 Skill/workflow/README 命令示例；说明 inspect 不修改状态、BLOCKED 如何恢复、迁移不提供新质量保证。
- [ ] 运行 `node --test`。检查 setup 复制 lib 文件、旧 force 备份与冲突预检仍通过。

**退出验收：** 状态修改只有一个存储入口，非法跳转被拒绝，迁移可恢复，现有 14 项回归及新增行为通过。交接下一阶段需要的 evaluateTransition、validateFeature 和 mutateFeature 签名。
