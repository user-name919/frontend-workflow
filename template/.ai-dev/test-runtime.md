# 项目运行上下文

项目在正常测试目录维护运行配置，例如 `tests/acceptance/runtime.json`；环境通过 `runtime: {file, profile}` 引用它。主应用不是预设项目类型：普通项目只有自己的服务，多应用项目声明额外服务。配置和准备脚本纳入测试任务、verification inputs 与快照。工作流不会安装项目无关的框架，也不会把缺框架直接改成人工验收。

## 配置和入口

从启动脚本、路由、登录守卫、已有测试及用户确认建立配置；模板见 `templates/test-runtime.json`。`profiles.<id>` 含：

- `services[]`：id、description、readyURL；可附 command/args/cwd 与顺序，供项目准备脚本/宿主执行。已有进程必须核对来源和环境，不按 HTTP 200 或空闲端口猜测，不杀无关服务。
- `prerequisites[]`：id、description，例如登录角色、必要模块权限。不要把正在测试的错误状态作为通用前提。
- `entries`：命名入口，url 模板支持 `{baseURL}` 和 path/query/hash 输入，requiredInputs 标出正常进入所需字段。跳转/点击才能进入的项目由准备脚本实现，并记录实际入口。
- `inputs[]`：本项目准备脚本和环境配置的相对路径。凭据保存在项目已有安全会话/运行时环境中，不写进配置或版本库。

用例增加 `entry: {id, bindings}`。bindings 示例：`{"taskId":{"source":"task.id"},"classId":{"source":"task.classId"}}`。测试脚本从已确认 fixture、只读接口或授权测试数据准备结果提供 `{task:{id,classId}}`；`resolveTestEntry` 编码并填入 URL。缺失数据保持阻塞，不能编造 ID。ID 存在不够，还需验证账号访问权、所属环境/业务对象及用例需要的状态。

缺参反例在 entry 显式声明 `omitInputs` 和有来源的 `omissionReason`。通用前检允许该项故意缺失，由业务断言验证兜底。无权限、空数据等受测行为同理，不由公共准备逻辑先跳过。

## 执行与观察

`loadTestRuntime` 读取并校验配置，`prepareTestEntry` 依次调用项目适配器的 `services`、`prerequisites`、`data` 和 `candidate`。适配器负责实际启动/探测、登录、取数和当前候选确认；不是填一组预设 met。出现未满足的前提时返回 blocked，不继续业务测试。扫码交给用户完成后，在同一会话重验登录前提并继续。

每个 browser case 的 acceptance-context 增加 runtime：profileId、configDigest、entryId、脱敏 entryURL、bindings（value/source）、services/prerequisites 的逐项 result=met 与 observation，以及 candidateObservation。工作流重新比对配置摘要、入口来源、实际参数和所有前提。配置变化会使旧运行失效。观察记录不是防伪认证，独立审核还要检查准备脚本和测试是否实际探测了这些事实。

基础环境就绪不等于业务用例通过。所有报告增加：

- preconditionResults：逐条 `{index,result:"met"|"unmet",observation}`，index 对应用例 preconditions。
- expectationResults：逐条 `{id,result:"passed"|"failed",observation}`，id 对应 expectations。

完整通过要求所有前提与预期完成。有数据、空态、错误、恢复和边界分成可独立判定的场景。缺数据只阻塞受影响用例；不得用静态代码中的常量或空态截图代替有数据断言。

## 可重复浏览器脚本

沿用完整 Playwright JSON。它的 acceptance-context 同样需要逐项观察。对于使用 ego-browser 的宿主，可用 check.report=`browser-json`，仍设 case.method=`browser`，由已声明的项目测试入口运行真实浏览器脚本。不能生成伪造 Playwright 报告，也不能登记为人工确认。

执行器提供 `WORKFLOW_RUN_ID`、`WORKFLOW_ENVIRONMENT_ID`、`WORKFLOW_FEATURE_DIR`、`WORKFLOW_INPUT_SNAPSHOT`、`WORKFLOW_VERIFICATION_DIR` 和 `WORKFLOW_JSON_OUTPUT_FILE`。ego-browser 不继承脚本环境，项目包装器需将所需非敏感参数明确传给本轮脚本。沿用同一 TaskSpace；脚本仅使用该宿主文档支持的 API。

browser-json 格式：`{schemaVersion:1,engine:"ego-browser",runId,cases,errors:[]}`。每条 case 含 caseId/file/testId/attempts=1/result、context、preconditionResults、expectationResults、attachments（运行输出目录内相对路径）。context 保留 environmentId/baseURL/mockedRoutes/mockHits，并按上述约定附 runtime。可使用 `lib/browser-case.mjs` 的真实断言记录器；断言输入必须来自 UI/请求观察，不能从业务源码推导期望或直接调用页面 handler 代替用户操作。

`blocked` 必须有实际未满足前提，不能带失败断言，不计入缺陷自动修复次数，也不算通过。同轮存在 failed/flaky 时按失败处理，不能用另一条 blocked 抹掉缺陷。Playwright 只有单次、无执行错误的 skip，且 acceptance-context 明确 `result:"blocked"` 并记录 unmet 前提时才算准备阻塞；普通 skip 仍不能通过。旧记录缺少逐项观察时保持未验证，保留历史并重跑。受控响应与真实联调使用不同环境和用例，live 不替换响应。

## 人工与静态证据

manual 用例必须声明 manualReason `{category:"human-judgment"|"physical-device"|"external-action",reason,sourceRefs}`。只有对应断言确需人工时适用。没有 Playwright、账号暂缺或启动失败不是理由。

人工通过请求除逐项观察和 confirmationRef，还需 confirmation `{kind:"acceptance",actor,sourceRef,quote,caseId,expectationIds}`，其中 sourceRef 与 confirmationRef 相同，quote 是实际验收决定。登录、扫码、允许测试不是验收决定。无法核查确认来源时不能通过。静态 inspection 仅允许 document 类型预期，并为每项提供 evidenceRefs；网络和 UI 必须运行验证。

task/final 的独立审核对 manual/inspection 通过项增加 caseEvidenceMaterialId，引用对应不可变观察记录；manual 的 confirmationRef 必须与该记录实际验收确认相同。必测预期缺证据必须补测，不得降为 minor 后整体通过。允许人工项 pending 时接收阶段审核，不改变最终 approve/COMPLETE 必须全部就绪的规则。

## 配置修复与审批

将启动、登录、参数解析及检查命令放在计划已声明的测试配置/脚本，delivery 使用稳定的脚本入口。在既有授权范围内修复这些脚本后，重跑受影响测试并重新审核证据；业务规格未变，无需仅为端口或参数读取方式改写 delivery。若缩小检查范围、改预期/方法/接口契约，则按原一致性规则修订并审查，不能宣称等价修复绕过批准。
