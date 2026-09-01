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

- Preserve existing and unrelated worktree changes.
- Make the smallest coherent change that satisfies approved requirements.
- Match current architecture and style unless an approved plan explicitly changes them.

## Verification

- Define acceptance evidence before implementation.
- Prefer executable checks over model self-assessment.
- Record commands, results, failures, and unverified items.

## Human authority

- A human approves scope, implementation plan, and final diff.
- The agent must not edit approval records on behalf of a human.
- Commit, merge, push, deploy, and external writes require explicit authorization.
