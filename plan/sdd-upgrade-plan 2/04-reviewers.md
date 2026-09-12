# P04 独立审核与修复复审 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户指定其他模型执行本计划；不要求本对话启动执行或分派子代理。执行环境没有该 Skill 时，按本文任务和验收逐项实施。

**Goal:** 让独立 Agent 承担可标准化的审查工作，输出可校验结论并在必要时升级人工。

**Architecture:** 宿主提供独立上下文，Node 校验审核协议、当前版本和规则完整性。默认一个任务 reviewer 给出先 spec 后 quality 的两个结论，失败有有界修复循环。

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


## 前置与分工

依赖 P01–P03。本计划实现协议、评审包、接收和 policy；P05 连接真实宿主派发。未接宿主前只能声明“协议通过离线测试”。

### Task 1：角色说明、规则和报告契约

**Files**
- Create: `.agents/skills/prd-to-code/references/reviewer.md`
- Create: `.agents/skills/prd-to-code/references/review-rules.md`
- Create: `template/.ai-dev/scripts/lib/reviews.mjs`
- Create: `template/.ai-dev/scripts/record-review.mjs`
- Test: `test/reviews.test.mjs`

**Interfaces**
- `validateReview(report, {request,snapshot}): {ok,errors}`。
- `acceptReview(featureDir, report, {expectedVersion}): Promise<StatusV2>`。
- request=`{requestId,gate,taskId,packageId,snapshotId,requiredRuleIds,implementerRunId}`。
- report 契约：

```json
{
  "schemaVersion":1,
  "requestId":"RV-1",
  "snapshotId":"SNAP-1",
  "reviewer":{"runId":"HOST-RUN-2","host":"manual","model":"record-actual-model","independence":"independent"},
  "gate":"task",
  "taskId":"T1",
  "verdict":"revise",
  "specVerdict":"fail",
  "qualityVerdict":"not_run",
  "checks":[{"ruleId":"SPEC-COVERAGE","result":"fail","evidence":["FR-1","src/retry.js:12"]}],
  "findings":[{"id":"F-1","severity":"major","ruleId":"SPEC-COVERAGE","location":"src/retry.js:12","message":"失败状态没有重试入口","requestedChange":"实现 AC-1","requiresHuman":false}]
}
```

verdict=pass|revise|needs_human；specVerdict/qualityVerdict=pass|fail|not_run。阶段文档审核只使用 specVerdict，qualityVerdict=not_run；任务审核两个维度都必须 pass 才能 pass。severity=blocking|major|minor。无证据的位置必须明确说无法确认，不能编造行号。

gate=scope|spec|plan|task|final；scope/spec/plan 属于阶段文档审核。final 是整体代码审核，和 task 一样要求 spec 与 quality 都通过，taskId=null。

- [ ] 测试：缺 requiredRuleId、同 implementer run、自称 pass 但存在 major、spec fail 而 quality pass、未知 enum、未知 requestId 全部拒绝。
- [ ] 关键断言：

```js
assert.equal(validateReview(contradictoryReport, context).ok, false)
assert.equal(validateReview(validPassReport, context).ok, true)
```

- [ ] 失败测试后实现协议校验；independence=self_check 可记录但不能当独立审核通过。真实 host runId 由协调者记录；本地字符串不构成防伪身份验证。
- [ ] reviewer 只读批准材料与当前源码，独立查证 implementer 的结论；禁止改业务代码、修改批准或关闭业务问题。
- [ ] 规则分组：scope=来源/职责/冲突，spec=可观察行为/边界/验收，plan=真实定位/范围/依赖/验证，task=需求符合性/额外实现/代码质量/测试依据。
- [ ] spec 未过输出 quality not_run；修复后重新 spec，通过后再 quality。可在同一独立 reviewer 会话顺序完成，不默认启动两个 reviewer。
- [ ] 验证 report schema、规则覆盖和 JSON 输出，跑 `node --test test/reviews.test.mjs`。

### Task 2：版本校验与有界修复循环

**Files**
- Modify: `template/.ai-dev/scripts/lib/reviews.mjs`
- Create: `template/.ai-dev/scripts/lib/review-loop.mjs`
- Test: `test/review-loop.test.mjs`

**Interfaces**
- `decideReviewAction({report,fixRound,maxFixRounds}): {action,reason}`。
- action=accept|repair|ask_human；初审 fixRound=0，修复后复审为 1、2、3。
- 每份 report 持久化到 `revisions/reviews/<requestId>/<runId>.json`，status.reviews 只存已接受引用。
- 对再次请求同一 requestId 同一报告返回已接收，不重复计数；同 ID 不同内容拒绝。

- [ ] 测试版本过期不能接受；相同 report 不重复 event；初审失败 → 三次修复复审 → 仍失败转人工。
- [ ] 关键断言：

```js
assert.equal(decideReviewAction({report:majorFailure,fixRound:0,maxFixRounds:3}).action, 'repair')
assert.equal(decideReviewAction({report:majorFailure,fixRound:3,maxFixRounds:3}).action, 'ask_human')
assert.equal(decideReviewAction({report:businessConflict,fixRound:0,maxFixRounds:3}).action, 'ask_human')
```

- [ ] 实现 snapshot 新鲜度和当前批准版本校验；过期报告保留原文，但不产生放行决定。
- [ ] 新鲜度核对在 report 接受时执行；已接受 task 报告记录 acceptedAt 和当时的定义版本。后续任务修改共享文件不自动抹去历史结论；最终 Gate 依赖新的整体审核。批准定义变化仍按 P03 重新审核受影响任务。
- [ ] 修复包包含原 finding ID、已确认约束和本轮变化；复审必须逐项给 addressed/not_addressed，并检查修复导致的新阻断问题。
- [ ] minor 可以带理由进入最终人工检查清单；blocking/major 未解决不能标 done。需要改变规格或计划时更新相应产物、失效旧批准，交人确认；不能通过“计划要求如此”直接驳回真实缺陷。
- [ ] 审核超时、非法 JSON 或独立上下文缺失不计为业务修复轮次，另记 transportAttempts，最多重试一次后交人工。模型能力升级建议可记录，但不私自切换用户指定模型。
- [ ] 跑 targeted 测试，检查完整 findings 留存而不是只保留最终“通过”。

### Task 3：严格模式与明确授权后的有限自动审核

**Files**
- Modify: `workflow-state.mjs`、`gates.mjs`、`workflow-control.mjs`（均位于 `template/.ai-dev/scripts/`，lib 文件在 lib 下）
- Modify: `template/.ai-dev/constitution.md`、`workflow.md`、`.agents/skills/prd-to-code/SKILL.md`
- Test: `test/review-policy.test.mjs`

**Interfaces**
- CLI 新增 `delegate`，request=`{expectedVersion,actor,decisionRef,gates:['spec','plan']}`。
- policy.mode=strict|delegated-review；delegation 保存 actor/decisionRef/gates/at，范围只限当前 feature。
- AI 自动放行写 `reviews` 和 `control.events`，不伪造 `approvals.spec.approvedBy`。
- Gate eligibility 接受“有效人工批准”或“policy 允许的独立审核 + 机器检查”，scope/final 只有前者。

- [ ] 测试严格模式下 report pass 不替代人工；仅授权 spec 时 plan 仍等人；scope/final 始终等人。
- [ ] 核心断言：

```js
assert.equal(gateAuthorized(strictStatus, 'spec', validReview), false)
assert.equal(gateAuthorized(delegatedSpecStatus, 'spec', validReview), true)
assert.equal(gateAuthorized(delegatedSpecStatus, 'final', validReview), false)
```

在 reviews.mjs 导出 `gateAuthorized(status,gate,review)` 供 state/gates 共用；避免各处写出不同 policy。
- [ ] 用户业务确认需要新 source/evidence 时，必须走 P02 台账；delegation 不把 INFERRED 变 CONFIRMED。
- [ ] Scope 修改清除 delegation 并重新请求该需求授权；spec/plan 普通修订保留明确授权范围，但必须重新审核新 snapshot。
- [ ] 修改所有互相冲突的说明：当前 constitution “永远不代理任何审核”与新可选 policy 必须统一；默认行为维持 strict。
- [ ] 跑 `node --test`，在 README 用两个完整例子解释严格和授权模式。

**退出验收：** 可用独立审核承担部分实际检查；协议可信范围、人工决定边界、重试上限和旧报告失效有测试。没有真实宿主试跑前，不得称审核已全自动落地。
