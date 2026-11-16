# 运行上下文与自动验收改造记录

本次改造针对 enterprisewechat 实测暴露的验收问题：无测试框架就转人工、只看空态或源码却登记完整通过、登录当验收确认、端口/启动命令调整导致反复改审批材料。

## 工作流变化

- 计划阶段生成项目自己的 `tests/acceptance/runtime.json`，声明可选服务、登录及数据前提、页面入口。主应用只在项目确有依赖时声明。
- URL 参数绑定到有来源的数据对象，脚本自动读取和编码；支持 path/query/hash、参数别名及故意缺参用例。不会要求人逐个手配 ID，也不会自行猜值。
- 可执行 UI/网络行为进入 browser 用例。缺框架时可以使用宿主已有的 Ego 浏览器，但必须保存可重复脚本及逐项断言；不伪造 Playwright 报告。
- 用例通过必须满足每条前提、每个预期和声明的 mock 命中；配置、源文件或测试输入变化使旧证据失效。静态 inspection 不再证明 UI/网络行为。
- 登录只解除登录前提。人工项必须说明理由，并记录明确的实际验收决定和覆盖的预期。
- 准备阻塞不算通过、不消耗缺陷修复次数；同轮真实失败优先。稳定的项目测试包装器承接端口/命令适配，修改业务预期/范围时仍按原流程审查。

## 真实项目验证

项目：`/Users/tal/Desktop/enterprisewechat`，需求 `KAODIAN-GROUP-SEND-0921`。主应用实际位于 `/Users/tal/Desktop/xiaolv`；8082 主应用配合7777子应用，使用本地预发与用户完成扫码的代理老师会话。

受控场景覆盖：双 Tab、有数据默认筛选与树展开、8条上限、999/1000/1001字输入、光标变量插入、规则错误、模板回显、type4/5请求与学员任务关联、实际埋点网络请求、列表类型筛选、详情九列/破折号/悬浮/真实复制、筛选重置/10-20-40分页、业务异常及新数据恢复。所有群发请求在 HTTP 边界被替换，没有向真实家长发送测试消息。

独立复核又补齐了四处容易误判的环节：导航前检查服务、真实联调检查批改完成任务和学员、复制前写入本轮哨兵、第2页切换条数后检查第1页及实际新行。最终执行状态以项目 `artifacts/verification/acceptance-results.json` 和 `revisions/verifications/` 为准。

最终记录：

| 检查 | 结果 | 运行 ID |
| --- | --- | --- |
| CHK-LINT | 9文件，新增问题0，保留14条历史基线 | ver-11cef099-27a0-4237-bc79-d2ca0ddf2894 |
| CHK-BROWSER-CONTRACT | 11例通过，56项实际断言 | ver-064978c3-207b-440f-bead-0d873c99c852 |
| CHK-BROWSER-LIVE | blocked，未消耗修复次数 | ver-60c64745-6ed4-48d5-815b-1f839d4158e8 |
| TC-M-UI | pending，无人工验收决定 | 无 |

最终汇总重新核对了原始报告、指纹与当前源码，11例仍为 passed；真实阻塞保留 blocked。变更清单含19个实际项目文件、未声明变更0；工作流派生材料 stale 项为0。规格/计划变更按原机制使旧审批失效；没有伪造新审批或推进业务最终完成。

真实预发已观测到 `get_latest_msg_template` 返回404、`tch_class` 开课中数据为0。该用例应保持 blocked。主观视觉仍待用户确认，最终批准未记录。

静态检查覆盖9个相关 JS/Vue 文件；14条旧问题已与改造前 HEAD 按文件、规则、文案、源码行及数量逐项比对。固定基线只豁免这些旧问题，新增问题仍失败。不能将“新增0”写成“全仓无 lint 问题”。

## 怎么验证它确实在验收需求

1. 最终全量工作流回归164项通过。反例覆盖空数据、漏断言、静态冒充运行、登录冒充确认、过期输入、重试/skip、混合 blocked/failed、审核记录缺项、URL别名缺参和敏感值碰撞。
2. 独立生成试跑使用一个无主应用、订单详情需 path 和 hash 参数的项目：输出5条 browser 场景及1条主观人工项；缺部署、定位及权限信息保持待确认，未声称运行过。
3. 隔离复制 enterprisewechat 测试脚本，仅把合约返回的最新科目改成错误值，保留原断言。真实页面渲染后，TC-B01 的 defaults 断言失败。该反例没有写入业务 feature，也未改业务源码。
4. 独立审查读取来源、测试和原始报告；发现漏验后补测，不能只凭报告写了 passed 就认可语义覆盖。

结构校验和报告指纹不能证明 Agent 永远诚实，也不能替代业务依据。这里提供的是可复核的来源、实际断言和反例证据，后端规则/真实触达及人工视觉仍有明确边界。

## 主要落点

- 通用执行与门禁：`template/.ai-dev/scripts/lib/{test-runtime,case-evidence,browser-case,acceptance-plan,acceptance,verification,verification-report,reviews}.mjs`。
- 收尾修复：`record-code-changes.mjs` 使用 NUL 分隔读取 Git 路径，避免中文摘要误报，同时检查重命名旧路径的删除；blocked 汇总也重新校验新鲜度和原始证据。
- 项目接入说明：`template/.ai-dev/test-runtime.md`，模板 `template/.ai-dev/templates/test-runtime.json`。
- Skills：acceptance-testing、prd-to-code、prepare-review、review-delivery；独立审核的 review-contract 同步逐项检查。
- 试点：enterprisewechat `tests/acceptance/`、对应 delivery/派生方案和 `.rag-context/考点地图任务支持群发-0921.md`。

本轮保留既有业务改动、历史证据与无关工作区改动；没有记录人工最终批准。
