# Agent Instructions

This repository is a Node.js 22+ TypeScript MCP server for Simplenote. It exposes Simplenote notes to MCP clients through either the local macOS Simplenote Core Data store or the Simperium HTTP API.

`AGENTS.md` is the source of truth for coding-agent guidance in this repo. `CLAUDE.md` should only point here.

## Project Shape

- `src/server.ts` is the MCP entry point and composition root. It dispatches CLI subcommands before setup, parses server startup args, resolves the active provider, wires telemetry, registers tool groups, and connects over stdio.
- `src/server-args.ts` parses server startup flags such as `--path`. Keep runtime server options here rather than in `src/cli.ts`.
- `src/cli.ts` implements CLI subcommands: `setup`, `logout`, and `disable-telemetry`.
- `src/tools/` contains MCP tool and prompt registration code:
  - `common.ts` defines shared registration context, annotations, and tool error formatting.
  - `read.ts` registers core read tools: list tags, list/search notes, and get note.
  - `write.ts` registers write-capability-gated tools plus the revert workflow group. `get_note_history` and `get_note_version` live here because they primarily support `revert_note`, but they must keep read-only MCP annotations.
  - `results.ts` defines tool output schemas and shared structured/text response helpers.
- `src/providers/` contains provider and persistence code:
  - `resolver.ts` chooses local vs. API provider from config, token, and `--path`.
  - `native-macos.ts` reads the macOS Simplenote store from disk and is always read-only.
  - `simperium-api.ts` talks to Simperium, supports writes when configured, and owns API cache/write-safety behavior.
  - `auth.ts`, `config.ts`, and `paths.ts` handle token/config files and cross-platform paths.
  - `normalize.ts` defines normalized provider data shapes and shared note formatting helpers.
- `src/telemetry.ts` sends anonymous setup/tool-call events through Tracks. Telemetry MUST NOT include note IDs, note content, tags, search queries, Simplenote account details, or tokens.
- `tests/` mirrors source areas and uses Node's built-in test runner with `tsx`.
- `server.js` at the repo root is a compatibility shim that imports `dist/server.js`; keep it stable unless intentionally changing local-checkout compatibility.
- `dist/` is build output. Do not hand-edit it.

## Commands

Use Node.js 22 or newer (see .nvmrc)

```bash
npm ci
npm run typecheck
npm test
npm run build
```

- `npm run typecheck` runs `tsc --noEmit`.
- `npm test` runs `node --import tsx --test "tests/**/*.test.ts"`.
- `npm run build` runs `tsc` and makes `dist/server.js` executable.
- `npm start` runs the built server from `dist/server.js`; build first.
- `npm run inspect` starts MCP Inspector against `node dist/server.js`; build first.

Before requesting review, run at least:

```bash
npm run typecheck
npm test
npm run build
```

## Coding Conventions

- TypeScript is strict ESM using `module`/`moduleResolution: NodeNext`. Include file extensions on relative imports, as the existing code does (`../src/foo.ts` in tests, `./foo.js` in source that compiles to `dist`).
- Prefer small, explicit provider interfaces over broad abstractions. Extend `Provider` in `src/providers/normalize.ts` only when the MCP server needs a new capability across providers.
- Keep injected dependencies for tests where code touches the filesystem, process env, network, prompts, platform, or time-sensitive state. Existing patterns use optional dependency bags and exported `_test` helpers.
- Use Node built-ins where possible. The project already relies on global `fetch`, `Response`, and `AbortSignal.timeout` from Node 22.
- Preserve the existing style: tabs for indentation in TypeScript, `node:...` imports for Node built-ins, `strict as assert` in tests, and concise comments only where they explain non-obvious behavior.

## Architecture Rules

- Provider resolution is configuration-driven. `simplenote-mcp setup` writes `config.json`; missing or malformed config should produce actionable setup guidance.
- `--path` MUST force the native macOS provider and remain read-only. It intentionally ignores missing/malformed config and only warns when it overrides API write-mode.
- The native macOS provider MUST remain read-only. Do not add write methods to `native-macos.ts`.
- Write and write-workflow tools are registered only when the resolved provider advertises the relevant capability. The resolver strips optional provider capabilities in API read-only mode; keep that capability gate intact.
- `update_note` replaces the entire note content when `content` is provided, and replaces the entire tag list when `tags` is provided. Any workflow or tool description that edits part of a note MUST first read the existing note and send the full desired replacement.
- Simperium writes must preserve fields not represented by `NormalizedNote` (`publishURL`, `shareURL`, unknown `systemTags`, etc.). Fetch the raw note, merge changes, then POST the full body.
- Simperium note IDs must be URL-encoded before use in request paths.
- Keep the rolling write-rate guard in `simperium-api.ts` effective for successful writes. It is there to interrupt runaway bulk edits.
- The API provider caches reads for 60 seconds and may return stale cache only for transient network/request failures. Auth failures and invalid response shapes must surface.
- Token files must stay private (`0600` where POSIX permissions apply). Config files are intentionally `0644`. Telemetry state uses `0600`.

## Testing Standards

- Add or update focused tests when behavior changes. User-facing behavior, provider resolution, write gating, cache behavior, telemetry privacy, auth/config persistence, and path handling all need tests.
- Use `node:test` and `node:assert/strict`; do not add a separate test framework.
- Do not hit real Simplenote or Simperium endpoints from automated tests. Mock `globalThis.fetch` with helpers from `tests/helpers/general.ts`.
- Use `useTmpDir` for filesystem tests and injected paths/deps instead of writing to real user config directories.
- Scope `process.env` changes with `useEnvVar`.
- Restore mocks with `mock.restoreAll()` when using `node:test` mocks.
- Permission assertions should skip on Windows, following existing test patterns.
- For behavior that depends on MCP client visibility, prefer testing the provider/resolver capability shape and then manually verify with MCP Inspector when needed.

## Documentation And PRs

- Keep changes focused and include tests for behavior changes.
- Update `README.md` or related docs in the same PR when user-facing commands, setup flow, tools, provider behavior, telemetry, or troubleshooting change.
- The PR template expects a related issue link, proposed changes, rationale, testing, and a pre-merge checklist.
- If README wording conflicts with current source/tests, treat source and tests as the immediate implementation source of truth, then fix the docs as part of the change when it affects users.

## Common Pitfalls

- Do not assume the server is read-only everywhere. Local mode is read-only, API mode can expose write tools when `writeMode` is enabled.
- Do not register capability-gated tools unconditionally; clients should only see tools supported by the resolved provider.
- Do not send partial note content to `updateNote` unless the intended result is to replace the entire note with that partial content.
- Do not log or emit note content, note IDs, private tags, Simplenote tokens, or account details in telemetry or test snapshots.
- Do not script repeated login attempts; Simplenote login endpoints are rate-limited.
- Do not add real network calls to tests to "prove" Simperium behavior. Model the HTTP contract with mocked `Response` objects.
- Do not hand-edit `dist/`; build it.
