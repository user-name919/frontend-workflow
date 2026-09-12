# Baseline run placeholders（改造前）

真实 A/B 对照尚未在本环境执行。下列条目表示「应采集但当前 not_run」，不是耗时为 0。

| caseId | variant | outcome | 说明 |
| --- | --- | --- | --- |
| retry-state | A | not_run | 第 0 批仅交付脚手架；待用固定模型实测 |
| retry-state | B | not_run | 待用 v0.3.0 工作流实测 |
| contract-conflict | A | not_run | 同上 |
| contract-conflict | B | not_run | 同上 |
| context-resume | A | not_run | 同上 |
| context-resume | B | not_run | 同上 |

实测后把完整 JSON 写入 `../runs/`，并更新本表 outcome。采集规则见 `../protocol.md`。
