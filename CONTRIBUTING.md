# Contributing

Thanks for helping improve Simplenote MCP. This project is a Node.js MCP server that reads Simplenote data from either the macOS desktop app store or the Simperium API.

## Development Setup

Use Node.js 22 or newer.

```bash
npm ci
npm run typecheck
npm test
```

To build the distributable files:

```bash
npm run build
```

## Pull Requests

Open pull requests against the `v2` branch unless a maintainer asks otherwise.

Keep changes focused and include tests when behavior changes. For user-facing behavior, update `README.md` or related docs in the same PR.

Before requesting review, run:

```bash
npm run typecheck
npm test
npm run build
```

## Issues

When reporting a bug, include your OS, Node.js version, MCP client, setup mode, and the command or tool call that failed. Do not include Simplenote tokens, note contents, note IDs, private tags, or other personal note data.

For feature requests, describe the workflow you are trying to support and whether it applies to the native macOS provider, the Simperium API provider, or both.
