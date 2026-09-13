# Coordinator protocol

The Node scripts compute the next action and persist records. They do **not** call a model.

This host Agent is the **main agent**: it writes analysis/spec/plan and it changes code. A **reviewer sub-agent** checks whether the current task or stage met the confirmed goal. See `review-authority.md` for who may release, who returns to the main agent, and who goes to a human.

## Mode

- `autonomous-in-host`: the host can spawn a **fresh reviewer** context. In Cursor this is the Task / sub-agent tool. Use it for review, not for writing the implementation.
- `assisted`: only when a fresh reviewer context cannot be spawned. Export the packet. Renaming the current speaker is not independence.

## Loop (T1–T4)

1. `workflow-control.mjs <feature> next`
2. If the action is generate / implement / repair / collect evidence: **do it here**.
3. If the action is `request_review` or `dispatch_reviewer`: prepare the packet, **announce** that a review sub-agent is starting, then Task/spawn `sdd-reviewer` immediately. Do not wait for the user. Node does not spawn it; a Cursor stop hook may inject one follow-up if you stop first.
4. Persist. On task `pass`, the sub-agent has released that task; start the next one. Do not self-review.
5. Stop on `await_human`, `blocked`, or `complete`.

The reviewer never edits business code and never dispatches the next implementer.

## Action map

| next type | Who | Persist with |
| --- | --- | --- |
| generate_analysis / generate_spec / generate_plan | Main agent | `workflow-control transition` |
| request_review | Main agent runs **prepare-review**, then dispatches the reviewer | Sealed packet path |
| dispatch_implementer / repair | Main agent + `implementer.md` + `prepare-task.mjs` | `record-task-result start` then `accept` |
| dispatch_reviewer | Fresh sub-agent + **review-delivery** + `review-authority.md` | `record-review adapt`, then `decide`, then `accept` if the workflow report validates |
| verify | Main agent via `run-verification.mjs` | Records, then `verification.md` |
| await_human / blocked / complete | Stop | Human `approve` / `resume` / done |

After `decide`:

| `escalateTo` | Main agent does |
| --- | --- |
| `none` / `review.passed` | Show `summary.md`. Accept. Run `next`. |
| `main` / `review.returned` | Show why it failed. Fix or gather evidence. Do not ask the user. Re-review. |
| `human` / `review.needs_human` | **Tell the user** the reason. Do not invent the product rule. |

## What still needs a human

- `scope` and `final` always need a human `approve`.
- `spec` and `plan` need a human `approve` unless this feature was explicitly `delegate`d.
- Do not forge `approvals.*.approvedBy`.
- Do not commit, push, open a PR, merge, or deploy unless the user asks.

## Review adapter (required)

```bash
node .ai-dev/scripts/record-review.mjs <feature> adapt --request request.json --packet sealed-packet.json --report delivery-report.json
node .ai-dev/scripts/record-review.mjs <feature> decide --request request.json --report workflow-report.json
```

- Contract `ok` is not gate authorization.
- `adapt` never sets `approvals.*.approvedBy`.
- `self_check` cannot be stored as an independent pass.

## Recovery

If a task is `running` with no accepted result, `inspect`, confirm the main agent's edit has stopped, then `recover` with `confirmWorkerStopped: true`.
