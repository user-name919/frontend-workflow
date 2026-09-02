---
name: prd-to-code
description: Convert frontend PRDs, interface documents, and repository evidence into a review-gated implementation workflow. Use when Codex must analyze a product requirement against an existing Vue or React repository, separate frontend work from backend or cross-repository work, generate evidence-backed scope/spec/plan/tasks, pause for human approval, implement approved tasks, and verify the result without automatically committing, merging, or deploying.
---

# PRD to Code

Find the repository root, then read `.ai-dev/workflow.md` and `.ai-dev/constitution.md` completely before acting.

## Operate by state

1. Locate the active change under `.ai-dev/changes/` or initialize one with `.ai-dev/scripts/init-change.mjs` when the user asks.
2. Read `status.json`; perform only work allowed by its current state.
3. Build every claim from source documents or repository evidence. Use the evidence labels defined by the workflow.
4. Separate frontend behavior, backend ownership, interface contracts, cross-repository work, and verification requirements.
5. Stop at each review gate. Never approve a gate on behalf of a human.
6. After plan approval, create or reuse the isolated Worktree with `node .ai-dev/scripts/init-worktree.mjs <change-dir>`.
7. Inspect and modify business code only through `<change-dir>/project`. Infer framework, versions, package manager, commands, and conventions from that repository's own evidence.
8. Implement only approved tasks. Keep changes surgical and preserve existing Worktree changes.
9. Run repository-provided verification commands and record exact commands and results in `verification.md`.
10. Record the branch, base commit, changed files, Diff summary, and review notes in `code-change.md`.
11. Never commit, merge, push, open a PR, deploy, or modify external systems unless the user explicitly requests that separate action.

## Keep artifacts consistent

- Before editing an existing workflow artifact, run `node .ai-dev/scripts/update-consistency.mjs <change-dir> mark <artifact>`.
- Read `status.json.consistency.staleArtifacts`, update every affected downstream artifact that is relevant to the current work, then run `node .ai-dev/scripts/update-consistency.mjs <change-dir> resolve <artifact...>` for the artifacts actually refreshed.
- Keep `status.json.state` at the current execution phase while refreshing artifacts. Do not move the state backward merely to synchronize context.
- A changed approved artifact invalidates its affected approval. Ask for a new human review at the current state after the stale artifacts are refreshed.
- Do not pass a review gate while `staleArtifacts` is non-empty.

## Input handling

- Prefer Markdown source documents.
- For Word or PDF inputs, extract them with the available document/PDF capability and preserve headings, tables, image references, and source locations.
- Detect and redact credentials or access tokens before copying source text into change artifacts.
- Treat screenshots and prototypes as supporting evidence, not as permission to invent unspecified behavior.

## Failure behavior

- Mark a requirement `NOT_LOCATED` when no corresponding code exists in the current repository.
- Mark an ownership mismatch `OUT_OF_SCOPE`; do not generate placeholder code.
- Mark incompatible or incomplete interface definitions `CONTRACT_GAP`.
- Put unresolved behavior in `open-questions.md` and stop at the current gate.
- Do not turn an inference into a requirement merely because it seems reasonable.

Run `node .ai-dev/scripts/validate-change.mjs <change-dir>` before presenting any gate for approval.
