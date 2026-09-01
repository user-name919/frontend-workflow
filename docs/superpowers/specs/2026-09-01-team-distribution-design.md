# Frontend PRD-to-Code Team Distribution Design

## Goal

Distribute the existing frontend PRD-to-code workflow to Codex and Cursor users with one shared repository and two commands: install the reusable skill globally, then initialize workflow assets in a frontend project.

## Decisions

- Keep one canonical Agent Skill at `.agents/skills/prd-to-code` because Codex and Cursor both discover the open Agent Skills layout.
- Provide a dependency-free Node.js CLI so employees with a frontend toolchain do not need to install another runtime.
- Use `npx --yes github:bi554lecex/frontend-work-flow <command>` as the public-repository bootstrap command.
- Keep repository-specific artifacts under `template/`; `setup` copies them into the target frontend repository.
- Never edit an existing `AGENTS.md`. The project skill supplies the Codex workflow, while `.cursor/rules/prd-to-code.mdc` supplies Cursor's persistent project rule.
- Preflight every destination before writing. Identical files are skipped; different files stop the command unless `--force` is supplied.
- With `--force`, back up every replaced file under `.frontend-work-flow-backups/<timestamp>/` in the target project or under `~/.frontend-work-flow-backups/<timestamp>/` for the global skill.
- Do not commit, merge, push, or deploy application repositories. The workflow repository itself is committed and pushed because the user explicitly requested publication.

## Commands

```bash
npx --yes github:bi554lecex/frontend-work-flow install
npx --yes github:bi554lecex/frontend-work-flow setup .
```

Additional commands:

```bash
npx --yes github:bi554lecex/frontend-work-flow doctor
npx --yes github:bi554lecex/frontend-work-flow setup . --force
```

## Repository layout

```text
frontend-work-flow/
├── .agents/skills/prd-to-code/
├── bin/frontend-work-flow.mjs
├── src/installer.mjs
├── template/
│   ├── .ai-dev/
│   ├── .cursor/rules/prd-to-code.mdc
├── test/installer.test.mjs
├── docs/
├── package.json
└── README.md
```

## Success criteria

1. A clean temporary home receives `~/.agents/skills/prd-to-code/SKILL.md` after `install`.
2. A clean temporary frontend repository receives `.ai-dev`, `.cursor/rules/prd-to-code.mdc`, and `.agents/skills/prd-to-code` after `setup`.
3. Existing different files are not modified without `--force`.
4. Forced replacement creates recoverable backups.
5. The installed skill passes the official local skill validator.
6. The initialized workflow can create and validate a sample change.
7. The exact GitHub `npx` commands work after publication.

## Non-goals

- Publishing an npm package or a Codex/Cursor marketplace plugin.
- Editing employee `~/.codex/config.toml`, Cursor settings, or user rules.
- Automatically updating business repositories.
- Supporting machines without Node.js 18 or later in v0.1.
