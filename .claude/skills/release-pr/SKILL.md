---
name: release-pr
description: Prepare a simplenote-mcp release by opening the version-bump PR. Use when the user asks to cut, prepare, start, or bump a release or new version of @automattic/simplenote-mcp. It does not publish anything; publishing happens in the Release workflow after the PR is merged.
---

# Release PR

Open the pull request that bumps `@automattic/simplenote-mcp` to its next version. Publishing is done afterwards by `.github/workflows/release.yml`; `DEPLOY.md` is the full runbook. Never run `npm publish`, `npm login`, or `mcp-publisher` locally.

## 1. Check the starting point

- The working tree is clean and on an up-to-date `main` (`git switch main && git pull --ff-only`). Stop and ask if it is not.
- `gh auth status` succeeds.

## 2. Find what changed since the last release

Query the public registry directly (the user's machine may route `npm` through a proxy and is not logged in to npm):

```bash
curl -s https://registry.npmjs.org/@automattic%2fsimplenote-mcp \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=j["dist-tags"].latest;console.log(v, j.versions[v].gitHead)})'
```

This prints the latest version and the commit it was published from. List what has landed since, using that commit (it works even if tags are missing):

```bash
git log --oneline <gitHead>..main
```

If `package.json` on `main` already has a version newer than npm's latest, an earlier release PR was merged but never published. Stop and tell the user to run the Release workflow instead.

## 3. Choose the version

Recommend patch, minor, or major from the changes, following semver for the package's users (MCP clients and people running `npx`):

- **major**: breaking changes, such as removing or renaming tools, changing tool input/output shapes incompatibly, raising the minimum Node version (`engines`), or changing setup/config in a way that requires user action.
- **minor**: new tools, new options, or other backward-compatible features.
- **patch**: fixes, dependency updates, docs, and internal changes.

Show the user the list of changes and your recommendation, and confirm the version before editing anything. The Release workflow only accepts the exact next patch, minor, or major after npm's latest; anything else needs its `skip_increment_check` input, so call that out if the user wants a different number.

## 4. Bump the version

```bash
git switch -c release/v<version>
npm version <version> --no-git-tag-version
node -e 'const fs=require("fs");const f="server.json";const j=JSON.parse(fs.readFileSync(f,"utf8"));j.version=j.packages[0].version=process.argv[1];fs.writeFileSync(f,JSON.stringify(j,null,"\t")+"\n")' <version>
```

`npm version` updates `package.json` and both version fields in `package-lock.json`. The `node -e` line updates both version fields in `server.json` and keeps its tab indentation. `git diff` should show only those five version lines changing.

## 5. Verify

```bash
node --import tsx scripts/check-release-version.ts
npm run typecheck
npm test
npm run build
```

The first command is the same gate the Release workflow runs. It should report the version as ready to publish.

## 6. Commit, push, and open the PR

```bash
git commit -am "Release v<version>"
git push -u origin release/v<version>
```

Open the PR with `gh pr create --title "Release v<version>"`, filling in the sections of `.github/PULL_REQUEST_TEMPLATE.md`:

- **Proposed Changes**: the version bump, plus release notes. Group the changes since the last release by user impact (for example *New*, *Fixed*, *Changed*, *Internal*), one line each with its PR number. Describe what users will notice rather than restating commit titles. Call out anything users must do when upgrading.
- **Why**: why this is a patch, minor, or major release.
- **Testing**: the verification commands from step 5 and their results.

The GitHub release links back to this PR, so these notes are the detailed changelog for the release.

## 7. Tell the user what happens next

1. Get the PR reviewed and merge it.
2. Run the **Release** workflow from `main`: Actions → Release → Run workflow, or `gh workflow run release.yml --ref main`, then `gh run watch`.
3. The workflow publishes to npm, creates the `v<version>` GitHub release, and publishes to the MCP Registry. If it fails partway, fix the cause and run it again; steps that already succeeded are skipped.
