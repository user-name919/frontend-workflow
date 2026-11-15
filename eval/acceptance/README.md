# 真实浏览器验收与缺陷反例

本目录验证工作流能否把需求场景映射到实际 UI 操作、逐项结果及准入判断。原 `eval/fixtures/retry-state` 与 A/B 基线保持不变；这里是独立的正确实现和测试载体。额外业务错误/超时规则见 `retry-state/requirements.md`，仅为演示定义，不是实际业务后端的确认。

## 复跑

本演示锁定 @playwright/test 1.65.1，要求 Node >=20；工作流核心仍为 Node >=18，真实项目应单独选择兼容的测试运行时。

```sh
cd eval/acceptance/retry-state
npm ci
npx playwright install chromium
cd ../../..
node eval/acceptance/run-demo.mjs /tmp/acceptance-demo-results
```

脚本复制演示到临时 Git 项目，复用已安装依赖，创建仅用于演示的 VERIFYING 工作区。它不代替审批，不创建实际用户确认，不向后端写数据。报告输出位置由参数指定，运行目录和 featureDir 写入 summary.json，可保留用于复核。

先执行 9 个受控响应场景（该模式下实际 API 服务为 503，模拟不依赖后端就绪），证明 mandatory live 尚未执行时不能整单通过；再启动独立临时 HTTP 服务做无响应替换的联调。它验证联调机制，不代表实际测试环境后端已验证。

随后逐个引入：无重试入口、按钮未绑定、无错误提示、显示旧响应、并行请求、成功路径回归、业务错误误作成功、客户端不超时、真实服务契约不符。每个变体都要求指定 TC 的指定业务断言失败；编译/启动失败和其他无关失败不能算检出。最后恢复正确副本并重新通过两套检查。

测试文件使用完整 JSON reporter；失败保留 trace 和 screenshot。summary.json 记录实际状态、runId、目标断言与原始 record 路径。查看 trace 可使用该演示安装的 Playwright trace viewer。

工作流的 node --test 用例验证协议、门禁、迁移和异常恢复；其中 synthetic reporter 只验证报告读取，不冒充浏览器行为证据。真实业务试点仍需要目标仓库、确认需求、契约、账号与可重置数据。

报告格式与服务启动配置遵循 [Playwright JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter) 和 [webServer 配置](https://playwright.dev/docs/test-webserver)。
