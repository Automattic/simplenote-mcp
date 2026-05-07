# Deploying

This document covers releasing a new version of `@automattic/simplenote-mcp` to npm and the official MCP Registry. Releases ship in two steps: publish the package to npm, then submit the matching metadata to the registry.

## Prerequisites

- npm CLI logged in as a user with publish access to the `@automattic` scope. Confirm with `npm whoami`, then check that the user appears in `npm view @automattic/simplenote-mcp maintainers`. If not, an existing maintainer must run `npm owner add <user> @automattic/simplenote-mcp`.
- The [`mcp-publisher`](https://github.com/modelcontextprotocol/registry) CLI installed and authenticated with `mcp-publisher login github`. See the [registry's publishing quickstart](https://modelcontextprotocol.io/registry/quickstart) for the current install options (Homebrew and pre-built binaries).
- The GitHub user authenticated to `mcp-publisher` must be a member of the GitHub organization that owns the registry namespace, with **public** organization-membership visibility. The MCP Registry uses GitHub's canonical casing when granting namespace permissions, so `io.github.Automattic/...` (capital `A`) is the form the registry expects for this repo.

## Pre-release checklist

Cut a PR with the version bump and metadata changes before publishing.

1. Bump the version in **both** files; they must match exactly.
   - `package.json` → `version`
   - `server.json` → top-level `version` and `packages[0].version`
2. Confirm the registry namespace is consistent. The MCP Registry's ownership check is byte-for-byte case-sensitive.
   - `package.json` → `mcpName`
   - `server.json` → `name`
3. Run the standard verification:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   ```

4. Open the PR, get it reviewed, and merge.

## Releasing

Run these commands from a clean checkout of `main` at the merged release commit. The commands assume the working directory is the repo root so that `mcp-publisher` finds `./server.json`.

### 1. Publish to npm

```bash
npm ci
npm run build
npm pack --dry-run    # eyeball the file list and embedded version
npm publish
```

Once a version is published it cannot be replaced. If the wrong content goes out, bump and ship a follow-up version rather than trying to re-publish the same number.

### 2. Publish to the MCP Registry

```bash
mcp-publisher publish
```

The registry only stores metadata; the actual artifact lives on npm. The publish call validates that the published tarball's `mcpName` matches `server.json`'s `name` exactly before accepting the submission.

### 3. Verify

```bash
npm view @automattic/simplenote-mcp version
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Automattic/simplenote-mcp" | jq '.servers[].version'
```

Both should report the new version. If `jq` is unavailable, `grep -o '"version":"[^"]*"' ` against the same `curl` works as a fallback.

## Troubleshooting

### `403 Forbidden` from `mcp-publisher publish`

The error response lists the namespace prefixes the authenticated GitHub user is allowed to publish under. The casing in `server.json` `name` must exactly match one of those prefixes, including the GitHub-org name's canonical casing. Update `server.json` and try again.

If the granted prefixes do not include your target organization at all, the GitHub user either is not a member of that org or has membership visibility set to private. Make membership public and re-run `mcp-publisher login github` so the JWT picks up the change.

### `400 Bad Request` with `mcpName` mismatch

`server.json` `name` does not match the `mcpName` in the published npm tarball. Fix `mcpName` in `package.json`, bump the npm version (a published version cannot be re-published), publish to npm, then retry `mcp-publisher publish`.

### `404 Not Found` from `npm publish`

npm returns `404` instead of `403` when the logged-in user lacks publish access to a scope. Run `npm whoami` and compare against `npm view @automattic/simplenote-mcp maintainers`. The fix is publish access on the maintainers list, not the package state.

### `401 Unauthorized` from `npm publish` or `npm whoami`

The local npm session is missing or expired. Run `npm login` and re-try.
