# 怎么唤起审核子 Agent

人不用先打 `/reviewer`。主路径是：**任务一进入 `review_pending`，主 Agent 立刻派子 Agent**；若它停下来没派，Cursor `stop` hook 自动补一句。

Node **不能**自己点 Task / spawn。那是 Cursor / Codex 聊天运行时的工具，绑在当前会话上。`workflow-control` 只是 Node 进程，没有这套工具。Node 去跑 `cursor agent` CLI 会另开会话，当前聊天里**不会**出子 Agent 卡片。所以：Node 算「该审了」+ 写 hook 跟一句；**真卡片**仍要主 Agent 调 Task/spawn。

## Cursor

1. 主 Agent 做完 T1 并 `accept` → 状态 `review_pending`。
2. 主 Agent **马上**对用户说「正在启动 review 子 Agent」，再 Task `sdd-reviewer`（`.cursor/agents/sdd-reviewer.md`）。
3. 若第 2 步没发生就 `stop`：`.cursor/hooks/request-review.mjs` 注入 follow-up，每个 `feature:task:attempt` 只一次。
4. 子 Agent 启动/结束：`user_message` / 再跟一句，让主 Agent 落盘并展示 `summary.md`。
5. `review.passed` → 主 Agent `next`。`review.needs_human` → 把原因告诉用户。

```text
subagent_type: sdd-reviewer
prompt:
  项目根目录 / 需求目录 / 任务 id / sealed packet
  产出：审核了哪些、通过/未通过/无法确定及原因
  不要改业务代码，不要等人发 /reviewer
```

没有 `sdd-reviewer` 类型时用 `generalPurpose`，prompt 仍走 `review-delivery`。

## Codex

同一套账本。用 `.codex/agents/sdd-reviewer.toml` spawn（`fork_context=false`）。  
不能 spawn 就**停下来告诉用户**，不要在本线程自审。新开 `$review-delivery` 会话也算独立审，但当前 IDE 会话不一定有子线程面板。

## 不要

- 等人打 `/reviewer` 才审
- 本对话改称 reviewer
- 等 Node 自己弹出卡片
