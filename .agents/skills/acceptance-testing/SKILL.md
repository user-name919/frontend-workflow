---
name: acceptance-testing
description: Design source-backed frontend acceptance cases and execute them through delivery v2, including undeployed backend contracts, fault injection, current-candidate evidence and requirement coverage review. Use within prd-to-code spec, plan, implementation and verification stages; not for inventing product rules or replacing final human approval.
---

# Requirement acceptance testing

Read the active feature's intake/delivery, original PRD and confirmed decisions, repository test conventions, and `.ai-dev/workflow.md`. Use this skill inside the existing state chain; it does not add a new approval stage. Keep the actual project and its unrelated changes intact.

For a design-only request with no active feature or explicitly limited inputs, use the supplied originals and produce a case-design draft without creating a workspace, moving state or claiming approval. Missing contract, fixture, test path or command fields stay explicitly `pending` in the draft, with the needed source/decision noted; do not fabricate a schema-valid delivery. This draft supports discussion, not gate admission. Once those facts are available, populate and validate the real delivery v2.

## Design cases before implementation

At spec, write AC given/when/then and verification `test|manual|inspection`; render with `render-artifacts.mjs <feature> --phase spec`. Every expected business result must trace through AC → included FR → confirmed source/decision. Read original sources first; implementation helps locate entry points, not decide expected behavior.

At plan, read [case design](references/case-design.md) and the installed `.ai-dev/acceptance-testing.md` schema/commands. Populate delivery v2 testCases, environments, checks, task verifyIds and finalCheckIds. Make the source-to-case mapping reviewable during the existing spec/plan review. Do not wait until code is complete to reverse-engineer expected outcomes.

If the source is ambiguous, preserve the question and its exact source. Search existing confirmed project rules before asking. Suggestions and conventional error handling are not confirmed requirements. An unresolved business choice cannot become a passing test oracle.

## Execute and collect evidence

Read [execution and failure handling](references/execution.md). Reuse project tests and runtime versions. Put executable tests/config/fixtures in the normal project test directory and declare their files in task scope. For browser checks, run actual UI and real application logic with the first supported adapter, complete Playwright JSON. Existing unit/build/lint commands remain engineering checks.

Run the current task's verifyIds with `scope=task`, taskId and running attemptId before submitting DONE. Cross-task scenarios can wait until feature verification. Run every finalCheckId with `scope=feature` in VERIFYING on the final candidate. The runner writes immutable run directories; only its actual records can support acceptance. Do not hand-edit records, fingerprints, status, or derived pass results.

Use the original sources and test code in the existing fresh-context reviewer packet. For v2 task/final acceptance, bind each check to its caseId and each passing browser check to a direct verificationRef. Ask the reviewer to look for omissions before reading the generated case list. Semantic coverage cannot be guaranteed by schema validation or a test count.

## Finish or repair

Read `workflow-control acceptance-status` and resolve each missing, failed, stale or flaky check. Fix established behavior, test setup or missing evidence under the current authorization, then rerun. Do not turn automation into manual/inspection or weaken expectations to escape a failure. If the approved contract/rule must change, update its source and follow existing consistency/review rules.

Limit an unchanged failing repair cycle to the workflow policy's maxFixRounds (default 3); diagnose and report the remaining blocker rather than rerunning indefinitely. Preserve every failed attempt. For critical scenarios, use a temporary isolated copy to inject a business defect and verify failure at the intended assertion; launch/build errors do not count as detection.

Automatic readiness permits FINAL_REVIEW while planned manual cases remain pending. Record manual results only after actual user confirmation against the identified candidate, including confirmationRef. Re-seal and independently review new evidence before final approval. Mock readiness, live integration and manual/device results must remain distinguishable. No commit, publish, backend mutation or fabricated human confirmation follows from this skill.
