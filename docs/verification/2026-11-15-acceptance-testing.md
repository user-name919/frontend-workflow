# 需求自动化验收改造验证记录

执行日期：2026-11-15。当前仓库是工作流工具；本记录中的浏览器页面和 HTTP 服务均为隔离的本地演示，不代表实际业务测试环境或真实需求试点已完成。

## 已执行的浏览器验证

- 正确实现：9 个受控响应场景通过，涵盖正常、加载、HTTP 异常、恢复、加载/重试防重、200 业务异常、网络中断及应用超时。
- 后端未就绪：受控测试模式下真实 API 服务返回 503，响应替换直接按演示契约完成，不依赖后端先部署。
- 真实请求模式：1 个本地 HTTP 联调用例通过，未配置响应替换；检查响应契约、服务标识与页面展示。
- 模拟用例通过而必需联调未运行时，整单 readiness 为 false。
- 逐个注入 9 个缺陷，均在预定业务断言上失败；不把构建/启动失败计为检出。
- 最后恢复正确副本，9 个受控场景与 1 个联调场景重新通过，整单 readiness 为 true。

| 缺陷变体 | 目标用例 | 命中断言 | 结果 |
| --- | --- | --- | --- |
| missing retry entry | TC-HTTP-FAIL | `E-RETRY-AVAILABLE` | 检出 |
| retry not wired | TC-RECOVER | `E-RETRY-REQUEST` | 检出 |
| error hidden | TC-HTTP-FAIL | `E-ERROR-VISIBLE` | 检出 |
| stale response | TC-RECOVER | `E-RESPONSE-CONTENT` | 检出 |
| parallel requests | TC-REPEAT | `E-NO-PARALLEL-REQUEST` | 检出 |
| success regression | TC-SUCCESS | `E-SUCCESS-STATE` | 检出 |
| business error treated as success | TC-BUSINESS-FAIL | `E-FAILURE-STATE` | 检出 |
| client timeout removed | TC-TIMEOUT | `E-FAILURE-STATE` | 检出 |
| live contract mismatch | TC-LIVE | `E-LIVE-NAME-CONTRACT` | 检出 |

共 13 次真实浏览器运行：4 次正向运行、9 次缺陷运行。完整原始输出、trace、截图及每次 record 保留在临时工作区，路径见 [运行索引](/private/tmp/frontend-workflow-browser-acceptance-20261115/summary.json)。其中的失败是故意注入并验证的反例，不是被删除或忽略的失败。

## 工作流机制验证

测试覆盖定义引用与调度、部分通过、零退出无报告、skip/flaky/错误映射、mock 命中、旧成功覆盖新失败、运行中/后源码变化、原始证据被改、任务与整单隔离、CAS 冲突恢复、真实确认记录边界，以及直接调用控制器的门禁。

`acceptance-control.test.mjs` 在模拟审批身份下走通：自动检查 → FINAL_REVIEW（人工项 pending）→ 实际协议确认记录 → 独立审核协议 → final 批准 → COMPLETE，并验证缺确认、缺复审、无用例证据时不能放行。该测试不产生真实用户批准。

最终全量 `npm test`：154/154 通过，0 失败、0 跳过；[完整输出](evidence/2026-11-15-acceptance/full-test-suite-final.log)。

提交前另将 Git 暂存内容导出到独立目录，排除工作区原有未提交修改，再次执行 `npm test`：154/154 通过，0 失败、0 跳过；[提交内容验证输出](evidence/2026-11-15-acceptance/staged-test-suite.log)。独立审核涉及的材料与该副本逐文件一致。审核包本身绑定原项目根目录，复制到其他目录后不会自动成为该目录的有效审批证据。

独立审核首轮发现 5 个可复现问题：修复任务沿用旧审核状态、后期任务复审顺序、审核轮次被清零、测试修复缺计数、spec 渲染提前要求 plan 完整性。第二轮发现新 attempt 继承旧 resultRef，导致中断修复无法恢复。六项均已修复；同时补齐结果已写入而账本未更新时的恢复登记。[首轮发现](evidence/2026-11-15-acceptance/independent-findings.json)、[复核发现](evidence/2026-11-15-acceptance/independent-recheck-findings.json)、[独立恢复回归 8/8](evidence/2026-11-15-acceptance/recovery-independent.log)。最终独立复核通过，无剩余可操作发现，报告契约校验通过：[审核报告](evidence/2026-11-15-acceptance/independent-review-report.json)、[材料快照](evidence/2026-11-15-acceptance/independent-review-packet.json)、[校验结果](evidence/2026-11-15-acceptance/independent-review-validation.json)。reviewer 检查了浏览器源码与执行索引，未独立重跑浏览器；复核范围为 P0–P4，不包含真实业务试点。

另以新上下文、仅原始 PRD 和基线代码试用用例生成：生成 8 个浏览器用例及 1 个范围检查，保留 6 个待确认事项，未编造接口契约或运行结果。[用例生成试用产物](evidence/2026-11-15-acceptance/skill-forward-case-design.md)。根据实际试用补充了“无活动 feature、仅设计”及未齐备字段的草案处理方式。该单次试用不等于普遍准确率保证。

修复后的当前执行器又重跑 9 个受控场景和 1 个联调场景，均通过；合计 15 次真实浏览器运行。保存的[浏览器执行索引](evidence/2026-11-15-acceptance/browser-runs.json)包含每次运行身份与完整证据位置。

## 安装与分发

在临时项目实际 setup 成功，新 Skill、delivery v2 模板和执行脚本均被安装；doctor 识别 4 个 Skill。npm pack dry-run 包含新增 Skill 与核心脚本，未包含 node_modules。工作流运行时要求仍为 Node >=18；演示单独锁定 Playwright 1.65.1，使用 Node 26.5.0 与对应 Chromium 执行。

## 真实项目试点边界

已请求目标前端仓库和需求位置，当前未提供对应业务代码/接口环境。P5 尚未执行；不能据本地演示推断实际项目的需求覆盖准确率、维护成本或提效比例。既有 A/B 基线保持 not_run。
