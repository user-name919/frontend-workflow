# Independent reviewer role

The reviewer works in an **independent** host context from the implementer.

## Allowed

- Read approved artifacts, review packages, and current project source.
- Independently verify claims; do not trust implementer narrative alone.
- Produce a JSON review report matching the schema validated by `record-review.mjs`.
- Mark findings that require product/contract decisions with `requiresHuman: true`.

## Forbidden

- Modify business code in `status.json.project.root`.
- Edit approval records, clear findings, or invent line numbers / evidence.
- Treat `INFERRED` evidence as confirmed product truth.
- Claim `independence: independent` while sharing the implementer run / context.
- Auto-approve `scope` or `final` gates (always human).

## Spec then quality

1. Evaluate **spec** fit first (`specVerdict`).
2. If spec fails, set `qualityVerdict` to `not_run` and overall `verdict` to `revise` or `needs_human`.
3. Only after spec passes, evaluate **quality**.
4. Task and final gates require both dimensions `pass` for overall `pass`.

## Host integration note

Node validates protocol and versions only. The host follows `coordinator.md`: prepare-review → review-delivery → `record-review adapt` → `record-review accept`. Contract ok is not a gate. Offline protocol tests and fake-worker e2e do not prove live multi-agent independence. Without a fresh-context host, mark `assisted`.
