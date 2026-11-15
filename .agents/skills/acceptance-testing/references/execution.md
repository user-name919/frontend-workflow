# Backend availability and fault tests

Use a fresh isolated browser context for each case, deterministic fixture/reset logic and the real app entry. A webServer should start the current checkout and fail on conflicting ports; an HTTP 200 from an unrelated existing server does not identify the candidate. Configure traces/screenshots in WORKFLOW_VERIFICATION_DIR so outputs do not change source snapshots. Complete JSON output must include passed tests.

For an undeployed endpoint, confirm the method/path/parameters/response contract first, freeze its local file and digest, and fulfill only that endpoint directly. `route.fetch()` still requires a reachable server and is unsuitable for an undeployed endpoint. Older reachable APIs may remain real, but label this environment contract-mock and enumerate every replacement. Do not fabricate a response contract from frontend implementation.

Define mock rule IDs with exact method/URL and fixture. Attach acceptance-context containing actual environmentId, baseURL, registered mock IDs and observed hit counts. Assert the fault really happened and attach evidence after the case. A rule with zero hits is missing setup evidence, even if a generic error banner appears. Never change production/test service state just to inject a frontend failure.

Use confirmed behavior to select faults:

| Fault | How to exercise it | What to observe |
| --- | --- | --- |
| HTTP failure | fulfill actual request with 500/503 | error, loading ends, authorized recovery path |
| Business error in 200 | contract-valid failure code/body | business failure, no false success |
| Client timeout | hold request beyond the actual client timeout | application timeout/fallback; runner timeout is a failure |
| Network failure | abort the matching request | appropriate fallback and later recovery |
| Empty response | return contract-valid empty data | empty state, distinguished from error |
| Partial failure | fail one specified subrequest | unaffected content and confirmed partial fallback |

Do not invent authorization redirects, retry counts, wording or empty-state rules where the PRD/project rules leave them undecided. Browser routing may not capture service workers/native bridges; disable service workers only when appropriate for the tested scope, or use a suitable adapter/manual device case and report the limitation.

For live integration use a separate environment/check with response replacement disabled, an identifiable service and resettable test data. Never fall back to a mock after a live failure. A malformed live response must expose contract failure, not trigger automatic fixture changes. A frontend preview with automation-only route handlers does not supply mocks to the developer's manual browser; use the project's supported dev mock/proxy if preview is needed.

The runner binds inputs before execution and checks them afterward and at admission. A new failed/interrupted run supersedes old success. Flaky after retry is not stable pass. For a crashed worker, establish it has stopped before `recover-verification`; preserve and recover a completed durable record after a ledger conflict rather than rerunning side effects.

For a local negative control, copy the fixture into a temporary Git project, make one meaningful defect, execute the same cases, and record the failing case/expectation. Compare with the correct baseline and restore only the temporary copy. Do not mutate the user's checkout or use an unavailable build as proof the business test is effective.
