# Team Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a tested GitHub repository that installs one shared PRD-to-code skill for Codex and Cursor and initializes the workflow in frontend projects.

**Architecture:** A dependency-free Node.js CLI copies versioned assets from the package into either the shared user skill directory or a target project. A preflight phase prevents partial writes and protects conflicts; forced replacements are backed up before copying.

**Tech Stack:** Node.js 18+, ECMAScript modules, `node:test`, GitHub repository package execution through `npx`.

**Spec:** `docs/superpowers/specs/2026-09-01-team-distribution-design.md`

## Global Constraints

- Keep one canonical skill in `.agents/skills/prd-to-code`.
- Do not edit existing `AGENTS.md`, Codex config, Cursor settings, or user rules.
- Require Node.js 18 or later and no third-party runtime dependencies.
- Abort before writes on conflicts unless `--force` is present.
- Back up files replaced by `--force`.

---

### Task 1: Installer behavior

**Files:**
- Create: `package.json`
- Create: `test/installer.test.mjs`
- Create: `src/installer.mjs`
- Create: `bin/frontend-work-flow.mjs`

**Interfaces:**
- Produces: `runCli(argv, options): Promise<{ copied: string[], skipped: string[], backups: string[] }>`
- Produces commands: `install`, `setup [project]`, `doctor`, and `help`.

- [ ] **Step 1: Write failing tests** for global installation, project initialization, conflict refusal, forced backup, and doctor output using temporary directories.
- [ ] **Step 2: Run `node --test`** and confirm failure because `src/installer.mjs` does not exist.
- [ ] **Step 3: Implement the minimum CLI** with preflight comparison, recursive file discovery, backup, and copy behavior.
- [ ] **Step 4: Run `npm test`** and confirm every installer test passes.
- [ ] **Step 5: Run `node bin/frontend-work-flow.mjs help`** and confirm command examples and Node version requirements are visible.

### Task 2: Package the existing workflow

**Files:**
- Create: `.agents/skills/prd-to-code/**`
- Create: `template/.ai-dev/**`
- Create: `template/.cursor/rules/prd-to-code.mdc`

**Interfaces:**
- Consumes: installer source roots defined in Task 1.
- Produces: the exact files installed by the global and project commands.

- [ ] **Step 1: Copy the reviewed v0.1 workflow assets** without changing their domain behavior.
- [ ] **Step 2: Validate `.agents/skills/prd-to-code`** with `quick_validate.py`.
- [ ] **Step 3: Run `npm test`** to confirm the packaged assets satisfy installer tests.
- [ ] **Step 4: Initialize a temporary project** and run its `init-change.mjs` and `validate-change.mjs` scripts.

### Task 3: Team documentation and repository verification

**Files:**
- Create: `README.md`
- Create: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: the CLI and packaged workflow from Tasks 1 and 2.
- Produces: copy-paste employee installation and usage commands.

- [ ] **Step 1: Document prerequisites, install, setup, Cursor/Codex invocation, updating, conflict recovery, and uninstall.**
- [ ] **Step 2: Run `npm pack --dry-run`** and verify all runtime assets are included.
- [ ] **Step 3: Run tests, skill validation, and a clean end-to-end temporary install again.**
- [ ] **Step 4: Inspect `git diff --check` and `git status --short`** for accidental or missing files.

### Task 4: Publish and verify the GitHub bootstrap

**Files:**
- Modify: Git history only.

**Interfaces:**
- Consumes: verified repository contents.
- Produces: executable public GitHub `npx` commands.

- [ ] **Step 1: Commit the verified repository** with message `feat: publish frontend PRD-to-code workflow`.
- [ ] **Step 2: Push `main` to `origin`.**
- [ ] **Step 3: Execute the public GitHub `npx` install and setup commands** against temporary directories.
- [ ] **Step 4: Report the commit, commands, verification evidence, and any remaining platform limitation.**
