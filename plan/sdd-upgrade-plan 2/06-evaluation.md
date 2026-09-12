# P06 对照评测与提效证据 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户指定其他模型执行本计划；不要求本对话启动执行或分派子代理。执行环境没有该 Skill 时，按本文任务和验收逐项实施。

**Goal:** 建立可重复的技术回归样例和真实人工成本对照，验证工作流带来的收益与代价。

**Architecture:** 离线协议测试和真实模型评测分开记录。以相同输入、仓库基线、模型和验收规则做配对比较，统计失败与缺失数据。

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


## 执行时机

Task 1 在 P01 前完成；Task 2 可与核心研发分开推进但不得共享修改同一文件；Task 3 在 P05 完成后执行。数据采集从第一天开始，不能等改完以后回忆旧耗时。

### Task 1：固定样例与现状基线

**Files**
- Create: `eval/README.md`
- Create: `eval/cases/retry-state/case.json`、`prd.md`、`acceptance.md`
- Create: `eval/cases/contract-conflict/case.json`、`prd.md`、`api.md`、`acceptance.md`
- Create: `eval/cases/context-resume/case.json`、`prd.md`、`acceptance.md`
- Create: `eval/protocol.md`
- Create: `eval/runs/.gitignore`，忽略全部真实运行数据，避免默认发布业务材料

**Interfaces**
- case=`{id,description,repositoryBase,inputFiles,acceptanceFile,expectedDecision}`。
- repositoryBase 为实际 fixture Git commit；每次试验使用由 fixture 创建的独立临时仓库，不填假 hash。
- expectedDecision=deliver|ask_human。验收文件对被测生成模型隐藏，作为独立评判参考。

- [ ] 定义 retry-state：现有请求页面增加失败后重试；明确成功/加载/失败/重复点击四个场景，要求保持原成功路径。
- [ ] 定义 contract-conflict：PRD 要求展示学生字段，接口未提供且归后端；正确结果是指出缺口并等待确认，不能编造字段和后端实现。
- [ ] 定义 context-resume：两任务运行后关闭上下文，使用相同磁盘结果继续；检查是否重复已完成修改、是否保留原验收和审批边界。
- [ ] 每个 fixture 使用最小 Node 项目，不依赖外网安装包；HTML/JS 示例可用静态页面，DOM 体验人工验收；node:test 覆盖可执行逻辑。
- [ ] 在改造前记录 A=直接使用 AI、B=现有 v0.3.0 工作流。固定模型/工具版本、原始 prompt、材料 hash、代码基线、时间和所有人工干预。
- [ ] 若尚无权限或模型不可用，记录 not_run，不填 0，不推测旧模型表现。样例脚手架完成不等于基线实验完成。

### Task 2：运行数据与统计工具

**Files**
- Create: `eval/scripts/validate-run.mjs`
- Create: `eval/scripts/summarize.mjs`
- Create: `eval/run-schema.md`
- Test: `test/evaluation.test.mjs`

**Interfaces**
- `validateRun(run): {ok,errors}`。
- `summarizeRuns(runs): Summary`。
- CLI：`node eval/scripts/summarize.mjs <runs-dir> --output <report.md>`，默认不覆盖已有报告。
- 记录结构：

```json
{
  "schemaVersion":1,
  "caseId":"retry-state",
  "variant":"C",
  "repeat":1,
  "tool":{"name":"实际宿主","version":"实际版本"},
  "model":"实际模型标识",
  "workflowCommit":"实际提交",
  "repositoryBase":"实际提交",
  "inputHash":"实际输入哈希",
  "outcome":"failed",
  "wallClockMs":120000,
  "humanActiveMs":45000,
  "humanInterventions":3,
  "userTurns":4,
  "agentDispatches":2,
  "fixRounds":1,
  "acceptancePassed":2,
  "acceptanceTotal":4,
  "tokenUsage":null,
  "estimatedCost":null,
  "evidencePaths":["transcript.md","verification.json"],
  "limitations":[]
}
```

variant=A|B|C，C 为新工作流；outcome=delivered|correctly_blocked|failed|not_run。usage 不可得填 null。humanInterventions 指主动纠偏/补充/批准操作次数，userTurns 另计；不要混为一个数字。wallClockMs 包括等待与审核，humanActiveMs 只计人工实际投入。

- [ ] 写测试：缺模型信息/负耗时/acceptancePassed>total 拒绝；null Token 保持 unknown；失败样本不能被筛掉。
- [ ] 核心断言：

```js
const summary = summarizeRuns([failedRun, successfulRun])
assert.equal(summary.totalRuns, 2)
assert.equal(summary.failedRuns, 1)
assert.equal(summary.tokenUsage.availableRuns, 0)
```

- [ ] 运行 `node --test test/evaluation.test.mjs` 确认失败，再实现中位数、范围、成功/正确阻断比例和配对差值。
- [ ] 同 caseId/repeat/tool/model/repositoryBase/inputHash 才允许计算 A/C 或 B/C 配对变化；不匹配列为不可比。对 denominator=0 或缺值不输出百分比。
- [ ] 报告分别显示所有样本的耗时和成功样本耗时，展示失败成本，不只筛选成功运行；not_run 单独计数。
- [ ] CLI 输出原始计数、样本量、限制条件和每次 evidence 链接，不输出“显著提升”统计断言。
- [ ] 将 P05 运行日志转换到本 schema；人工时间由显式计时记录补充，禁止从模型时间直接推算。
- [ ] 跑 targeted 与全量测试。

### Task 3：配对实验与发布判断

**Files**
- Create: `eval/results/pilot-report.md`
- Modify: `eval/protocol.md`、`README.md` 的结果说明
- 原始运行保存在 eval/runs，脱敏汇总可手工纳入版本库

- [ ] 正式小试点至少三个 case，每个 A/B/C 各运行三次，共 27 次；试跑顺序交错，避免操作者熟练度系统性偏向 C。
- [ ] 正式述职时间不足时可先做每 case 各一次共 9 次，明确“探索性样本”，不外推团队收益。如果连九次也未完成，按实际数量如实呈现。
- [ ] 操作者按固定答复脚本处理同类提问；未经请求不得额外提示某组；记录任何偏离。
- [ ] 首次计划质量由同一验收 rubric 判断，尽可能隐藏 A/B/C 身份：遗漏、额外范围、文件定位、异常验收覆盖分别给证据，不只给总分。
- [ ] 每次保留原始输入、用户干预、最终 Diff、验证结果、审核报告、耗时记录。跨仓 case 正确阻断算预期成功，不算“没写代码失败”。
- [ ] 生成三段结论：已经观察到的收益、增加的审核/模型成本、样本不足或失败场景。
- [ ] 发布建议门槛（设计目标，不是已实现数据）：无擅自越界或跳过必要人工 Gate；正常样例达到全部验收；人工主动投入中位数相对 A 至少下降 15%，总耗时中位数增加不超过 20%。不达标则修正流程，不能修改计数口径使其达标。
- [ ] 加一个不使用工作流的适用边界说明：极小、验收明确且无跨文件影响的改动可以使用普通研发流程，暂不为其建设第二套 lite 状态机。

**退出验收：** 工具测试通过和真实样例结果分别可追溯；数据不全时保留未知，不能写成零；即使未观察到提效，也交付完整失败分析。

