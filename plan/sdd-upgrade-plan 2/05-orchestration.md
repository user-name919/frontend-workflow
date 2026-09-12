# P05 任务编排、上下文包与恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户指定其他模型执行本计划；不要求本对话启动执行或分派子代理。执行环境没有该 Skill 时，按本文任务和验收逐项实施。

**Goal:** 让宿主 Agent 按已批准任务自动继续，任务完成后独立审核，中断后恢复到明确动作。

**Architecture:** Node 计算下一步并持久化协议，主 Skill 使用宿主实际工具派发实现者与审核者。默认串行实现，不自建模型服务或使用假的平台 SDK。

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


## 前置

依赖 P01–P04。进入 IMPLEMENTING 前计划已通过当前 policy 的批准。编排器的运行状态放 status.runtime，不污染 delivery.json 的已批准任务定义。

### Task 1：下一动作与任务上下文包

**Files**
- Create: `template/.ai-dev/scripts/lib/orchestrator.mjs`
- Create: `template/.ai-dev/scripts/prepare-task.mjs`
- Create: `.agents/skills/prd-to-code/references/implementer.md`
- Modify: `template/.ai-dev/scripts/workflow-control.mjs`
- Test: `test/orchestrator.test.mjs`、`test/task-brief.test.mjs`

**Interfaces**
- `nextAction({status,intake,delivery,gates,capabilities}): Action`，纯函数。
- Action=`{type,featureId,taskId|null,reason,inputPaths,expectedVersion}`。
- type=generate_analysis|generate_spec|generate_plan|request_review|await_human|dispatch_implementer|dispatch_reviewer|repair|verify|complete|blocked。
- `prepareTask(featureDir, taskId): Promise<{briefPath,requestPath,beforeSnapshotId}>`。
- CLI `workflow-control.mjs <feature> next`：先 reconcile 再计算；可能登记新发现的产物变化。纯只读使用 inspect。

| 当前状态/条件 | next action |
| --- | --- |
| INGEST | generate_analysis |
| SCOPE_REVIEW 且未批准 | request_review 或 await_human，不能生成 spec |
| SCOPE_REVIEW 且 scope 批准有效 | generate_spec |
| SPEC_REVIEW 且 spec 批准有效 | generate_plan |
| PLAN_REVIEW 且 plan 批准有效 | 合法 transition 到 IMPLEMENTING 后 dispatch_implementer |
| IMPLEMENTING 有修复中任务 | repair，不派发后续任务 |
| IMPLEMENTING 全任务通过 | verify |
| FINAL_REVIEW 尚无针对当前完整 Diff 的有效独立审核 | dispatch_reviewer，taskId=null、gate=final |
| FINAL_REVIEW 未人工批准 | await_human |
| COMPLETE/BLOCKED | complete/blocked |

审核产物存在且当前有效时不要重复 request_review；generate 完成后显式 transition，不能在 next 查询中偷偷当成已生成。

- [ ] 用表驱动测试覆盖上表、依赖未通过不派发、无任务不能误报完成、过期批准先重审、重复 next 不重复创建 run。
- [ ] 关键断言：

```js
assert.equal(nextAction(readyTaskContext).type, 'dispatch_implementer')
assert.equal(nextAction(unapprovedPlanContext).type, 'await_human')
assert.equal(nextAction(staleReviewContext).type, 'request_review')
```

- [ ] 运行 `node --test test/orchestrator.test.mjs test/task-brief.test.mjs` 观察失败后实现固定 action 决策表。
- [ ] prepareTask 仅提取目标 task、相关 FR/AC、必要 spec/plan 段落、全局约束、依赖接口、允许文件和命令；生成 `revisions/tasks/<taskId>/<attemptId>/brief.md` 与 `request.json`。
- [ ] 每个请求含真实 projectRoot、approvedPlanSnapshotId、beforeSnapshotId、taskId、attemptId、允许文件；拒绝不完整输入，不塞入整个聊天记录。
- [ ] 对项目检索输出记录 `{query,method,selectedPaths,sourceLocations}`；优先宿主 rg/符号/索引，记录事实即可，不新增向量库。
- [ ] beforeSnapshot 保存允许文件的前态和缺失标记、项目其他 tracked/untracked 文件摘要；after 用于任务级增量与范围检测。不要直接使用 HEAD~1 作为任务起点。
- [ ] 测试 task2 brief 不包含 task1 的调试对话，但包含 task1 导出的依赖接口。

### Task 2：实现报告、单写入者和恢复

**Files**
- Create: `template/.ai-dev/scripts/lib/task-runs.mjs`
- Create: `template/.ai-dev/scripts/record-task-result.mjs`
- Modify: `orchestrator.mjs`、`workflow-control.mjs`
- Test: `test/task-runs.test.mjs`

**Interfaces**
- `startTask(featureDir, {taskId,attemptId,expectedVersion,hostRunId})`。
- `acceptTaskResult(featureDir, report, {expectedVersion})`。
- `inspectInterruptedTask(featureDir): Promise<{taskId,attemptId,workspaceChanged,nextAction}>`。
- report=`{taskId,attemptId,hostRunId,status,summary,changedFiles,verificationIds,concerns,requiredContext}`。
- report.status=DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED。
- taskResults 状态=pending|running|needs_context|blocked|review_pending|repairing|passed，只有 P04 当前审核通过才能 passed。

- [ ] 测试 DONE 变 review_pending 而不是 passed；相同 attempt 报告重放幂等；旧 attempt 晚到拒绝；疑似业务冲突的 concerns 转人工。
- [ ] 测试两个 feature 在同项目同时 startTask，第二个失败 PROJECT_BUSY；人工已存在未登记文件的摘要未变化时不被误认为新越界。
- [ ] 运行失败测试后，实现 `.ai-dev/runtime/active-implementation.json` 的独占创建，记录 featureId/taskId/attemptId/hostRunId。此文件在 worker 执行期间保留，不因短命 CLI 退出而释放；report 接受后释放。启动、结束修改须与 P01 锁顺序固定（项目锁在前、feature 锁在后）。
- [ ] 命令崩溃可能留下 reservation；提供 inspect 和显式 recover 动作。用户确认宿主 worker 已停止后才解除旧 reservation；不得按超时自动启动第二个实现者。
- [ ] 检查 before/after：非允许文件发生新变化 → SCOPE_CHANGED 并阻断；不自动还原这些文件。判断依据来自任务开始时快照而不是需求 baseCommit。
- [ ] NEEDS_CONTEXT 优先从批准的依赖和仓库补齐；若缺产品含义则人工。BLOCKED 不用同输入无限重试。
- [ ] 对 running 中断先检查已有报告与文件状态，不重放 npm 命令或业务修改；确认结果可恢复则进入审核，否则列具体待处理项。
- [ ] 跑 `node --test test/task-runs.test.mjs test/code-changes.test.mjs`。

### Task 3：真实宿主接入和自动验证证据

**Files**
- Create: `.agents/skills/prd-to-code/references/coordinator.md`
- Create: `template/.ai-dev/scripts/run-verification.mjs`
- Create: `template/.ai-dev/scripts/lib/verification.mjs`
- Modify: `.agents/skills/prd-to-code/SKILL.md`、`template/.cursor/rules/prd-to-code.mdc`、`template/.ai-dev/workflow.md`
- Test: `test/verification.test.mjs`、`test/workflow-e2e.test.mjs`

**Interfaces**
- `runVerification(featureDir, {taskId,commandIndex,expectedSnapshotId}): Promise<VerificationResult>`。
- VerificationResult=`{id,taskId,command,args,cwd,startedAt,endedAt,exitCode,timedOut,stdoutPath,stderrPath,inputSnapshotId,outputSnapshotId,status}`。
- status=passed|failed|unverified；timeout 初始固定 120000ms，超时为 failed，需要用户按具体项目调整，不偷偷放宽。
- 宿主工具调用由 coordinator.md 描述协议，不写不存在的 SDK；如宿主支持，使用真实 spawn/dispatch、wait/resume 和隔离上下文；否则输出手工移交 request，capability=assisted。

- [ ] 增加测试：命令来自 approved delivery.verify；命令不存在、exitCode 非零、超时、运行后代码变化均不能记作有效 passed。
- [ ] 用 Node 自身作为 fixture 命令，无网络依赖：

```js
const result = await runVerification(featureDir, {
  taskId:'T1',commandIndex:0,expectedSnapshotId:before.id
})
assert.equal(result.exitCode, 1)
assert.equal(result.status, 'failed')
```

fixture 中对应 command=process.execPath，args=['-e','process.exit(1)']。
- [ ] 实现 execFile(command,args,{cwd,timeout})；禁止从模型自由文本拼 shell。cwd 必须在目标项目内，执行前确认批准的命令及其项目脚本用途。
- [ ] stdout/stderr 本地落盘，报告存路径、退出码与时间；宿主/脚本权限和环境缺失记 unverified，不伪装 passed。前后 snapshot 差异区分正常生成的构建输出和源代码变化；后者使原代码审核失效。
- [ ] coordinator 在每个动作后登记结果再请求 next；实现者不能自行派审核者。审核通过后进入下一项，只有需要人工决定、不可继续的错误或已完成时结束。
- [ ] 集成测试使用 fake worker 验证两任务顺序、spec 失败修复、报告过期、BLOCKED 恢复、final 等人工；清楚标记这些是协议模拟。
- [ ] 选择当前可用宿主做一次真实 T1 实现 + 独立 reviewer 的试跑，记录真实 hostRunId、输入包、报告和操作日志。没有该能力时完成 assisted 交接演示，并把真实自动试跑列为未完成项。
- [ ] 跑 `node --test`，final Gate 接入任务审核与 verification records；首次生成记录后更新 verification.md，再创建 final snapshot，避免循环作废自身。
- [ ] 最终独立审核覆盖整个需求 Diff、跨任务接口和剩余 minor findings，绑定当前代码与验证结果；通过后才展示给人批准。不能把所有 task 曾各自通过替代整体集成检查。

**退出验收：** 可顺序完成两个有依赖任务、失败修复和审核、中断恢复、最终人工确认。运行模式必须据实标注 autonomous-in-host 或 assisted，不宣称 Node 自身调度模型。
