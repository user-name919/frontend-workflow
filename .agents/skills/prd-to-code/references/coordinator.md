# Coordinator protocol

The Node scripts compute the next action and persist records. They do **not** call a model. The host Agent (Cursor / Codex / another session) performs generate, implement, and review work.

## Mode

Record the actual mode in every handoff:

- `autonomous-in-host`: the host can spawn a **fresh** implementer/reviewer context (`capabilities.freshContextDispatch=true`).
- `assisted`: export the brief/packet for another session. Changing the current speaker name is not independence.

If the host cannot isolate context, stay `assisted`. Do not claim Node scheduled a model.

## Loop

1. `workflow-control.mjs <feature> next`
2. Do only that action.
3. Persist the result (`record-task-result`, `record-review`, `run-verification`, or `transition`).
4. Call `next` again.
5. Stop on `await_human`, `blocked`, or `complete`.

The implementer never dispatches a reviewer.

## Action map

| next type | Host does | Persist with |
| --- | --- | --- |
| generate_analysis / generate_spec / generate_plan | Write artifacts, then **explicit** `transition` | `workflow-control transition` |
| request_review | Run **prepare-review** on confirmed sources; `seal` / `check` | Store sealed packet path in the handoff. Do not invent requirements from code. |
| dispatch_implementer / repair | Fresh context + `implementer.md` + `prepare-task.mjs` | `record-task-result start` then `accept` |
| dispatch_reviewer | Fresh context + **review-delivery** on the sealed packet | `review-contract report`, then `record-review adapt`, then `record-review accept` only if the **workflow** report validates |
| verify | `run-verification.mjs` using `delivery.verify` | Records first, then `verification.md`, then a new final snapshot |
| await_human / blocked / complete | Stop | Human `approve` / `resume` / done |

## Review adapter (required)

`prepare-review` / `review-delivery` use an independent v1 contract. Their JSON **cannot** be passed to `record-review.mjs` as-is.

```bash
node .ai-dev/scripts/record-review.mjs <feature> adapt --request request.json --packet sealed-packet.json --report delivery-report.json
```

- Contract `ok` is not gate authorization.
- `adapt` never sets `approvals.*.approvedBy`.
- `scope` / `final` still need a human `approve`.
- `needs_evidence` → go back to prepare-review; do not treat as pass.
- `self_check` cannot be stored as an independent pass.

## Recovery

Crashed CLI may leave `.ai-dev/runtime/active-implementation.json`. Inspect, confirm the worker is stopped, then `workflow-control recover` with `confirmWorkerStopped: true`. Do not start a second implementer on a timeout.
