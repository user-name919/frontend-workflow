# Frontend SDD 增量优化设计

## 1. 结论和三种路线

推荐保留现有 Node + Skill + Markdown + JSON + Git 结构，在其上增加确定性控制、结构化准入、独立审核、任务调度和评测。宿主 Agent 继续负责模型调用、代码检索和实际工具执行。

| 路线 | 收益 | 代价 | 决定 |
| --- | --- | --- | --- |
| 直接给现有 Skill 加多角色提示词 | 小改动，可快速试验 | 不能解决审核过期、非法跳转和断点恢复 | 仅用于原型，不作为完整交付 |
| 增量领域控制器 + 宿主原生 Agent | 复用现有工程；规则可测试；可逐步减少人工检查 | 需要定义接口和版本迁移 | 本计划采用 |
| 自建模型服务、多 Agent 平台、RAG 和 Web 控制台 | 高度可定制 | 引入服务、权限、运维和分布式状态问题 | 目前缺少需求和收益依据，暂缓 |

这属于架构级规划。本轮按用户要求直接交付供其他模型执行的设计与详细计划；不在本轮实现业务代码。

## 2. 参考资料和采用边界

### 用户指定文章

[Subagent-Driven Development：让多个 Agent 协作交付一个 Plan](https://juejin.cn/post/7654116115207733291)，页面日期 2026-06-23，作者清水寺小和尚。本次通过公开 HTML 读取正文。

文章重点是任务级新上下文、协调者/实现者/审核者分工、规格与代码质量双维审核、四类实现报告及失败后复审。本设计借鉴这些机制，将其用于已批准任务的实施阶段。

术语必须区分：你的 SDD 是 Specification-Driven Development；文章的 SDD 是 Subagent-Driven Development。前者覆盖需求到交付，后者是其中一种任务执行方式。

文章中的“成本降低 80%+”“快 3–5 倍”“超过三个任务几乎总是更好”没有作为本项目的证据采用。文章中的自动 commit、默认分支收尾也不直接移入现有流程。

### 官方交叉核对

- [Superpowers 官方子 Agent 流程](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)：任务上下文隔离、任务审查、最终整体审查。2026-09-12 读取的 main 已描述单个 task reviewer 给出 spec/quality 两个结论，和文章的两个独立 reviewer 实现不同。因此本设计强制两个判断维度，不把永久启动两个 reviewer 作为硬性要求；默认同一个独立 reviewer 先评 spec，再评 quality，spec 不通过则 quality 标记 not_run。
- [Spec Kit 官方 README](https://github.com/github/spec-kit/blob/main/README.md)：规格、计划、任务、实现与一致性检查分工。本设计采用明确产物契约与检查入口，不复制其整个命令体系。
- [OpenSpec 官方 Concepts](https://github.com/Fission-AI/OpenSpec/blob/main/docs/concepts.md)：面向既有项目的变更、行为规格和场景。本设计借鉴可观察验收与产物依赖，不引入完整主规格合并/归档系统。

以上为读取时的可变 main，执行模型若要移植源码应另行固定上游 commit 和许可证；本计划只有自主设计与机制参考。

## 3. 仓库实际现状

根目录 `/Users/tal/Desktop/frontend-workflow`，基线 `a4e86ad`，版本 `0.3.0`。不要误用此前目录 `/Users/tal/Desktop/frontend-work-flow`。

| 已读文件 | 当前行为 | 真正的增量空间 |
| --- | --- | --- |
| `.agents/skills/prd-to-code/SKILL.md` | 按状态执行、四个人工 Gate、限制真实仓库、手工 mark/resolve | 控制动作命令化、角色与宿主能力协议 |
| `src/installer.mjs` | install/setup/doctor、冲突预检、force 备份 | 安装新增运行文件、项目级能力与版本诊断 |
| `template/.ai-dev/scripts/init-change.mjs` | 稳定需求 ID、真实 root/baseCommit/initialChanges | schemaVersion 与控制记录 |
| `validate-change.mjs` | 检查文件存在、少量字段、审批是否有名字和时间、stale 非空则拒绝 | 产物内容、追踪引用、迁移合法性、阶段相关检查 |
| `update-consistency.mjs` | 根据图传播 stale，清除批准，保存 revision | 漏 mark 检测、刷新依据、审批绑定版本 |
| `record-code-changes.mjs` | 传入文件清单后生成软链、基线 Patch、preExisting 标记 | 验证输入新鲜度、任务级 Diff 包、不漏交付文件 |
| `artifact-graph.json` | 声明传递依赖和审批失效 | 识别已生成/尚未生成，按阶段判断阻断 |

目前没有独立 reviewer 调度器、模型调用服务或内容评分引擎。既有 14 项测试本次通过；这些测试不证明 AI 交付质量。

## 4. 全局约束

- Node.js >=18，ES Modules，node:test，无新增运行时第三方依赖。
- 包名保持 frontend-work-flow；业务代码执行根目录必须与 status.json.project.root 的真实路径一致。
- 默认使用开发者当前真实项目；不强制 Worktree，不更改已有 Git 暂存区，不自动 commit/push/PR/merge/deploy。
- Workspace 是需求记录；不得把软链当历史快照，不得覆盖初始化前的无关改动。
- scope 和 final 始终要求人工决定；spec 和 plan 默认也要求人工，仅在用户对本需求明确授权 delegated-review 后可由合格独立审核结果放行。
- 需求歧义、来源冲突、跨仓职责变化、接口契约缺口不能由 reviewer 自行转为确认事实。
- 同一真实工作区同时最多一个实现写入者；审核者不修改业务代码与审批记录。
- CLI 提供流程校验，不宣称能隔离拥有相同文件写权限的恶意 Agent；审批 actor 记录不是身份认证。
- 真实运行、人工试点和收益数据必须实测；fake driver 只验证编排逻辑。

## 5. 状态与控制数据

保留现有九个 state：INGEST、SCOPE_REVIEW、SPEC_REVIEW、PLAN_REVIEW、IMPLEMENTING、VERIFYING、FINAL_REVIEW、COMPLETE、BLOCKED。不引入 SPEC/PLAN state；它们是审核状态通过后的 next action。

合法主链：INGEST → SCOPE_REVIEW → SPEC_REVIEW → PLAN_REVIEW → IMPLEMENTING → VERIFYING → FINAL_REVIEW → COMPLETE。BLOCKED 保存 suspendedFrom、reasonCode、requiredInput 和 blockedAt；恢复只回 suspendedFrom，且重新校验，不借恢复跳过审核。

`status.json` 为运行决策唯一权威，新增：

```json
{
  "schemaVersion": 2,
  "control": {"version": 0, "nextEvent": 1, "events": [], "blocked": null},
  "policy": {"mode": "strict", "delegation": null, "maxFixRounds": 3},
  "reviews": {},
  "runtime": {"activeTaskId": null, "attempts": {}, "taskResults": {}}
}
```

`control.version` 用于并发写入检查，不等于 `consistency.revision`。前者任意控制修改递增，后者只在产物失效时递增。events 与 status 在同次原子写入提交，避免先修改状态但丢失审核事件。事件不存完整 PRD、代码或模型对话。

统一存储接口放在 `template/.ai-dev/scripts/lib/workspace-store.mjs`：

```js
readFeature(featureDir) // Promise<StatusV2>，旧版本返回 NEEDS_MIGRATION，迁移显式执行
mutateFeature(featureDir, { expectedVersion, event }, mutate) // Promise<StatusV2>
```

所有写 status 的旧脚本也接入该接口。使用每需求独占锁、临时文件 + rename；锁冲突返回 BUSY，版本不符返回 VERSION_CONFLICT。崩溃遗留锁不自动删除，提供显式恢复说明。revision、snapshot、report 先写唯一文件，再由 status 原子记录其引用；未引用文件不代表已生效。

## 6. 结构化事实与 Markdown 的分工

新增 `artifacts/analysis/intake.json`，持有 sources/evidence/requirements/questions；新增 `artifacts/design/delivery.json`，持有 acceptance/tasks/links。JSON 负责稳定 ID、关系与可判定字段；Markdown 承载范围、行为规格、方案取舍等完整语义。

source-index/evidence/open-questions/acceptance/tasks/traceability 的 Markdown 表格由 JSON 单向生成，是阅读视图，禁止双向人工同步。scope.md、frontend-spec.md、implementation-plan.md、verification.md 保持叙述文档，使用稳定 ID 引用。不要同时在两处手动维护任务状态，任务结果只在 status.runtime.taskResults。

来源可使用经过用户允许的本地附件或 URL 指针；原文缺失标为不可核实。模板检查不能把不适用字段逼成 AI 编造的内容；允许 explicit not_applicable，必须填写理由。

## 7. 准入、变更与审核

每个 Gate 合成三种证据：确定性结构/引用/文件检查、独立语义审核、按 policy 必需的人工决定。AI 的“通过”不覆盖真实测试失败。

快照保存审核输入各文件的 SHA-256 和代码状态标识；批准与报告引用 snapshotId。输入内容变化时旧报告失效。`consistency.revision` 不足以检测漏执行 mark，实际内容哈希是补充证据。

新鲜度必须区分时间语义：规格、任务定义与约束是持续有效的 live 输入；计划审核时的源码是 baseline 证据，已批准任务按计划修改这些文件，不应使计划批准在每次编码后自动失效。task 报告在接收时核对当时完整快照，接收后作为历史任务证据保留；后续任务的合法代码变化不一律推翻此前已通过的任务。最终整体审核必须针对当前完整 Diff 重新进行，检查跨任务集成影响。若已批准的需求/计划定义变化，则相关任务需要重新验证与审核。

未来阶段尚未生成的产物可以保持 pending/stale，不能要求在范围审核时补齐代码与验证报告。进入某个 Gate 只阻断该 Gate 的必需输入及其上游；Final 必须覆盖全部实际交付链。

审核输出统一：pass / revise / needs_human；findings 带 ID、级别、规则 ID、来源位置和处理建议。任务审核包含 spec 和 quality 两个 verdict；spec 未过不能声明 quality 已通过。初审后最多三个修复-复审轮次，仍有阻断问题则转人工；不能通过忽略 finding 达到“完成”。

## 8. 编排与上下文

主 Skill 调用 Node 的 next，拿到明确 action 和输入包，再使用当前宿主实际支持的工具执行。Node 不直接调用模型、不存 API Key。支持真实独立上下文时派发 worker；不支持时输出文件交接包，并将能力标为 assisted，不能模拟分角色对话后声称 independent。

任务 brief 包含任务全文、全局约束、依赖结果、精确输入输出、允许文件、验收与源码定位。只给一个任务的相关内容，避免复制整段对话。代码从真实仓库读取，不将完整仓库复制入 brief。

实现报告：DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED。前者仅代表准备接受审核；不能直接置任务通过。新增或变化的 approved inputs 使执行中的任务和报告过期。

## 9. 领导意见到计划的映射

| 会议录音位置 | 意见 | 计划 |
| --- | --- | --- |
| 28:12、35:02–36:39 | 工具驱动流程、统一入口、降低使用者差异 | P01、P05、P07 |
| 30:08–30:46 | 材料收集、维护、合并链路 | P02、P03 |
| 31:00、32:12、42:15 | 门禁具体化、何时允许继续 | P01、P02、P04 |
| 36:31–36:50 | 输入源头标准化 | P02、P06 |
| 37:09–38:02 | 工具/模型差异和评估 | P06、P07 |
| 38:40、50:51 | 自动继续与人工确认边界 | P04、P05 |
| 49:40–50:51 | 独立审核 Agent、准入、角色输入输出 | P04、P05 |
| 45:22–48:27 | 对话、时间、效果对照 | P06 |
| 26:44–29:36、43:10 | 真实执行示例和可展示产物 | P05、P07 |
| 38:02、47:52 | 调研同类机制和收益 | 本设计、P06 |

## 10. 暂缓项和触发条件

- 并行写入：只有单写入闭环稳定，且有可隔离任务与合并策略后另立设计。
- 自建向量库：只有检索耗时或遗漏成为主要返工来源后立项；P05 先记录相关指标、复用宿主搜索。
- 多仓写入、前后端 Agent：当前保留职责标记和跨仓阻断；需要明确跨仓授权、版本关联和验证协议后扩展。
- Web 面板、在线服务：先验证同事能用 CLI + Markdown 完成需求；不作为本期依赖。
- 模型动态路由：先通过 P06 获得同任务实测数据；不预设某个便宜模型一定更划算。

## 11. 总体验收

旧需求可迁移；无依据不能推进；已批准输入变化后不能复用旧审核；任务有独立审核证据；真实中断可恢复；需求歧义能转人工；试点可交付最终 Patch 与验证报告；有真实基线对照。测试通过、模型质量好、业务提效是三种不同结论，分别举证。
