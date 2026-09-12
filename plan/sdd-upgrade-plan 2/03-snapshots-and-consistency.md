# P03 内容快照与产物一致性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户指定其他模型执行本计划；不要求本对话启动执行或分派子代理。执行环境没有该 Skill 时，按本文任务和验收逐项实施。

**Goal:** 发现漏执行 mark 的真实内容变化，并保证审核与批准对应正在交付的版本。

**Architecture:** 使用不可变输入快照绑定报告和批准；保留现有 revision 与传递失效机制，按阶段相关性处理 stale。审核文件先持久化，再由 status 原子接受引用。

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

依赖 P01、P02。不得用文件 mtime 作为内容没变的证据，也不得给整个 Workspace 做递归哈希：它包含会持续变化的运行日志、快照和实时软链。

### Task 1：定义审核输入快照

**Files**
- Create: `template/.ai-dev/scripts/lib/snapshots.mjs`
- Create: `template/.ai-dev/scripts/snapshot-change.mjs`
- Test: `test/snapshots.test.mjs`

**Interfaces**
- `captureSnapshot(featureDir, {gate,taskId=null,inputs}): Promise<Snapshot>`。
- `verifySnapshot(featureDir, snapshot): Promise<{fresh,changes}>`。
- inputs 是 `{space:'feature'|'project',path:string,freshness?:'live'|'baseline'}[]`，默认 live。
- Snapshot=`{id,gate,taskId,createdAt,consistencyRevision,inputs:[{space,path,sha256,exists,freshness}],projectDigest}`。
- 文件存 `revisions/snapshots/<id>.json`，id 使用内容 digest 与唯一 nonce；写入不修改 state。
- `projectDigest` 在涉及代码的 task/final 审核时必需，文档 Gate 可为 null。

- [ ] 测试：同内容不同 mtime 仍 fresh；内容变化/删除/新增原先不存在文件变 stale；读取到 ../、绝对路径或越界软链失败。
- [ ] 核心断言：

```js
const s = await captureSnapshot(featureDir, {
  gate: 'plan', inputs: [{space:'feature',path:'artifacts/design/delivery.json'}]
})
assert.equal((await verifySnapshot(featureDir, s)).fresh, true)
await writeFile(deliveryPath, changedDelivery)
assert.equal((await verifySnapshot(featureDir, s)).fresh, false)
```

- [ ] 运行 `node --test test/snapshots.test.mjs`，确认失败后实现 SHA-256，UTF-8 文本与二进制统一按字节处理，不做会掩盖变化的规范化。
- [ ] 输入列表由 evaluateGate.requiredInputs、已定位源码和项目规范生成，排序去重；排除 runtime/report/snapshot 及 coding 软链目录。
- [ ] plan 审核中的现有源码标为 baseline，只用于证明当时的设计依据；计划批准后正常实施不使它自动过期。spec、delivery、constitution 等定义仍为 live。task/final 的待审代码在接收报告前必须 live，不能允许审核期间悄悄改变。
- [ ] projectDigest 覆盖 HEAD、tracked 工作树相对 HEAD 的 binary diff，以及未被 Git 忽略的 untracked 文件内容摘要；排除 `.ai-dev/` 的控制产物以防自递归。不用 mtime，不打印源码。不纳入凭据文件内容到报告；仅保存 digest。无法完整读取时拒绝声称 fresh。
- [ ] 新建目标文件不存在时用 exists=false、sha256=null 表示；同路径后续创建会令旧 snapshot 过期。
- [ ] 快照使用独占写入，重复 ID 不覆盖；报告只能引用本需求目录内已存在的 snapshot。
- [ ] 跑 targeted 测试，添加 Git staged/unstaged、untracked、删除文件、Unicode 路径样例。

### Task 2：漏标检测与按阶段失效

**Files**
- Modify: `template/.ai-dev/scripts/update-consistency.mjs`
- Modify: `template/.ai-dev/artifact-graph.json`
- Modify: `template/.ai-dev/scripts/lib/gates.mjs`
- Create: `template/.ai-dev/scripts/lib/consistency.mjs`
- Test: `test/consistency-snapshots.test.mjs`

**Interfaces**
- `reconcileArtifacts(featureDir, {expectedVersion}): Promise<StatusV2>`。
- `blockingStale(status, requiredInputs, graph): string[]`，只返回本 Gate 所依赖的过期产物。
- 在 consistency 中追加 `artifactDigests`，每项 `{sha256,generated,upstreamDigests}`。
- 显式 mark 保持当前语义；reconcile 在 Gate/next 前检查真实 digest，用同一失效函数传播。

- [ ] 新增以下回归：

```js
const stale = ['artifacts/verification/verification.md']
assert.deepEqual(blockingStale({consistency:{staleArtifacts:stale}},
  ['artifacts/analysis/scope.md'], graph), [])
assert.deepEqual(blockingStale({consistency:{staleArtifacts:stale}},
  ['artifacts/verification/verification.md'], graph), stale)
```

- [ ] 测试“绕开 mark 修改 spec → reconcile 失效 spec/plan/final 批准”；不应失效 scope。
- [ ] 测试同一变化重复 reconcile 不重复增加 revision；显式 mark 后正常编辑不再为同一事务重复标记。
- [ ] 实现每产物 dirty/observed digest 的记录；resolve 需要本产物存在、相关结构检查通过、上游已同步，并保存实际 upstreamDigests。无内容变化但经确认仍适用可 resolve，不过必须记录原因，不能单凭未变化直接判刷新失败。
- [ ] 尚未生成的未来产物保留 generated=false；只在首次真实生成并校验后登记。不要把模板存在当成 generated=true。
- [ ] 保持 state 不回退；若计划输入变化，暂停实施并先同步相关内容/重新审核，完成后仍从当前阶段恢复。
- [ ] 所有 approve/transition/next 调用 reconcile，再读取新 version；客户端传旧 expectedVersion 时提示重新读取，不擅自跳过乐观锁。
- [ ] 运行现有 consistency 测试及新增测试，更新未来 stale 不阻断早期 Gate 的旧断言。

### Task 3：批准绑定与可审阅代码包

**Files**
- Modify: `template/.ai-dev/scripts/lib/workflow-state.mjs`
- Modify: `template/.ai-dev/scripts/record-code-changes.mjs`
- Modify: `template/.ai-dev/scripts/init-change.mjs`
- Create: `template/.ai-dev/scripts/lib/review-package.mjs`
- Test: `test/review-package.test.mjs`

**Interfaces**
- approval 增加 `snapshotId`；旧 approval 无 snapshot 在升级后不可作为新放行依据，保留到迁移备份。
- `createReviewPackage(featureDir, {gate,taskId=null,inputs}): Promise<{packageId,snapshotId,manifestPath}>`。
- package 清单指向冻结的规格摘录、计划、任务、规则、Diff 和命令结果；存 `revisions/review-packages/<packageId>/`，限制在任务实际上下文内。
- task 级 before/after 文件证据与 requirement 级 baseCommit Patch 分开命名，不能把整份需求 Patch 冒充单任务增量。

- [ ] 写测试：批准后 spec 变化，approve 状态仍存在也不能过 Gate；历史无 snapshot 批准提示 REAPPROVAL_REQUIRED。
- [ ] 先定义并测试：

```js
const check = await verifySnapshot(featureDir, approvedSnapshot)
assert.equal(check.fresh, false)
assert.equal((await evaluateGate(featureDir, 'plan')).ok, false)
```

- [ ] 实现批准 snapshot 绑定，批准操作在锁内重新核对输入 digest 与 expectedVersion；不接受报告产生后又改动的输入。
- [ ] 增加回归：task1 按批准计划改源码不会使 plan 失效；task2 的正常实现不会令 task1 历史记录无效；修改 delivery 的 FR/AC/任务定义必须使相关审核失效。
- [ ] 代码包冻结 bytes 或可重建的具体 Git 版本；实时软链不能作为已审核代码证据。记录已有脏改动，明确需求 Patch 可能包含同文件原有修改，preExisting 不等于成功隔离了归属。
- [ ] task 级包由 P05 提供开始前的允许文件快照与结束快照；当前先实现接收 before/after bytes 的包生成函数。允许文件中的旧改动保留，禁止自动 checkout/stash 来净化环境。
- [ ] 检查 record-code-changes 的输入文件列表和实际改动集：新增未登记文件必须在 final 报告中提示，不能悄悄漏掉；原本就有且未变化的无关文件不应算本需求。
- [ ] 新 Workspace 初始化保存 `revisions/code-baseline.json`，记录当时实际 tracked/untracked 文件摘要及缺失情况，用于上述前后比较。旧 Workspace 只有 initialChanges 路径、缺少实际内容摘要时，标记归属证据不足并请求人工确认，不反向猜测旧字节。不能声称 preExisting 标志能精确拆分同一文件的改动归属。
- [ ] 跑 `node --test`；交接新 snapshot、approval、review package schema。

**退出验收：** 同一份已审核输入不会被悄悄替换；漏 mark 能识别；未来产物不会导致早期死锁；任务与整需求 Diff 的边界明确。
