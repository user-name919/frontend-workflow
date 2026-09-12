# Review Contract v1

Node >=18。以下 JSON 是最小静态审核示例，路径和观察必须替换为真实材料；不可直接作为成功证明。

## packet.json

```json
{
  "schemaVersion": 1,
  "reviewId": "R-1",
  "stage": "task",
  "implementerId": "actual-implementation-run",
  "materials": [
    {"id":"M1","path":"docs/prd.md","role":"requirement"},
    {"id":"M2","path":"src/next-answer.js","role":"implementation"}
  ],
  "requirements": [
    {"id":"FR-1","text":"按列表顺序返回第一个未占用答卷；空列表或全部占用返回 null","status":"confirmed","basis":["M1"]}
  ],
  "checks": [
    {"id":"C1","kind":"acceptance","requirementIds":["FR-1"],"basis":["M1"],"scenario":"连续占用、全部占用、空列表与正常列表","expected":"分别返回首个可用答卷或 null","method":"inspection"}
  ],
  "questions": []
}
```

字段约束：

- stage：scope / spec / plan / task / final。
- materials.role：requirement / decision / contract / project-rule / implementation / verification。路径相对显式项目根目录，必须真实文件且不可逃出根目录；外部文档先保存授权可读的本地摘录并记录来源、时间与范围。不得复制无关敏感资料。
- requirements.status：confirmed / unconfirmed / excluded。confirmed 需要业务依据和至少一个 acceptance；unconfirmed 必须有阻塞 decision 问题关联；excluded 必须有 reason。不把未确认的新增范围变为既有需求。
- checks.kind：acceptance / engineering；method：inspection / test / manual。每项有 basis；acceptance 关联确认需求，engineering 可不关联需求但仍需项目规则等依据。
- questions：`{"id":"Q1","kind":"evidence","blocking":true,"text":"缺少本次测试输出","requirementIds":["FR-1"],"attempted":["已检查现有日志，版本不符"]}`。kind 也可为 decision。不可把尚未尝试的调查写成 attempted。
- ID 在各集合内唯一，引用必须存在。业务假设不能仅以 implementation 作为来源。

seal 返回原包加 snapshot（root、各材料 sha256、整体 digest）；保存为新文件后 check。包内容、文件字节或根目录变化都需要重新 seal。不要手工重排/改写已封装 JSON 的属性；序列化顺序参与摘要。

## report.json

```json
{
  "schemaVersion":1,
  "reviewId":"R-1",
  "snapshotDigest":"从真实 sealed packet 复制",
  "reviewerId":"actual-fresh-review-run",
  "independence":"independent",
  "verdict":"pass",
  "summary":"静态核查范围内满足确认行为；未执行运行时测试",
  "checks":[
    {"checkId":"C1","result":"pass","evidence":[{"materialId":"M2","location":"函数 nextAnswer，第 1–3 行","observation":"按顺序 find 并以 null 兜底；此处仅为示例，须替换为实际观察"}]}
  ],
  "findings":[]
}
```

- 每个 check 恰好出现一次，result 为 pass / fail / unknown。pass/fail 必须有 evidence；unknown 必须有 reason，不能靠无证据猜测给 pass。
- test 型 pass 增加 `execution:{"command":"实际命令","exitCode":0,"outputMaterialId":"M3"}`；M3 必须是包内 verification 文件，包含真实执行输出。审核后新跑测试需登记输出并重新制包。非零退出不能声明该测试通过。
- manual 型 pass 增加 confirmationRef 指向实际确认记录，不得生成虚构批准。
- fail 必须关联 finding：`{"id":"F1","checkId":"C1","severity":"major","message":"连续占用时仍返回已占用项","action":"repair","evidence":[{"materialId":"M2","location":"具体行号","observation":"实际控制流及可复现输入输出"}]}`。
- severity：blocking / major / minor；action：repair / collect_evidence / ask_human。
- verdict：阻塞业务问题或 ask_human → needs_human；否则阻塞证据、unknown 或 collect_evidence → needs_evidence；否则 fail 或 blocking/major → revise；否则 pass。非阻塞的范围外问题不阻止通过。
- self_check 可用于描述自检，但校验器会拒绝作为独立审核报告，不能用于独立准入。

## 能保证与不能保证

校验器检查字段、引用、覆盖关系、材料摘要、报告完整性和结论一致性；它不证明材料真实、需求抽取完整、测试有效、人工确认身份或模型独立性。摘要不是签名，文件没有被冻结，只有变化检测。只覆盖显式列入的文件，不是整个仓库快照；Reviewer 必须独立核实实际改动范围。两次检查之间仍可能变化，最终消费报告前应再次校验。

本版不接管既有状态机，也不把 JSON 合格等同于业务批准。共享脚本随 prepare-review 分发；不要仅安装 review-delivery。
