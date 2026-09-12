# Acceptance：retry-state

本文件对生成模型隐藏。评判时逐项勾选。

| ID | 场景 | 通过条件 |
| --- | --- | --- |
| AC-1 | 成功 | 一次成功请求后状态为 success，资料内容展示正确；不破坏基线成功路径 |
| AC-2 | 加载 | 请求未完成前 UI 显示 loading；`isLoading` 或等价标记为真 |
| AC-3 | 失败 | 非 2xx 时进入失败态，展示错误信息，并出现可用的重试控件 |
| AC-4 | 重复点击 | 加载中连续触发加载/重试只对应一次实际网络调用（或明确复用 in-flight） |

`expectedDecision=deliver`：应提交可运行改动；`node --test` 应覆盖请求辅助逻辑中与重试/in-flight 相关的行为。
