# Host adaptation

Node never schedules a model. The main agent writes and implements. The host only needs a fresh context for the **reviewer**.

## Cursor

`template/.ai-dev/host-capabilities.json` ships `freshContextDispatch=supported`.

When `next` says `dispatch_reviewer` or after `request_review` has a sealed packet, call the Cursor **Task** tool with `subagent_type: sdd-reviewer` (file: `.cursor/agents/sdd-reviewer.md`). Exact prompt shape is in `dispatch-reviewer.md`. Do not paste implementer debug chat.

Do not send generate/implement work to a sub-agent unless the user asks. Do not review your own packet in this context and call it independent.

## Codex

Same workflow scripts and skills. Not the Cursor Task tool.

- If this Codex build can spawn custom agents, use `.codex/agents/sdd-reviewer.toml` (see `dispatch-reviewer.md`).
- If spawn cannot select a custom agent, open a **new** Codex session with `$review-delivery` and the sealed packet. That is independent. Renaming the current speaker is not.
- Do not set `freshContextDispatch=supported` unless this session actually spawned a fresh reviewer or handed off to a new session.

## Other hosts

If the host cannot spawn a fresh reviewer and nobody will open a new session, set `features.freshContextDispatch` to `unsupported`. Export the packet. That is a fallback, not the goal.
