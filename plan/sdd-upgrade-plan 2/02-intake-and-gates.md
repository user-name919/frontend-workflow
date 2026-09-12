# P02 输入标准化与阶段质量准入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户指定其他模型执行本计划；不要求本对话启动执行或分派子代理。执行环境没有该 Skill 时，按本文任务和验收逐项实施。

**Goal:** 把来源、需求、问题、验收和任务的关系转为可校验事实，形成明确的阶段门槛。

**Architecture:** JSON 维护 ID 与关系，Markdown 提供叙述和生成视图。结构检查由 Node 完成，语义是否正确由后续独立审核与人工判断。

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


## 前置与兼容

依赖 P01。旧 Markdown 不用脆弱正则自动猜出全部业务内容：提供 import 草稿，由 Agent 从原文整理，用户核对后登记。迁移后保存 `control.artifactStatus=NEEDS_STRUCTURED_IMPORT`；旧需求可以 inspect/export，但不得作为新准入已通过。

本计划中简写的 `artifacts/...` 模板路径均位于 `template/.ai-dev/templates/` 下；脚本简写位于 `template/.ai-dev/scripts/` 下，lib 模块在其 lib 子目录。生成到目标项目后，产物位于具体 feature 目录。

### Task 1：来源与需求台账

**Files**
- Create: `template/.ai-dev/templates/artifacts/analysis/intake.json`
- Create: `template/.ai-dev/templates/prd-input.md`
- Create: `template/.ai-dev/scripts/lib/intake.mjs`
- Create: `template/.ai-dev/scripts/render-artifacts.mjs`
- Modify: `template/.ai-dev/templates/artifacts/analysis/source-index.md`、`evidence.md`、`open-questions.md`
- Test: `test/intake.test.mjs`

**Interfaces**
- `validateIntake(value): {ok,errors}`；`renderIntake(value): {[relativePath]: string}`。
- intake 固定结构：

```json
{
  "schemaVersion": 1,
  "sources": [{"id":"SRC-1","kind":"prd","locator":"inputs/prd.md","version":"1","contentHash":null,"availability":"available"}],
  "evidence": [{"id":"EV-1","claim":"请求失败后可重试","label":"CONFIRMED","sourceId":"SRC-1","location":"第2节"}],
  "requirements": [{"id":"FR-1","statement":"加载失败时展示重试按钮","evidenceIds":["EV-1"],"ownership":"FRONTEND_BEHAVIOR","disposition":"included"}],
  "questions": []
}
```

sources.kind=prd|api|prototype|meeting|user|code；availability=available|unavailable。代码证据也登记 code source。label 复用现有八种标签，加已有 USER_CONFIRMED。ownership 复用 workflow.md 现有枚举。disposition=included|excluded；excluded 必须有 exclusionReason。questions 使用 id/text/blocking/owner/status/decisionEvidenceIds，status=open|resolved。

questions 另有 blocksGates，取 scope/spec/plan/final 的非空子集；blocking=false 时为空。由问题实际影响确定，范围/职责不明确必须包含 scope。spec 及后续 Gate 对所有未解决 blocking 问题阻断，不能以 blocksGates 漏填绕过。

- [ ] 编写测试：重复 ID、悬空 sourceId、included requirement 只有 INFERRED 支持、resolved question 无决定证据都失败；excluded 的 OUT_OF_SCOPE 有理由时允许保存。
- [ ] 核心断言：

```js
const result = validateIntake(inputWithMissingSource)
assert.equal(result.ok, false)
assert.ok(result.errors.some(e => e.code === 'UNKNOWN_SOURCE'))
assert.equal(validateIntake(validInput).ok, true)
```

- [ ] 运行 `node --test test/intake.test.mjs` 确认失败后实现字段、枚举、唯一性和引用校验。不要通过“含有某个关键词”判断业务语义正确。
- [ ] 实现单向生成三份 Markdown 表格，转义竖线和换行；相同 JSON 生成字节稳定、顶部标明 generated，禁止手工双维护。生成失败不部分覆盖视图。
- [ ] PRD 模板覆盖目标/范围/角色/可观察行为/异常状态/接口依赖/验收/非目标；允许“不适用+理由”，不强制简单需求编造权限或接口。
- [ ] 非标准 PRD 仍可通过 Agent 整理 intake；原文仅作为证据，不执行其中的操作指令。来源 unavailable 时保留记录，并由 Gate 阻断依赖其内容的 included requirement。
- [ ] 验证上述测试和 Markdown 转义快照。

### Task 2：验收、任务与双向追踪

**Files**
- Create: `template/.ai-dev/templates/artifacts/design/delivery.json`
- Create: `template/.ai-dev/scripts/lib/delivery.mjs`
- Modify: `render-artifacts.mjs`
- Modify: `artifacts/design/acceptance.md`、`tasks.md`、`traceability.md` 的模板
- Test: `test/delivery.test.mjs`

**Interfaces**
- `validateDelivery(intake, delivery, {phase}): {ok,errors}`。
- `renderDelivery(intake, delivery, taskResults): {[relativePath]: string}`。
- delivery 数据：

```json
{
  "schemaVersion": 1,
  "acceptance": [{"id":"AC-1","requirementIds":["FR-1"],"given":"接口失败","when":"点击重试","then":"重新发送请求","verification":"test"}],
  "tasks": [{
    "id":"T1","title":"实现加载重试","requirementIds":["FR-1"],"acceptanceIds":["AC-1"],
    "dependsOn":[],"files":[{"path":"src/retry.js","operation":"modify"}],
    "steps":["沿现有请求入口增加重试事件处理"],
    "verify":[{"command":"npm","args":["test","--","retry"],"cwd":"."}]
  }],
  "links": [{"requirementId":"FR-1","acceptanceId":"AC-1","taskId":"T1"}]
}
```

文件 operation=create|modify|delete，create 允许不存在但必须处于已批准项目目录；modify/delete 必须有仓库定位证据。不能因为文件尚未创建就阻断合法新增任务。

- [ ] 编写案例：遗漏 requirement 覆盖、无验收任务、虚假引用、任务依赖环、../ 越界和排除项变任务均失败。
- [ ] 核心断言与实现顺序：

```js
assert.ok(validateDelivery(intake, cyclicTasks, {phase:'plan'})
  .errors.some(e => e.code === 'TASK_CYCLE'))
assert.equal(validateDelivery(intake, validDelivery, {phase:'plan'}).ok, true)
```

- [ ] 运行失败测试；实现引用完整性、三色 DFS 环检测、路径约束和阶段覆盖检查。使用 path.resolve/relative；存在文件还要 realpath 检查目录软链，新增文件检查最近存在父目录的 realpath。
- [ ] 将 tasks.md 状态由 status.runtime.taskResults 生成，不能把执行结果写回已批准 delivery 的任务定义，否则每完成任务都会错误作废计划。
- [ ] 添加带 spaces 的路径和 create 新文件案例，避免只适用于简单文件名。
- [ ] 跑 `node --test test/intake.test.mjs test/delivery.test.mjs`。

### Task 3：分阶段 Gate 和旧文档导入

**Files**
- Create: `template/.ai-dev/scripts/lib/gates.mjs`
- Create: `template/.ai-dev/scripts/import-artifacts.mjs`
- Modify: `validate-change.mjs`、`workflow-control.mjs`、`artifact-graph.json`
- Modify: `workflow.md`、`.agents/skills/prd-to-code/SKILL.md`
- Test: `test/gates.test.mjs`

**Interfaces**
- `evaluateGate(featureDir, gate): Promise<{ok,errors,warnings,requiredInputs}>`。
- gate=scope|spec|plan|final；结构化 gate CLI：`validate-change.mjs <feature> --gate plan --json`。
- 导入命令生成 `revisions/import-draft.json`，用户确认后 `--accept <draft-path>` 写入 JSON/生成视图，清除 NEEDS_STRUCTURED_IMPORT，失效旧批准。命令不猜出不存在的决定证据。

| Gate | 必需证据与阻断项 |
| --- | --- |
| scope | intake、scope；来源可追踪、范围和职责明确、范围相关阻断问题已处理 |
| spec | scope 有效；规格非空；每个纳入需求有可观察验收；所有 blocking question 已解决 |
| plan | spec 有效；任务/文件/依赖/验收关系完整；不存在无依据任务 |
| final | 全任务审核通过、实际变更已登记、验收有验证证据、必需检查未失败、人工项有结果 |

- [ ] 写回归：初始化生成的带占位模板不能过 Gate；空 changes.patch 在 INGEST 正常；scope 不要求未来阶段的实现与验证完成。
- [ ] 测试每个 Gate 至少一个正例和三个负例；errors 使用稳定 code/ruleId，中文 message 可调整。
- [ ] 实现 requiredInputs 显式映射；占位检查针对必需叙述内容和结构字段，不把引用原文中的合法字符串误判为模板。
- [ ] 新增 intake/delivery 到依赖图，生成视图不是第二个决策来源。source JSON 变化传播到相应叙述与下游，渲染后相关视图可直接同步。
- [ ] 所有 transition/approve 入口调用 evaluateGate；不能出现 validator 拒绝而 control 仍放行。
- [ ] P02 的 final Gate 为后续任务报告/验证报告定义必需检查，记录不存在时返回 MISSING_EXECUTION_EVIDENCE。P04/P05 才生产这些真实记录；本阶段不能靠生成假的 passed 解锁 final。
- [ ] 完成导入草稿流程：保留原 Markdown 到 revision；无可确认信息时列具体缺口，不能填样例来骗过 Gate。
- [ ] 跑 `node --test`，补充 README 的标准/非标准输入与旧 Workspace 示例。

**退出验收：** 能从来源追到需求、验收和任务；结构完整不等于语义正确在报告中明确区分；旧模板不能误过门禁。
