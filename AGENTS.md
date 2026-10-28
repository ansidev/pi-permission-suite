# AGENTS.md

Guidance for AI coding agents working in this repo.

## What this is

`pi-permission-suite` is a Pi coding-agent extension (TypeScript, ESM, no build step; Pi loads `index.ts` directly via `package.json` → `pi.extensions`). It provides four approval modes (Act / Auto / Ask / Plan), a rule engine for bash commands, tool names and file paths, and a pluggable Decision API for Auto mode.

This is a fork of `Eddie0521/pi-permission-suite` (itself based on `@gotgenes/pi-permission-system`). Remotes: `origin` = `ansidev/pi-permission-suite`, `upstream` = `Eddie0521/pi-permission-suite`. Install this fork with `pi install git:github.com/ansidev/pi-permission-suite`, not `npm:`.

## Commands

```bash
npm install        # install deps (package-lock.json is the lockfile)
bun test           # run tests in test/*.test.ts (uses bun:test)
bun test test/rules.test.ts   # single file
```

There is no build or lint step. Try the extension locally with `pi -e ./`.

## Layout

| File | Role |
|---|---|
| `index.ts` | Extension entry: commands (`/approval-mode`, `/pi-permission-suite`), `set_approval_mode` tool, `Ctrl+Q` shortcut, `tool_call` / `before_agent_start` / `session_start` handlers |
| `rules.ts` | `RuleEngine`: deny → allow → session-always → mode layer |
| `tool-rules.ts` | `tools.allow/deny` matching, including arg-based conditions |
| `bash-parser.ts` | tree-sitter bash parsing (chains, `$(...)`, subshells) |
| `wildcard-matcher.ts`, `path-utils.ts` | Glob matching, `~` expansion, symlink-safe path checks |
| `approver.ts`, `subprocess-runner.ts` | Subagent auto-approver |
| `decision-provider.ts` | Provider interface and `resolveDecision` (timeout, validation, confidence) |
| `jev-provider.ts`, `http-decision-provider.ts` | Jev (TypeSafe) and generic HTTP providers |
| `decision-audit.ts` | JSONL audit log of provider decisions |
| `config-loader.ts` | Loads user config, creating it from `config.default.json` on first run |
| `config.default.json` | Shipped default rules (source of truth for defaults) |
| `config.json` | Local dev copy; not published (see `.npmignore`) |

## Conventions and invariants

- **Fail closed.** Any provider error, timeout, non-2xx, redirect, oversized or schema-invalid response, or confidence below threshold resolves to `ask`, never `allow`. Do not add a path where a failure yields `allow`.
- **Deny always wins**, in every mode including Act, and beats allow. Path deny rules override `tools.allow`.
- **Secrets stay out of config and logs.** API keys come from env vars (`apiKeyEnv`, `TYPESAFE_API_KEY`, `env:` auth values). The audit log never stores keys or full tool input.
- **No hardcoded TS defaults for rules**; defaults live in `config.default.json`. Keep new config fields optional with safe fallbacks (invalid values fall back to defaults).
- Use `.ts` extensions in relative imports (`import … from "./x.ts"`). Peer deps `@earendil-works/pi-coding-agent` and `typebox` are provided by Pi.
- Keep all code, comments, config text and docs in English.
- Add or update tests in `test/` for any rule, provider or config change. Tests import modules directly (`../rules.ts`).

## Docs

`README.md` (English) and `README-zh.md` (Chinese) must stay in sync. When adding config fields, commands or files, update both, including the project-structure tree. `config.default.json` and the config example in the README should agree.

## Git

Commit messages follow `PPS-<n>: summary` for tracked issues or `type(scope): summary` (e.g. `feat(decision): …`). Keep upstream-mergeable changes small and separate from fork-only features.

## Known inconsistencies

- CI (`.github/workflows/test.yml`) uses `bun install`, while the repo ships `package-lock.json` and ignores `bun.lock`.
- npm package `name` is still `pi-permission-suite`, which collides with upstream if published.
