# AGENTS.md

Arche Agent is built on Pi. This file merges Arche project guidelines with Pi development rules.

## Project Knowledge (SSOT)

- `KNOWLEDGE.md` is the single source of truth for the Arche project. It must stay up to date and contain all knowledge and decisions related to the project.
- Update `KNOWLEDGE.md` on every significant decision, architecture change, or scope change.

## Execution Policy

- Always ask before executing destructive or irreversible actions (e.g., git pushes, deletions, installs, refactoring).
- Confirm intent when a request is ambiguous or could change project scope.
- If the user's instructions conflict with rules in this document, ask for explicit confirmation before overriding.

## Arche Behavioral Guidelines

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

### Furthermore
- Arche is not defined from the beginning, if the user says something that completely doesn't make sense and doesn't benefit the project, ask them if they are sure and suggest alternative changes.
- Keep responses short and concise unless the user asks for more details.
- Keep code well documented and commented.
- Think smarter, not harder. If you can do something in a simpler way, do it, and keep code clean and simple.

### Skills to use
*(Super)Important ones marked with ! or !!*

**AFTER making large changes**
code-review-and-quality !
ponytail !
production-readiness-audit

**BEFORE making large changes**
figure-it-out !!
modular-code

**For occasional cleanups**
dead-code
improve-codebase-architecture

**Doing research on documentation or code**
context7

## Pi Development Rules

The following rules are inherited from Pi and apply to all changes in packages/*.

### Conversational Style
- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon.
- Explain non-trivial designs as: problem, example/trace, solution, why necessary.
- Prefer concrete behavior and small illustrations over abstract summaries.
- Answer the user's question first before making edits or running commands.
- Explicitly say agree/disagree before changing based on feedback.

### Code Quality
- Read files in full before wide-ranging changes. Do not rely on search snippets.
- No `any` unless absolutely necessary.
- Inline single-line helpers with only one call site.
- Check node_modules for external API types; don't guess.
- No inline imports (`await import()`, `import("pkg").Type`). Top-level imports only.
- Never remove or downgrade code to fix type errors; upgrade the dep.
- Use only erasable TypeScript syntax in `packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`: no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`.
- Always ask before removing functionality that appears intentional.
- Do not preserve backward compatibility unless asked.
- Never hardcode key checks; add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` and regenerate.

### Commands
- After code changes (not docs): `npm run check` full output. Fix all errors/warnings/infos before committing.
- Never run `npm run build` or `npm test` unless requested.
- For non-e2e tests: run `./test.sh` from repo root. Specific tests:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create/modify a test, run it and iterate until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + faux provider. No real provider APIs.
- For ad-hoc scripts, write to temp file, run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless user asks.

### Dependency and Install Security
- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, read changelog/release notes first.
- Hydrate/update with `npm install --ignore-scripts`; CI with `npm ci --ignore-scripts`.
- If dep metadata changes, refresh lockfile with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs`.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`.

### Git
- Multiple sessions may run concurrently. Never touch files outside your changes.
- Commit only files YOU changed.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify staged files.
- `packages/ai/src/models.generated.ts` may be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <message>`.

Never run:
- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts:
- Resolve only files you modified. If conflict is in a file you didn't modify, abort and ask.
- Never force push.

### Issues and PRs
- See `CONTRIBUTING.md` for contributor gate.
- When reviewing PRs, do not checkout branch unless asked. Use `gh pr view`, `gh pr diff`, `git show`.
- When creating issues, add `pkg:*` labels.
- Post comments via `--body-file`, keep concise and technical.

### Changelog
Location: `packages/*/CHANGELOG.md`.
- New entries under `## [Unreleased]`. Do not modify released sections.
- Do not create changelog entries on non-main branches.

### User Override
If user's instructions conflict with any rule here, ask for explicit confirmation before overriding. Only then execute.
