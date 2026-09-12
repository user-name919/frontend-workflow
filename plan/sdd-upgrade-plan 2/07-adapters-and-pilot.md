# P07 宿主适配与团队试点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户指定其他模型执行本计划；不要求本对话启动执行或分派子代理。执行环境没有该 Skill 时，按本文任务和验收逐项实施。

**Goal:** 将同一流程交给其他同事使用，并区分工具兼容与模型效果。

**Architecture:** 复用现有 installer，增加项目级诊断、能力说明与真实试跑矩阵。宿主差异只出现在入口和派发映射，核心 schema 与 Gate 不复制。

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

依赖 P05。P06 提供测量方法和至少探索性结果。核心路线稳定后再增加实际工具支持，避免一开始做未经验证的适配矩阵。

### Task 1：能力合同和降级行为

**Files**
- Create: `template/.ai-dev/host-capabilities.json`
- Create: `.agents/skills/prd-to-code/references/host-adaptation.md`
- Create: `template/.ai-dev/scripts/lib/capabilities.mjs`
- Test: `test/capabilities.test.mjs`

**Interfaces**
- `resolveCapabilities(config, evidence): {mode,features,limitations}`。
- features=freshContextDispatch|resumeWorker|readOnlyReviewer|modelSelection|toolHooks，每项 supported|unsupported|unknown。
- mode=assisted|autonomous-in-host。
- 记录 hostName、hostVersion、checkedAt、evidencePath；缺证据不能默认 supported。

- [ ] 测试无 freshContextDispatch 时不走独立子 Agent 路径，返回 assisted；未知 toolHooks 不声明工具调用已被强制拦截。
- [ ] 核心断言：

```js
const result = resolveCapabilities(unknownHost, [])
assert.equal(result.mode, 'assisted')
assert.ok(result.limitations.length > 0)
```

- [ ] 运行失败测试后实现能力枚举与模式计算。独立上下文但无只读工具约束的宿主可支持派发，需写明 reviewer 只读依赖行为规则，而非操作系统限制。
- [ ] 主 Skill 使用 host-adaptation 文档查当前实际提供的工具；不得写“任何 Cursor/Claude/Codex 版本都支持”的保证。
- [ ] 不支持 resumeWorker 时用新上下文重新注入本任务 brief、最近报告和未解决 finding；标记 resumed_as_fresh，禁止伪造继续原会话。
- [ ] 无子 Agent 时导出任务/审核包供另一个模型会话处理，明确是人工交接。单会话改称 reviewer 不满足独立审核要求。
- [ ] 模型指定能力不可用时保持用户已选模型并记录限制；不自动购买、配置 Key 或绕过产品权限。
- [ ] 跑 `node --test test/capabilities.test.mjs`。

### Task 2：安装、诊断和升级包

**Files**
- Modify: `src/installer.mjs`、`bin/frontend-work-flow.mjs`
- Modify: `test/installer.test.mjs`
- Create: `test/packaging.test.mjs`
- Modify: `README.md`

**Interfaces**
- `doctor [project] --json`：保留无参数 package doctor；有 project 时检查安装文件、schema、Git、实际 runtime、声明的宿主能力。
- `setup [project]` 保持冲突预检/不写现有 AGENTS.md/force 前备份。
- 新增安装清单 `.ai-dev/installation.json`，包含 packageVersion、assetHashes、installedAt；它只用于诊断，不当权限证据。

- [ ] 写回归：含 lib/references 新目录仍完整复制；doctor 检查 Node major<18 时不报告 OK；损坏配置、未知 schema 返回失败。
- [ ] 安装清单在复制成功后写入；冲突时清单也不改变。全部安装输入预检后才开始写入，不把旧数据与模板混合覆盖。
- [ ] 修改参数解析，显式接受 --json 和 project，不让未知参数落成目标路径。
- [ ] 制作本地 npm pack 到临时目录并检查 tar 文件列表包含新增 scripts/lib、references、templates；这不是发布。已有 features、eval 原始数据、测试临时目录不得打包。
- [ ] setup --force 仅更新分发资产，保留目标项目的真实 features 与运行记录。工作流升级与 Workspace schema 迁移分开执行，不隐式批量迁移所有需求。
- [ ] README 提供从干净项目 setup → init → 标准输入 → 人工审核 → task → final 的一条完整实际示例。
- [ ] 跑 `node --test test/installer.test.mjs test/packaging.test.mjs` 和全量测试。

### Task 3：真实兼容矩阵和同事独立试点

**Files**
- Create: `docs/host-compatibility.md`
- Create: `docs/pilot-guide.md`
- Create: `docs/pilot-results.md`
- Modify: `docs/frontend-sdd-workflow-design.md`、`docs/frontend-sdd-execution-strategy-and-comparison.md`、`docs/frontend-ai-workflow-competitive-capability-research.md`

- [ ] 矩阵每行写工具与实际版本、模型、触发入口、脚本调用、独立 reviewer、恢复、整体 case 结果和证据位置。
- [ ] 优先试用目前可访问的一个宿主；第二个宿主没有条件就写 not_tested。不能把“共享 Skills 路径”当成质量相同的证据。
- [ ] 找一位未参与设计的同事，按 guide 从安装开始独立完成一个需求；不要替他操作，把卡点、求助次数和耗时记录下来。
- [ ] 若本轮没有同事参加，只交付演练脚本，试点标记未执行。执行模型不能代替真实同事的学习成本。
- [ ] 在两种宿主使用同一 case 做 P06 对照，分别报告兼容性与质量差异；不得保证跨模型完全一致。
- [ ] 更新历史调研中已过时的描述：独立 reviewer 当前版本、可选 delegated-review、现有实际能力与未来能力。保留历史来源日期，不声称所有竞品能力均重新验证。
- [ ] 生成一份可展示材料：需求输入、Gate 输出、一次问题打回、修复复审、最终 Patch 和实测数据。图和说明只引用已完成行为。
- [ ] 最终运行 `node --test`、本地包验证、目标试点流程，提交前检查没有业务原始材料、凭据或模型会话被意外加入发布包。

**退出验收：** 可复用安装和真实使用证据齐全；未测能力清楚标注；其他人无需理解控制器源码即可完成至少一条被验证的使用路径。

