---
name: prd-to-code
description: Convert frontend PRDs, interface documents, and repository evidence into a review-gated implementation workflow. Use when Codex must analyze a product requirement against an existing frontend repository, separate frontend work from backend or cross-repository work, generate evidence-backed scope/spec/plan/tasks, pause for human approval, implement approved tasks in the developer's real project, and record linked changed files, a durable patch, and verification without automatically committing, merging, or deploying.
---

# PRD to Code

Find the repository root, then read `.ai-dev/workflow.md` and `.ai-dev/constitution.md` completely before acting.

## Operate by state

1. Locate the active feature under `.ai-dev/features/` or initialize one with `node .ai-dev/scripts/init-change.mjs --title <name> [--id <requirement-id>] [--id-source document|user]`.
2. Read `status.json`; perform only work allowed by its current state. If `schemaVersion` is missing or `1`, run `node .ai-dev/scripts/workflow-control.mjs <feature-dir> inspect` then `migrate` before other writes. Do not invent approvals during migration.
3. Build every claim from source documents or repository evidence. Use the evidence labels defined by the workflow.
4. Separate frontend behavior, backend ownership, interface contracts, cross-repository work, and verification requirements.
5. Stop at each review gate. Never approve a gate on behalf of a human. Record approvals only via `node .ai-dev/scripts/workflow-control.mjs <feature-dir> approve --request request.json` with a real `decisionRef` and `expectedVersion` from `control.version`.
6. Change workflow state only through `workflow-control.mjs` (`transition` / `block` / `resume`). Do not hand-edit `status.json.state`. Resume from `BLOCKED` returns to `suspendedFrom` after re-validation; never skip gates by editing state.
7. Treat the real project recorded in `status.json.project.root` as the only code source. Inspect, modify, run, and verify there so the Agent and developer use the same local environment.
8. Infer framework, versions, package manager, commands, and conventions from that repository's own evidence. Never require a predefined project profile.
9. Implement only approved tasks. Keep changes surgical and preserve the pre-existing changes recorded when the feature was initialized.
10. After code changes, run `node .ai-dev/scripts/record-code-changes.mjs <feature-dir> <file...>` with only the files affected by this requirement. Use `coding-changes/coding` as a live code index and `changes.patch` as the durable snapshot.
11. Run repository-provided verification commands and record exact commands and results in `artifacts/verification/verification.md`.
12. Never commit, merge, push, open a PR, deploy, or modify external systems unless the user explicitly requests that separate action.

## Keep artifacts consistent

- Before editing an existing workflow artifact, run `node .ai-dev/scripts/update-consistency.mjs <feature-dir> mark <artifact-path>`.
- Read `status.json.consistency.staleArtifacts`, update every affected downstream artifact, then run `node .ai-dev/scripts/update-consistency.mjs <feature-dir> resolve <artifact-path...>` for the artifacts actually refreshed.
- Keep `status.json.state` at the current execution phase while refreshing artifacts. Do not move the state backward merely to synchronize context.
- A changed approved artifact invalidates its affected approval. Ask for a new human review at the current state after the stale artifacts are refreshed.
- Preserve the generated record under `<feature-dir>/revisions/`; it is an audit trail, not a rollback instruction.
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

Run `node .ai-dev/scripts/validate-change.mjs <feature-dir> [--gate scope|spec|plan|final] [--json]` before presenting any gate for approval. Structural gate success is not semantic correctness.

Prefer `artifacts/analysis/intake.json` and `artifacts/design/delivery.json` as the source of truth for IDs and links. Regenerate Markdown views with `node .ai-dev/scripts/render-artifacts.mjs <feature-dir>`; do not hand-maintain those generated tables.
