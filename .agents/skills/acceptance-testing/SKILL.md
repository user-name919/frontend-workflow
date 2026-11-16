---
name: acceptance-testing
description: Design source-backed frontend acceptance cases and execute them through delivery v2, including undeployed backend contracts, fault injection, current-candidate evidence and requirement coverage review. Use within prd-to-code spec, plan, implementation and verification stages; not for inventing product rules or replacing final human approval.
---

# Requirement acceptance testing

Read the active feature's intake/delivery, original PRD and confirmed decisions, repository test conventions, and `.ai-dev/workflow.md`. Use this skill inside the existing state chain; it does not add a new approval stage. Keep the actual project and its unrelated changes intact.

For a design-only request with no active feature or explicitly limited inputs, use the supplied originals and produce a case-design draft without creating a workspace, moving state or claiming approval. Missing contract, fixture, test path or command fields stay explicitly `pending` in the draft, with the needed source/decision noted; do not fabricate a schema-valid delivery. This draft supports discussion, not gate admission. Once those facts are available, populate and validate the real delivery v2.

## Design cases before implementation

At spec, write AC given/when/then and verification `test|manual|inspection`; render with `render-artifacts.mjs <feature> --phase spec`. Every expected business result must trace through AC → included FR → confirmed source/decision. Read original sources first; implementation helps locate entry points, not decide expected behavior.

At plan, read [case design](references/case-design.md) and the installed `.ai-dev/acceptance-testing.md` schema/commands. Populate delivery v2 testCases, environments, checks, task verifyIds and finalCheckIds. UI/network/navigation/storage behavior normally needs browser execution. Inspection proves document/source facts only. A manual case needs manualReason (human-judgment, physical-device or external-action), its concrete reason and sourceRefs; no existing test framework is not a manual exemption. Make the source-to-case mapping reviewable during the existing spec/plan review. Do not wait until code is complete to reverse-engineer expected outcomes.

If the source is ambiguous, preserve the question and its exact source. Search existing confirmed project rules before asking. Suggestions and conventional error handling are not confirmed requirements. An unresolved business choice cannot become a passing test oracle.

## Execute and collect evidence

Read [execution and failure handling](references/execution.md). Reuse project tests and runtime versions. Put executable tests/config/fixtures in the normal project test directory and declare their files in task scope. For browser checks, run actual UI and real application logic with the first supported adapter, complete Playwright JSON or the documented browser-json adapter for repeatable ego-browser scripts. Read `.ai-dev/test-runtime.md` for optional project runtime profiles, entry bindings, prerequisites and observed context. Discover setup during planning from repository evidence; prepare it before running cases. Keep runtime setup/check wrappers in declared project test files so routine environment repairs do not rewrite business acceptance in delivery. Existing unit/build/lint commands remain engineering checks.

Run the current task's verifyIds with `scope=task`, taskId and running attemptId before submitting DONE. Cross-task scenarios can wait until feature verification. Run every finalCheckId with `scope=feature` in VERIFYING on the final candidate. The runner writes immutable run directories; only its actual records can support acceptance. Do not hand-edit records, fingerprints, status, or derived pass results.

Read the installed `.ai-dev/acceptance-review.md` for per-expectation screenshots, the fixed local HTML report and user-facing updates. Announce the testing stage, actual environment and business scenarios before running. If a task only runs engineering checks, explicitly identify when its browser scenarios will run. Capture the actual visual state at each UI/navigation expectation, including failures where possible; link screenshotRefs in the raw observation. Report results in business language with passed/failed/blocked/unexecuted items and clickable local reports, not just run IDs or reviewer pass. Keep Mock, live and manual results separate.

For Chinese-language projects, give testCases and checks concise Chinese `title` values; keep machine IDs unchanged. Write prerequisites, steps, expected outcomes and actual observations in Chinese business language. Observations must contain measured page/request/data values, including failures; do not repeat the expectation or say only “assertions passed”. Keep original error stacks and identifiers in technical details. The report renderer does not translate arbitrary logs or infer missing facts. Improve old English observations by rerunning corrected tests, never editing sealed evidence.

Use the original sources and test code in the existing fresh-context reviewer packet. For v2 task/final acceptance, bind each check to its caseId and each passing browser check to a direct verificationRef. Ask the reviewer to look for omissions before reading the generated case list. Semantic coverage cannot be guaranteed by schema validation or a test count.

## Finish or repair

Read `workflow-control acceptance-status` and resolve each missing, failed, stale or flaky check. Fix established behavior, test setup or missing evidence under the current authorization, then rerun. Do not turn automation into manual/inspection or weaken expectations to escape a failure. If the approved contract/rule must change, update its source and follow existing consistency/review rules.

Limit an unchanged failing repair cycle to the workflow policy's maxFixRounds (default 3); diagnose and report the remaining blocker rather than rerunning indefinitely. Preserve every failed attempt. For critical scenarios, use a temporary isolated copy to inject a business defect and verify failure at the intended assertion; launch/build errors do not count as detection.

Automatic readiness permits FINAL_REVIEW while planned manual cases remain pending. Record manual results only after actual user acceptance confirmation against the identified candidate, including the source reference, quoted decision, case/expectation IDs and per-precondition/per-expectation observations. Login, account selection and permission to test are setup consent, never acceptance. Agent-operated browser checks are browser evidence, never human confirmations. Missing populated data blocks that scenario; observing empty state does not pass populated rows/pagination/copy expectations. Preserve successful subcases separately. Re-seal and independently review new evidence before final approval. Mock readiness, live integration and manual/device results must remain distinguishable. No commit, publish, backend mutation or fabricated human confirmation follows from this skill.
