# Review rule catalog

Required rule IDs are listed on each review request. Reports must include a check result for every required rule.

## Scope (`gate=scope`)

| ruleId | Intent |
| --- | --- |
| SCOPE-SOURCES | Sources are traceable and available when used by included requirements |
| SCOPE-OWNERSHIP | Frontend vs backend / cross-repo ownership is explicit |
| SCOPE-CONFLICTS | Conflicts and open blocking questions for scope are handled |

## Spec (`gate=spec`)

| ruleId | Intent |
| --- | --- |
| SPEC-OBSERVABLE | Behaviors are observable, not implementation trivia |
| SPEC-BOUNDARIES | Failure / empty / loading boundaries are covered |
| SPEC-ACCEPTANCE | Included requirements have acceptance scenarios |

## Plan (`gate=plan`)

| ruleId | Intent |
| --- | --- |
| PLAN-LOCATE | Files and symbols are located in the real project |
| PLAN-SCOPE | Tasks stay inside approved scope; no excluded work as tasks |
| PLAN-DEPS | Task dependencies and verification commands are coherent |

## Task (`gate=task`)

| ruleId | Intent |
| --- | --- |
| SPEC-COVERAGE | Diff satisfies linked requirements / acceptance |
| NO-EXTRA-SCOPE | No unexplained extra behavior |
| CODE-QUALITY | Matches repo conventions; no obvious defects in allowed files |
| TEST-EVIDENCE | Verification evidence exists or gaps are explicit |

## Final (`gate=final`)

| ruleId | Intent |
| --- | --- |
| FINAL-INTEGRATION | Cross-task integration holds on the full requirement diff |
| FINAL-TRACE | Delivered files and acceptance evidence align with delivery.json |
| FINAL-QUALITY | Overall code quality and verification are acceptable |
| FINAL-HUMAN-ITEMS | Items needing human judgment are listed, not silently closed |
