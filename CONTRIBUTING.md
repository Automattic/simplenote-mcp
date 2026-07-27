# Contributing

Thanks for helping improve Simplenote MCP. This project is a Node.js MCP server that reads Simplenote data from either the Simplenote macOS app's local Core Data store or the Simperium API.

## Development Setup

Use Node.js 22 or newer.

```bash
pnpm install
pnpm typecheck
pnpm test
```

To build the distributable files:

```bash
pnpm build
```

## Pull Requests

Open pull requests against the `main` branch unless a maintainer asks otherwise.

Keep changes focused and include tests when behavior changes. For user-facing behavior, update `README.md` or related docs in the same PR.

Before requesting review, run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Issues

When reporting a bug, include your OS, Node.js version, MCP client, setup mode, and the command or tool call that failed. Do not include Simplenote tokens, note contents, note IDs, private tags, or other personal note data.

For feature requests, describe the workflow you are trying to support and whether it applies to the native macOS provider, the Simperium API provider, or both.
