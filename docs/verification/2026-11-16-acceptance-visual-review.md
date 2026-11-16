# 验收截图与可读报告验证

本轮改造统一执行器、报告适配器、截图帮助函数及相关 Skills。没有修改 enterprisewechat 的业务代码、用例或工作流状态，也没有将其历史通过追认为有图的验收。

## 使用结果

- 固定入口：业务项目 `.ai-dev/features/<需求ID>/artifacts/verification/index.html`。
- 每轮报告与图片：`revisions/verifications/<runId>/report.html` 与 `screenshots/<caseId>/`。
- 每个视觉预期关联 screenshotRefs；报告并排展示预期、实际观察和图片，附来源/计划步骤、失败详情及原始日志。
- 新执行器对通过的 UI/navigation 预期缺图报错，重新准入时校验图片指纹；历史记录不追造截图。
- 主 Agent 在计划、开测、执行/阻塞和结束时说明阶段与业务结果。脚本同时输出中文进度，不能用对话提示或截图代替业务断言。

## 验证证据

1. 全量 `npm test` 通过 178 项（含当前工作区的其他既有检查）；日志 `/tmp/workflow-visual-review-tests.log`。后续仅调整旧 delivery 的视图兼容与批准提示，并增加兼容回归，相关最终复跑 16 项全部通过，日志 `/tmp/workflow-visual-review-final-targeted.log`。
2. `node eval/acceptance/run-demo.mjs /tmp/workflow-visual-review-demo-20261116` 在临时 Git 项目和本地 HTTP 服务运行真实 Playwright。正常 9 个 Mock 场景及 1 个真实本地 HTTP 场景通过；恢复后的最终候选再次全部通过。
3. 9 个缺陷反例均被指定业务断言检出：缺重试入口、重试未绑定、隐藏错误、旧响应、并行请求、成功状态退化、业务错误误当成功、移除客户端超时、真实接口契约不符。没有用启动失败充当检出。
4. 正常 Mock 一轮保存 23 张实际页面图片；真实 HTTP 一轮 1 张；每个失败运行也保存了图片，全部 13 次运行保留。
5. 用 ego-browser 打开本地 file:// HTML，检查错误恢复用例三张图均为 1280×720、无页面横向溢出；失败用例图片能点击打开原图。复制后的 14 个 HTML 共 478 个本地链接检查无断链。
6. 四个修改的 Skill 均通过 skill-creator 的 quick_validate。未把语法通过等同于 Cursor 中的行为效果已实测。

## 本地演示

为防系统清理临时文件，报告和图片已复制到当前工作区 `.ai-dev/review-demos/2026-11-16-visual-acceptance/`。这些本地产物不随源码提交，以下链接仅在保留它们的工作区可用。这是已完成演示的静态副本，不是 enterprisewechat 的运行台账；复制后不会重新检测原临时项目。新检出仓库可按 `eval/acceptance/README.md` 准备浏览器依赖，再执行上述演示命令生成自己的报告。

- [验收总览](../../.ai-dev/review-demos/2026-11-16-visual-acceptance/artifacts/verification/index.html)
- [正常 Mock 报告](../../.ai-dev/review-demos/2026-11-16-visual-acceptance/revisions/verifications/ver-5c182f25-539c-41d3-906c-b80bd65eee5b/report.html)
- [缺重试入口的失败报告](../../.ai-dev/review-demos/2026-11-16-visual-acceptance/revisions/verifications/ver-8296fe48-8c02-4ec3-8d2d-e444bf860d7d/report.html)
- [报告截图](../../.ai-dev/review-demos/2026-11-16-visual-acceptance/report-preview.png)

图片证明当时页面可供复核，不证明用例覆盖完整或语义必然正确。此次未执行新的 enterprisewechat 业务验收，也未验证真实 Cursor 后续对话遵循效果。
