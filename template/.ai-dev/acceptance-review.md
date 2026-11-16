# 验收截图与可读报告

## 在哪里看

每个需求有固定入口，可直接在本地浏览器打开：

```text
.ai-dev/features/<需求ID>/
  artifacts/verification/index.html                 # 总览：当前结果、未测项、所有运行入口
  revisions/verifications/<runId>/
    report.html                                    # 这一轮的步骤、预期、观察与截图
    screenshots/<caseId>/<expectationId>-*.png       # 当时的实际页面，成功与失败均保留
    record.json / raw-report.json / stdout.log / stderr.log
```

总览在每次验证结束及 `workflow-control refresh-acceptance` 时自动刷新。任务运行列在历史表中，不能充当最终候选整单通过。总览是生成时的视图，打开 HTML 不会重新探测源码；代码变化后需刷新或重跑。每轮报告、截图和原始输出属于当前 run，并由记录指纹保护；重跑创建新目录，不覆盖上一次失败。

## 报告怎样写得让人读懂

中文项目的用例和检查填写中文 `title`，例如“请求失败后重试，展示新资料”。报告默认显示业务标题、环境、前提、预期、实际观察与截图；用例编号、脚本路径、原始错误、日志和候选快照保留在折叠的“技术详情”中。失败和缺证据仍在主视图明确标出。

脚本生成的 `observation` 要用中文说明实际读到的值。例如：“个人资料接口请求 2 次。页面状态：加载成功；展示资料：Grace（版本 2）；错误提示：无错误提示。”这些数值与状态必须来自本轮页面和请求观察，不能硬编码、复述预期或只写“断言通过”。失败时照样记录实际值，未能读取就明确写出。页面确实展示的英文错误或数据保留原文。

通用报告不会自动翻译任意英文日志，也不会据测试名称编造中文结论。旧脚本的英文观察需要修改采集描述后重跑；已封存的报告和原始记录保持原样。

## 项目测试怎样保存截图

新执行器给浏览器运行记录标记 `visualEvidenceVersion:1`。对于每条声称通过的 `ui/navigation` 预期，`expectationResults[]` 必须带 `screenshotRefs`，值为当前运行目录下的 PNG 相对路径，且属于 `screenshots/<caseId>/`。同一画面可以对应同一用例的多个预期；不同页面、筛选前后、空/有数据、错误/恢复状态分别捕获。不要等到整组跑完再给所有预期关联最后一张图。

截图缺失、跨运行引用、越界路径、非 PNG 或图片后续被改写均不能支持新的通过记录。截图的存在、格式和指纹不证明业务含义，Reviewer 仍须检查断言和画面内容。网络参数、请求次数和复制内容依靠相应断言，不能用截图替代。失败时尽量保留出错现场；页面无法启动或登录阻塞时照实记录，不要求伪造截图。历史记录保持原样，无截图的旧报告仍按旧契约读取，总览明确标注，不追认截图或重新打开 COMPLETE。

通用帮助函数兼容 Playwright 和 ego-browser 的绝对路径截图 API：

```js
import { captureAcceptanceScreenshot } from './.ai-dev/scripts/lib/visual-evidence.mjs'

// 路径请按测试模块所在位置调整。必须是真实操作到达预期状态之后。
const shot = await captureAcceptanceScreenshot(page, {
  caseId: 'TC-DETAIL', expectationId: 'E-PAGE2', label: 'page2',
  outputDir: runOutputDir,
})
// screenshotRefs 保存到该 expectation 的实际观察中。
expectationResults.push({
  id: 'E-PAGE2', result: actualFirstRow === expectedFirstRow ? 'passed' : 'failed',
  observation: `第 2 页首行=${actualFirstRow}`, screenshotRefs: [shot],
})
```

Playwright 把这些逐项观察放入现有 `acceptance-context` attachment；在每个关键断言的 `try/finally` 中截图，保证失败现场也有证据。可以继续保留 Playwright 的 trace。仅配置 `screenshot: 'only-on-failure'` 不满足成功状态的目视复核。

ego-browser 的脚本进程不继承命令环境变量。外层 wrapper 从 `WORKFLOW_VERIFICATION_DIR` 获取当前目录，再作为明确参数传给浏览器脚本。`browserCase.equal` 第五个参数可传 `{screenshotRefs:[shot]}`，并把 record 输出到真实 browser-json 报告。不要在浏览器脚本里猜 runId 或使用上次运行路径。

截图之前使用测试数据，必要时用宿主支持的遮罩/区域截图屏蔽无关个人信息；不要遮住待验证结果。不要保存二维码、token 或敏感登录页面。图片不做自动脱敏保证，文字 URL 脱敏不能保护图片内容。

## 对话中必须看得见的节点

主 Agent 负责把真实运行信息转成用户能理解的消息，不能只贴工具 JSON、哈希、runId 或审核 pass：

1. **计划就绪**：用业务名称说明哪些在任务完成后测，哪些依赖完整流程、放到 VERIFYING 测。若当前任务只有 lint/静态检查，明确它尚未进行页面验收，以及页面测试的计划触发点。
2. **开始执行**：说明阶段、实际环境、测试方式、主要业务场景和数量，以及接下来会操作什么。Mock 必须注明接口替换；只启动页面、扫码登录仍属准备。
3. **执行中**：每组结束给出真实结果；较长执行按宿主沟通约定报告进展，不造百分比。失败/阻塞说明具体场景、已观察到什么、下一步是自动修复还是需要登录/数据。保留失败记录。
4. **执行结束**：分别统计浏览器用例、工程检查、人工项；给出“业务场景 / 结果 / 实际观察”简表，列出失败、未测、过期和限制，链接总览及本次报告。自动可修复的继续修复，不向用户索要笼统的“手工通过”。
5. **最终审核**：先讲验收覆盖与缺口，再讲 Reviewer 结论及是否需要最终批准。必测项缺证据不能写成 minor 可选；报告/图片通过不等于批准。RAG/摘要等会影响候选快照的修改须在最终测试前完成，批准后不再为了改阶段文案修改它们。

示例表达（数量必须用真实结果替换）：

> 开发已完成，开始整单自动验收。使用本地预发配置，其中新接口按确认契约 Mock；这轮检查规则上限、详情筛选和分页，不代表真实后端联调通过。
>
> 详情筛选已测：选择“发送失败”后只显示匹配记录。分页当前被测试数据不足阻塞，尚未通过。截图与逐项结果见本地验收报告。

## 独立审核材料

将当前 run 的 record、raw report、report.html 和该用例关联的 PNG 纳入包内 verification 材料。总览会刷新，只作为导航，不替代封存的运行材料。Reviewer 对照原文、测试操作、逐项观察和截图；只能说“已检查”的部分，不能把未查看的图片算作目视审核。
