# Team constitution

## Scope discipline

- Implement only behavior owned by the current repository.
- Classify backend processing, database work, external systems, and other repositories as separate ownership.
- Do not invent product behavior to close document gaps.

## Evidence

- Preserve a source pointer for every material requirement.
- Distinguish written requirements, user confirmations, code evidence, and inference.
- Escalate conflicts and contract gaps before implementation.

## Changes

- Preserve existing and unrelated changes in the developer's real project.
- Make the smallest coherent change that satisfies approved requirements.
- Match current architecture and style unless an approved plan explicitly changes them.

## Verification

- Define acceptance evidence before implementation.
- Prefer executable checks over model self-assessment.
- Record commands, results, failures, and unverified items.

## Human authority

- Default `policy.mode` is `strict`: a human approves scope, spec, plan, and final.
- `scope` and `final` are **never** delegated to automated or independent-review auto-release.
- For a single feature, a human may explicitly authorize `delegated-review` for `spec` and/or `plan` only via `workflow-control.mjs delegate`, with a real `decisionRef`. Independent review pass is recorded under `status.reviews`, and must **not** forge `approvals.*.approvedBy`.
- The agent must not edit human approval records on behalf of a human.
- Commit, merge, push, deploy, and external writes require explicit authorization.
- Protocol validation is not a substitute for a real independent host context. Host dispatch follows `coordinator.md`; without fresh-context tools the run is `assisted`, not autonomous.
- `prepare-review` / `review-delivery` contract success is not a workflow gate and must be adapted before `record-review`.
