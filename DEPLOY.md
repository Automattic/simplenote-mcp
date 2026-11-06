# Deploying

This document covers releasing a new version of `@automattic/simplenote-mcp` to npm and the official MCP Registry.

Releases happen in GitHub Actions; nothing is published from a local machine and no tokens are stored. A release has two steps:

1. **Release PR**: a reviewed PR bumps the version on `main`.
2. **Release workflow**: [`.github/workflows/release.yml`](.github/workflows/release.yml), started by hand, publishes that version. In order, it:
   1. Publishes to npm using [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, with provenance).
   2. Creates the `v<version>` tag and GitHub release.
   3. Publishes `server.json` to the MCP Registry, logging in with GitHub OIDC.

## 1. Open the release PR

Ask a coding agent to "prepare a release". The [`release-pr` skill](.claude/skills/release-pr/SKILL.md) works out what changed, suggests a version, bumps it, and opens the PR with release notes.

To do it by hand, follow the skill's steps. In short:

1. Bump the version in **five** fields, which must all match:
   - `package.json`: `version`
   - `package-lock.json`: top-level `version` and `packages[""].version`
   - `server.json`: top-level `version` and `packages[0].version`

   `npm version <version> --no-git-tag-version` handles the first three.
2. The version must be the next patch, minor, or major after the highest version ever published to npm. For example, after 2.0.1 it must be 2.0.2, 2.1.0, or 3.0.0. Versions that were unpublished still count, because npm never lets a version number be reused.
3. Check the PR:

   ```bash
   node --import tsx scripts/check-release-version.ts   # the same gate the workflow runs
   npm run typecheck
   npm test
   npm run build
   ```

4. Put release notes in the PR description. The GitHub release links back to the PR.
5. Get the PR reviewed and merge it.

`package.json` `mcpName` and `server.json` `name` must stay identical, byte for byte. The MCP Registry rejects any difference, including case. This repository's name is `io.github.Automattic/simplenote-mcp` with a capital `A`, GitHub's canonical casing for the org.

## 2. Run the Release workflow

From GitHub, go to **Actions → Release → Run workflow**, choose `main`, and run it. Or from the command line:

```bash
gh workflow run release.yml --ref main
gh run watch
```

The workflow only runs from `main`. Both a step in the workflow and the `npm-publish` environment's branch rule enforce this. The workflow:

1. Runs `npm ci`, `npm audit signatures`, typecheck, and tests.
2. Runs `scripts/check-release-version.ts`, which fails unless:
   - all five version fields match, and
   - the version is the next patch, minor, or major after the highest version published to npm.
3. Runs `npm publish`.
4. Creates the GitHub release `v<version>` on the merged commit. Its notes are GitHub's auto-generated notes, with a link to the release PR at the top. The release creates a lightweight tag that points at the merge commit GitHub signed, so it shows as Verified.
5. Waits for the version to appear on npm, then runs `mcp-publisher publish`. The registry checks the published package's `mcpName`, so this has to come after npm.

### Re-running

Every step skips itself if its work is already done:

- the npm publish skips if the version is already on npm;
- the GitHub release skips if it already exists;
- the MCP Registry publish skips if the registry already lists the version.

If a run fails partway, fix the cause and run the workflow again. When a re-run finds the version already on npm, the GitHub release targets the commit npm recorded for it, not the current `main`.

### Fixes for an older major version

Releasing a fix for an older major version, such as 2.1.1 after 3.0.0, isn't supported yet. The version check rejects it. Supporting it would take:

- **A maintenance branch** such as `release/2.x`, with branch protection like `main`'s, allowed by the "Require main" step and the `npm-publish` environment's branch rule.
- **A separate npm dist-tag**, such as `npm publish --tag latest-2`, so `latest` stays on the newest major.
- **`gh release create --latest=false`**, so the GitHub release doesn't take the "Latest" badge.
- **A version rule for that branch:** the next patch, minor, or major after the highest published version below the new one. For 2.1.1, that's 2.1.0.

The MCP Registry needs no change. It picks its latest version by semver, not by publish date.

A published npm version can't be replaced. If the wrong content goes out, ship a follow-up version. GitHub releases are immutable too (see below): a release's notes can be edited, but deleting it doesn't free its tag name for reuse.

### 3. Verify

```bash
curl -s https://registry.npmjs.org/@automattic%2fsimplenote-mcp | jq -r '."dist-tags".latest'
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.Automattic%2Fsimplenote-mcp/versions/latest" | jq -r '.server.version'
gh release view --json tagName,url
```

All three should report the new version.

## One-time setup

These are already in place. They are recorded here in case they need to be recreated or audited.

- **GitHub environment.** An environment named `npm-publish` (**Settings → Environments**) has a deployment branch rule that allows only `main`. It has no required reviewers. The workflow's job runs in this environment.
- **npm trusted publisher.** Configure it on npmjs.com under **`@automattic/simplenote-mcp` → Settings → Trusted Publisher → GitHub Actions**:

  | Field | Value |
  |---|---|
  | Organization or user | `Automattic` |
  | Repository | `simplenote-mcp` |
  | Workflow filename | `release.yml` |
  | Environment | `npm-publish` |

  Renaming the workflow file or the environment breaks publishing until this is updated. Trusted publishing needs npm 11.5.1 or newer; the workflow uses the Node version in `.nvmrc`, and its bundled npm is new enough.
- **npm publishing access.** Set to "Require two-factor authentication and disallow tokens", so only the trusted publisher can publish.
- **Immutable releases.** Enabled under **Settings → General → Releases**. Once a release is published, its tag can't be moved or deleted, and GitHub adds a signed attestation for it. Releases from before this was enabled (v2.0.1) are not immutable.
- **MCP Registry.** Needs no setup. `mcp-publisher login github-oidc` gets permission for the `io.github.Automattic/*` namespace because the workflow runs in an `Automattic` repository.
- **`mcp-publisher` version.** The workflow pins a version and its SHA-256 checksum (`MCP_PUBLISHER_VERSION` / `MCP_PUBLISHER_SHA256`). To upgrade, take both values from the [registry's releases](https://github.com/modelcontextprotocol/registry/releases): the checksum is the `mcp-publisher_linux_amd64.tar.gz` line in `registry_<version>_checksums.txt`.

## Troubleshooting

### `npm publish` fails with `404`, `ENEEDAUTH`, or an OIDC error

npm didn't accept the workflow as a trusted publisher. Check that the trusted publisher settings above match exactly: the organization, repository, workflow filename, and environment name. Also check that the run came from `main`. npm returns `404` instead of `403` when it refuses a publish.

### Version check fails

The log lists either the mismatched fields or the versions that would be accepted. Fix the version in a new PR.

### `403 Forbidden` from `mcp-publisher publish`

The error lists the namespace prefixes the OIDC login was granted. `server.json` `name` must match one of them exactly, including the casing `io.github.Automattic`.

### `400 Bad Request` with `mcpName` mismatch

`server.json` `name` doesn't match the `mcpName` in the published npm package. A published version can't be republished, so:

1. Fix `mcpName` in `package.json`.
2. Release a new version.
