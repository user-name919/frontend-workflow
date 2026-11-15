# Source-backed case design

Begin with a source inventory: requirement section, confirmed behavior, unresolved choice and implementation scope. Generate a small behavior table before scripts. For each included behavior, state precondition/data, user action, observable result and the source that authorizes that result. Link it to existing FR/AC IDs; keep test case IDs stable across reruns.

Review applicable dimensions: success, pending, legitimate empty data, failure, recovery, boundaries, repeated actions and concurrency. This is a set of questions, not permission to invent requirements. A stated count or threshold needs below/at/above cases when those boundaries change behavior. Record why a dimension is inapplicable when that decision affects coverage.

Examples:

- “Failure permits retry”: inject the specified failure at the API boundary, assert error and usable recovery action, click it, assert a new contract-correct request and fresh response content, then assert the previous error is gone. Checking button presence alone is insufficient.
- “No parallel request while loading”: hold the response pending, exercise repeated UI actions and count real intercepted requests. Testing only a helper does not prove that the UI uses it.
- “Exit retains answered data”: exercise the exit flow and observe restored answers/persisted state from the real application; do not populate the target store immediately before asserting it.

Each expectation needs a precise observable (`ui`, `network`, `navigation`, `storage` or `document`) and value/state. Split cases when they require different methods or environments. An AC can have mock and live cases with distinct IDs; a mock pass cannot fulfill the live case. Keep all automated business cases required at feature scope, with optional task scope where dependencies exist.

Use repository code to locate page, route, selectors, client timeout and existing test setup. Do not copy the implementation's conditions into an independent “expected” function. Assert user-visible behavior and contract effects, with web-first waiting. Data initialization may bypass the UI; the behavior under acceptance may not.

For coverage review give the reviewer original PRD/decisions/contracts and versions, delivery, then tests. The reviewer first enumerates confirmed behaviors independently, compares omissions/contradictions, and checks that assertions can distinguish a plausible wrong implementation. Report uncertainty rather than a percentage that implies semantic completeness.
