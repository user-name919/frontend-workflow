# 需求自动化验收接入

使用同级安装的 `acceptance-testing` Skill。状态链和人工审批权限保持原样：spec 定义 AC，plan 补用例和执行入口；任务测试在 DONE 交审前运行；最终候选整单重跑在 VERIFYING；FINAL_REVIEW 核对原文、结果及人工项。

截图、逐项可读报告、固定目录和对话中的进度说明见 [验收截图与可读报告](acceptance-review.md)。新运行的 UI/navigation 通过预期必须关联当前 run 的截图；执行器自动生成 HTML 报告与总览，并输出开始/执行中/结束提示。

项目启动、可选依赖应用、URL 参数、登录和数据准备见 [项目运行上下文](test-runtime.md)。所有通过记录须覆盖逐条前提与预期；旧的仅一句 passed、登录确认或缺数据记录需要保留并补测。browser-json 支持可重复 ego-browser 测试，和 Playwright 一样属于 browser 证据。

方案阶段用 `render-artifacts.mjs <feature-dir> --phase spec` 生成 AC 视图，不要求未来的测试文件/运行配置已齐备，也不覆盖任务视图。计划阶段使用默认 plan 完整校验。没有活动 feature 的纯用例设计可先输出标注待补字段的草案，不能把草案当成可准入 delivery。

## delivery v2

`intake.json` 保留原始来源、证据和 FR；delivery 的 schemaVersion=2 与 status 的 schemaVersion 无关。各集合的 `id` 稳定且唯一。

- `acceptance[]`：原有 id/requirementIds/given/when/then；verification 为 `test|manual|inspection`。
- `testCases[]`：id、acceptanceIds、method（`browser|manual|inspection`）、environmentId、requiredAt（至少 `feature`，可加 `task:T1`）、preconditions、steps、expectations。expectations 每项含 id、observable（ui/network/navigation/storage/document）、expected。browser 另含 dataRef、implementation.file/testId；contract-mock 用例含 mockRuleIds。
- `verification.inputs[]`：确认需求/契约的本地文件或摘录，`{space:"project"|"feature",path:"相对路径"}`；禁止输出目录作为输入。外部文件先保存授权可读的本地副本并在 intake 留来源。
- `verification.environments[]`：id、kind（local/contract-mock/live-test）、setup、reset、inputs（配置/fixture 路径）。browser 环境另需 baseURL、Playwright projectName、contract `{path,sha256}`。mock 环境还需 mocks `[{id,method,url,fixture}]`。路径均相对真实项目；凭据只引用项目已有安全配置，不写令牌。
- `verification.checks[]`：id、kind（engineering/acceptance）、command、args、cwd、environmentId、caseIds。acceptance 使用 `report:"playwright-json"` 或 `"browser-json"`，engineering 不能替代业务用例。
- `tasks[].verifyIds` 引用 checks；v2 不再内嵌 verify。`verification.finalCheckIds` 定义最终候选必跑集，必须覆盖全部自动化业务用例。
- 原有 tasks/links 不变。测试、配置和 fixture 按原任务规则登记文件。计划允许 create，执行时文件必须存在。task 阶段只要求当前检查涉及的测试实现存在，跨任务流程在 feature 执行。

AC → FR → 原始来源提供预期依据；TC → check → run → raw report 提供执行依据。编号齐全只能证明结构覆盖，不能证明规则理解正确；原文复核、断言审查和关键缺陷反例验证不可省略。

## Playwright 约定

项目自行锁定兼容版本，工作流不向业务项目强装依赖。完整 JSON reporter 的 outputFile 取 `process.env.PLAYWRIGHT_JSON_OUTPUT_FILE`。禁止 onlyFailures。测试输出目录使用 `process.env.WORKFLOW_VERIFICATION_DIR + '/evidence'`，避免写入被 Git 跟踪的源码目录。配置 `webServer.reuseExistingServer=false`，确保启动当前 checkout。

测试标题为 `[TC-ID] 描述`（与 implementation.testId 一致），或用 `acceptance-case` annotation 声明稳定 ID。报告必须同时匹配文件和 Playwright projectName；参数化场景用不同 ID。每个 browser case 在 afterEach 中用 testInfo.attach 写一个 `acceptance-context` JSON：

```json
{"environmentId":"local-contract-mock","baseURL":"http://127.0.0.1:3100","mockedRoutes":["profile"],"mockHits":{"profile":1}}
```

字段取实际配置、注册路由和请求计数，不能硬编码伪造命中。live-test 的 mockedRoutes/mocks 为空、无正数 mockHits。mockRuleIds 中的每条规则至少命中一次。此记录是可核查的测试观察，不是能防恶意伪造的远程证明；reviewer 仍需检查测试代码和请求边界。

优先在真实 UI 操作并断言状态、数据、网络参数和次数。新接口未部署用契约 fixture 直接 fulfill；原有接口可保留真实调用，但整项仍标 contract-mock。真实联调用单独 environment/case/check，不在失败时切 mock。客户端超时用 pending 超过应用配置的阈值，不能用测试超时或 abort('timedout') 冒充。

## 执行入口

先读 status 中当前 control.version/attemptId，写请求 JSON，再运行：

```sh
node .ai-dev/scripts/run-verification.mjs <feature-dir> --request run.json
```

任务请求示例：`{"scope":"task","taskId":"T1","attemptId":"A1","checkId":"profile-browser","expectedVersion":12}`。整单请求：`{"scope":"feature","checkId":"profile-browser","expectedVersion":20}`。每次执行后重新读取版本；失败退出码为 1，完整结果仍落盘。

执行器自己捕获前快照，在执行后与准入时重查。输出写入独立 `revisions/verifications/<runId>/`，记录先落盘再引用。完整报告、日志、附件和快照都有指纹；零用例、漏项、skip、预期失败、flaky、环境错误和过期证据不能通过。最新尝试优先，旧成功不能覆盖后续失败或中断。

修复仍在当前阶段进行，先处理任务的 repair/running/review_pending，再判断整单就绪。测试连续失败与审核修复次数分别持久化，新的任务 attempt 或 fixRound=0 请求不会清零审核历史。首次测试失败后允许 policy.maxFixRounds 次自动修复（默认 3）；耗尽时 next 停止自动续跑并展示剩余问题。显式诊断复跑仍可执行，新的稳定通过清除该 check 的连续失败计数，历史保留。

```sh
node .ai-dev/scripts/workflow-control.mjs <feature-dir> acceptance-status
node .ai-dev/scripts/workflow-control.mjs <feature-dir> refresh-acceptance
```

acceptance-results.json 与 verification.md 是派生视图；准入重新校验原始记录。测试后的新输出需要重新 seal 审核包。已写入记录但账本版本冲突时，确认进程已停止，再执行 recover-verification，请求含 runId/actor/expectedVersion/confirmWorkerStopped:true。无有效完整结果则记 interrupted，不伪造 pass。

## 人工项和最终放行

自动检查通过后可进入 FINAL_REVIEW，人工项仍 pending。`acceptance-snapshot` 生成供人检查的候选快照。实际确认后通过 record-manual-check（inspection 用 record-case-evidence）登记 caseId、actor、observation、result（passed/failed）、expectedSnapshotId、expectedVersion；manual 还需实际 confirmationRef，inspection 还需 evidenceRefs。记录不等于最终批准；重新制包复审后沿用 approve final → COMPLETE。

必需 live-test 尚未完成时只能报告前端受控测试结果，整单不能完成。若原本确认的范围只含前端，则按原范围报告未包含的后端联调及责任人，不能运行失败后悄悄删掉 live case。

## 旧需求迁移

v1 可读取、诊断和保留历史命令记录；运行中需求在下一次 spec/plan/final 门禁或 DONE 交审前必须补 v2。通过 import-artifacts draft 提供旧 delivery 和 intake，工具只把命令改成有 ID 的 engineering checks，未知 cases/environment 保持待补。根据原始来源补齐并按原流程审核，再 accept。旧 JSON/Markdown 会备份，受影响批准失效；主状态不回退。COMPLETE 历史需求不自动重开。

## 独立审核

使用 prepare-review 的 v2 包。plan 检查每个 TC 的来源和测试设计；task/final acceptance checks 加 caseId，browser 对应 method=test。通过报告中的 verificationRef 提供 caseId、runId、recordMaterialId、outputMaterialId，包内材料包括实际 record.json 和 raw-report.json。每个必需工作流规则需直接映射，不能借用别项 pass。人工确认后、新运行后或代码变化后重新封存和复核。

本地演示与缺陷反例见仓库 `eval/acceptance/README.md`。真实业务项目仍需验证契约、账号、数据重置和实际调用链，样例不能替代该试点。
