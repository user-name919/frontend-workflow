# Vue 3 + TypeScript repository guide

## Inspect before planning

- Read `package.json`, lockfile, TypeScript config, build config, aliases, lint config, and repository instructions.
- Identify whether the target code uses Composition API, Options API, `<script setup>`, auto-imports, Pinia/Vuex, and the current component library.
- Trace routes, parent/child components, composables, stores, API wrappers, request/response types, and tests involved in the requirement.
- Reuse current patterns; do not migrate adjacent Vue styles or state management.

## Plan frontend behavior

- Separate display state, interaction state, request state, and persisted state.
- Specify loading, empty, error, disabled, retry, and compatibility behavior when relevant.
- For shared components, identify all call sites and confirm whether behavior should be global or gated by props/context.
- Treat API examples as contracts only after reconciling them with the repository response wrapper.

## Implement

- Keep reactive state ownership close to the existing owner.
- Prefer small pure functions for business branching that needs deterministic tests.
- Do not introduce a new abstraction for a single call site unless it removes duplicated approved behavior.
- Preserve existing component events and public props unless the plan explicitly changes them.

## Verify

- Discover available scripts instead of assuming `lint`, `test`, or `typecheck` exists.
- Run the narrowest relevant automated check, then the project build.
- For visible UI changes, record viewport, route, state, and visual/manual evidence.
- Verify every changed shared component through all affected call sites or document what was not tested.
