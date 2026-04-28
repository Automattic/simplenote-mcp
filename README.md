# simplenote-mcp

An MCP (Model Context Protocol) server that gives any MCP-compatible AI tool access to your [Simplenote](https://simplenote.com/) data — read by default, with opt-in write tools (create, update, trash, restore, revert) when you run `simplenote-mcp setup` with write mode enabled.

On macOS, it can read directly from the local Simplenote desktop app's Core Data store — fully offline, no auth. On Linux and Windows (and on macOS without the desktop app), it talks to the Simperium HTTP API after a one-time `simplenote-mcp setup`.

Works with Claude Desktop, Claude Code, Cursor, VS Code (Copilot), Zed, Cline, Windsurf, and anything else that speaks MCP.

## Quick start

Run setup once:

```bash
npx -y simplenote-mcp setup
```

On macOS with the [Simplenote desktop app](https://simplenote.com/) installed and synced, setup detects the local database and asks whether to use it. Accepting that option is fully offline and read-only. On Linux, Windows, or macOS without the desktop app, setup prompts for your Simplenote email, sends an auth code, then asks for the code and whether to enable write mode.

Then point your MCP client at the server.

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "simplenote": {
      "command": "npx",
      "args": ["-y", "simplenote-mcp"]
    }
  }
}
```

Restart the client and ask it to list your tags.

## Requirements

- Node.js 22+
- One of:
  - **macOS:** the [Simplenote desktop app](https://simplenote.com/) installed and synced, **or**
  - Any platform: a Simplenote account (you'll run `simplenote-mcp setup` once)

## Install

Most users don't need to install anything manually — `npx -y simplenote-mcp` in the MCP config does it on first use.

If you prefer a global install (faster startup, no cold-cache download on first use):

```bash
npm install -g simplenote-mcp
```

Then reference `simplenote-mcp` directly as the `command` in your MCP config.

## Setup and Authentication

Run setup once to create `config.json`. Native macOS setup does not require Simplenote authentication; API setup does.

### One-time setup

```bash
npx -y simplenote-mcp setup
```

If a local macOS Simplenote database is detected, setup offers to use it and writes `config.json` with `source: "local"`.

Otherwise, setup checks for an existing token in `auth.json`. If one is already stored, setup reuses it and only asks whether to enable write mode. If no token is stored, setup prompts for your Simplenote email, sends a magic-link email containing a short auth code, prompts for the code, and then asks whether to enable write mode. On success, it writes `config.json` and stores the token with mode `0600` in `auth.json`.

| Platform | Path |
|----------|------|
| macOS    | `~/Library/Application Support/simplenote-mcp/auth.json` |
| Linux    | `$XDG_CONFIG_HOME/simplenote-mcp/auth.json` (default `~/.config/simplenote-mcp/auth.json`) |
| Windows  | `%APPDATA%\simplenote-mcp\auth.json` |

`config.json` and `telemetry.json` live in the same `simplenote-mcp` config directory.

To remove the stored token:

```bash
npx -y simplenote-mcp logout
```

### Headless / CI

Skip `auth.json` by exporting the token directly:

```bash
SIMPLENOTE_TOKEN=<token> npx -y simplenote-mcp
```

The env var bypasses `auth.json`.

`SIMPLENOTE_TOKEN` does not bypass `config.json`; the server still needs config to know whether to use the local store or the API provider. For headless environments, create `config.json` in the same platform-specific config directory listed above:

```json
{
  "source": "api",
  "writeMode": false
}
```

Set `writeMode` to `true` only when you want write tools exposed.

### Token lifetime

Magic-link tokens appear sticky per user (requesting a new code often returns the same token until invalidated server-side). No expiry has been observed in normal use; treat any 401 from the Simperium API as "remove the old token and run setup again." There is no automatic refresh — magic-link auth requires user interaction. The authentication endpoint is rate-limited (repeated failures lock the IP out for ~10 minutes), so don't script repeated attempts.

## Configuration

All MCP clients converge on the same `{ command, args, env }` shape. The only things that differ between them are the config file location and the top-level key (`mcpServers` vs. `servers` vs. `context_servers`).

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

```json
{
  "mcpServers": {
    "simplenote": {
      "command": "npx",
      "args": ["-y", "simplenote-mcp"]
    }
  }
}
```

Run `npx -y simplenote-mcp setup` once in a terminal before starting the client.

Restart Claude Desktop to pick up config changes. See [Windows notes](#windows-notes) below for Windows-specific quirks.

### Claude Code

The easy path is the CLI:

```bash
claude mcp add simplenote -- npx -y simplenote-mcp
```

Or edit `~/.claude.json` / project `.mcp.json` with the same JSON shape as Claude Desktop above.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project). Same JSON shape as Claude Desktop.

### VS Code (GitHub Copilot)

User config via **Command Palette → "MCP: Open User Configuration"**, or per-project `.vscode/mcp.json`. Note: VS Code uses `servers` at the top level, not `mcpServers`.

```json
{
  "servers": {
    "simplenote": {
      "command": "npx",
      "args": ["-y", "simplenote-mcp"]
    }
  }
}
```

### Zed

In Zed's `settings.json`:

```json
{
  "context_servers": {
    "simplenote": {
      "command": {
        "path": "npx",
        "args": ["-y", "simplenote-mcp"]
      }
    }
  }
}
```

Zed uses a different schema — `context_servers` with a nested `command` object.

### Cline

Open the Cline MCP Servers panel → edit `cline_mcp_settings.json`. Same JSON shape as Claude Desktop (`mcpServers` top-level key).

### Windsurf

`~/.codeium/windsurf/mcp_config.json`. Same JSON shape as Claude Desktop.

### Custom store path (macOS)

If your local Simplenote data is not at the default path:

1. Open Finder, press `Cmd+Shift+G`, paste `~/Library/Group Containers/`
2. Look for a folder starting with `com.automattic.SimplenoteMac` (typically prefixed like `PZYM8XX95Q.`)
3. Navigate to `Data/Simplenote.storedata`

Then pass `--path`:

```json
{
  "mcpServers": {
    "simplenote": {
      "command": "npx",
      "args": [
        "-y",
        "simplenote-mcp",
        "--path",
        "/path/to/Simplenote.storedata"
      ]
    }
  }
}
```

`--path` always forces the native provider, even if a token is configured.

## Telemetry

Simplenote MCP sends anonymous usage events to Automattic. A random UUID is stored in `telemetry.json` under the same config directory as `config.json` and is sent as `_ui` with `_ut=simplenote:local_uuid`.

Tracked events are limited to setup choices (`type`, OS family, write mode, and auth method for API setup) and tool calls (`tool`, provider, success/failure). Note IDs, note content, tags, search queries, Simplenote account details, and tokens are never sent.

To opt out for one run, set:

```bash
SIMPLENOTE_MCP_DISABLE_TELEMETRY=1 npx -y simplenote-mcp
```

To persistently opt out:

```bash
npx simplenote-mcp disable-telemetry
```

When running from a local checkout after building, `node server.js disable-telemetry` works too.

## Provider resolution

The server chooses a data source from `config.json`, except when `--path` is provided:

1. `--path <file>` — forces the native macOS provider against the given store file
2. `source: "local"` — uses the default macOS Simplenote store, read-only
3. `source: "api"` plus `auth.json` or `SIMPLENOTE_TOKEN` — uses the Simperium API provider
4. Missing or malformed config — exits with an actionable `simplenote-mcp setup` message

Run `simplenote-mcp setup` to create or replace the config. A token alone is not enough to select the API provider.

## Available tools

The basic read tools are available for whichever provider is configured. Native macOS mode is local and read-only. Write tools and version-history tools require the Simperium API provider; in the current server they are exposed when API write mode is enabled.

### list_tags

List all tags in your Simplenote account.

**Parameters:** None

**Returns:** Array of `{name, index}` sorted by index

### list_notes

List recent notes, optionally filtered by tag.

**Parameters:**
- `tag` (string, optional) — filter by tag name
- `limit` (number, optional, default: 20, max: 100) — max notes to return
- `include_deleted` (boolean, optional, default: false) — include trashed notes

**Returns:** Array of `{id, title, tags, pinned, modified, deleted}` sorted by pinned status then modification date

### search_notes

Search notes by content, title, or tags.

**Parameters:**
- `query` (string, required) — search term (case-insensitive)
- `limit` (number, optional, default: 10, max: 100) — max results
- `include_deleted` (boolean, optional, default: false) — include deleted notes

**Returns:** Array of `{id, title, tags, snippet, modified, deleted}`

### get_note

Get the full content of a specific note.

**Parameters:**
- `id` (string, required) — note ID (simperiumkey)
- `include_deleted` (boolean, optional, default: false) — allow retrieving deleted notes

**Returns:** `{id, content, tags, pinned, markdown, deleted, created, modified}`

### create_note

Create a new note. Write tool — requires write mode enabled in `simplenote-mcp setup` and the Simperium API provider.

**Parameters:**
- `content` (string, required) — note content (first line becomes title)
- `tags` (array of strings, optional) — tags to attach
- `markdown` (boolean, optional, default: true) — enable markdown rendering
- `pinned` (boolean, optional, default: false) — pin to top of list

**Returns:** `{success, id, version, title}`

### update_note

Update an existing note. Write tool — requires write mode and the Simperium API provider.

**Important:** `content` and `tags` replace the existing values in full. When changing only part of a note, call `get_note` first and pass the merged content back. A partial value will erase the rest.

**Parameters:**
- `id` (string, required) — note ID
- `content` (string, optional) — new note content
- `tags` (array of strings, optional) — replace the tag list (provide the full list)
- `markdown` (boolean, optional) — enable/disable markdown rendering
- `pinned` (boolean, optional) — pin/unpin

At least one of `content`, `tags`, `markdown`, or `pinned` must be provided.

**Returns:** `{success, id, version}`

### trash_note

Soft-delete a note (move to Simplenote trash). The note stays in the bucket and can be restored from any Simplenote client. Write tool — requires write mode and the Simperium API provider.

**Parameters:**
- `id` (string, required) — note ID

**Returns:** `{success, id, title, trashed_at}`

### restore_note

Restore a previously-trashed note so it reappears in active lists. Inverse of `trash_note`. Write tool — requires write mode and the Simperium API provider.

**Parameters:**
- `id` (string, required) — note ID

**Returns:** `{success, id, title, restored_at}`

### get_note_history

List recent versions of a note with short content previews. Read-only operation; requires the Simperium API provider with write mode enabled in the current server.

**Parameters:**
- `id` (string, required) — note ID
- `limit` (number, optional, default: 10, max: 25) — max versions to return

**Returns:** `{id, current_version, entries: [{version, modified_at, content_preview}]}` sorted current-first. Versions outside Simperium's retention window are silently dropped — non-contiguous `version` numbers signal the gap.

### get_note_version

Get the full content of a specific historical version of a note. Read-only operation; requires the Simperium API provider with write mode enabled in the current server. Use to preview content before calling `revert_note`.

**Parameters:**
- `id` (string, required) — note ID
- `version` (number, required) — version number (positive integer)

**Returns:** `{id, version, content, tags, pinned, markdown, deleted, created, modified}`. Throws `version_not_found` if the version is outside Simperium's retention window.

### revert_note

Restore a note to a prior version. Counts toward the write-rate budget. Bypasses the trashed-note guard — reverting to a non-trashed version will un-trash; reverting to a trashed version will re-trash.

Recommended flow: `get_note_history` → `get_note_version` (to preview) → `revert_note`.

**Parameters:**
- `id` (string, required) — note ID
- `version` (number, required) — target version to restore (positive integer)

**Returns:** `{success, id, reverted_from_version, new_version, no_op}`. `no_op: true` means the target version was identical to current — no write was performed and no rate-budget consumed.

Requires write-mode enabled in `simplenote-mcp setup`. Retention is determined by Simperium and not configurable from the client.

## Example usage

Once configured, you can ask your AI client things like:

- "List my Simplenote tags"
- "Show my recent notes"
- "Search my notes for 'recipe'"
- "Show notes tagged 'ideas'"
- "Get the full content of note [id]"
- "Show me the version history of [note title]"
- "Show me what version 42 of that note looked like"
- "Revert that note to the previous version"

Write tools (create, update, trash, restore, revert) are off by default and only available with the Simperium API provider. Run `simplenote-mcp setup` and opt in to enable them. Native macOS data is cached in memory and refreshed when the store file changes; Simperium API responses are cached for 60 seconds, with stale-cache fallback if the API is briefly unreachable.

## Windows notes

A few Windows-specific quirks worth knowing:

- **Wrap `npx` in `cmd /c`** for Claude Desktop. Its child-process launcher doesn't always find `npx.cmd` on PATH otherwise:

  ```json
  {
    "mcpServers": {
      "simplenote": {
        "command": "cmd",
        "args": ["/c", "npx", "-y", "simplenote-mcp"]
      }
    }
  }
  ```

- **Claude Desktop `%APPDATA%` expansion** can silently fail in some versions. If the server can't find its config dir, set `APPDATA` explicitly in the `env` block:

  ```json
  "env": {
    "APPDATA": "C:\\Users\\<you>\\AppData\\Roaming"
  }
  ```

- **Paths with backslashes** in JSON must be escaped (`"C:\\Users\\..."`). Forward slashes also work (`"C:/Users/..."`) and are less error-prone.

## Troubleshooting

**"No configuration found. Run `simplenote-mcp setup`..."**
Run `npx -y simplenote-mcp setup` once before starting your MCP client.

**"Not logged in. Run `simplenote-mcp setup`..."**
You're on the Simperium API path without a token. Run `npx -y simplenote-mcp setup` in a terminal.

**"Token rejected."**
The token may have been invalidated server-side. Run `npx -y simplenote-mcp logout`, then `npx -y simplenote-mcp setup`.

**Tools list empty / "Simplenote store not found"**
On macOS the default path is `~/Library/Group Containers/PZYM8XX95Q.com.automattic.SimplenoteMac/Data/Simplenote.storedata`. If your store lives elsewhere, pass `--path`. If you don't have the desktop app, switch to the API path with `simplenote-mcp setup`.

**First tool call is very slow**
`npx -y` downloads the package on first use. On slow networks this can exceed the MCP client's startup timeout (~10s). Either wait for it to warm up, or install globally once: `npm install -g simplenote-mcp` and change `"command": "npx"` to `"command": "simplenote-mcp"` (drop the args).

**"command not found: npx" / "spawn npx ENOENT" on Windows**
See the `cmd /c` wrapping in [Windows notes](#windows-notes).

**Setup emails aren't arriving**
Check spam. The authentication endpoint is rate-limited — multiple failures in quick succession will lock the IP out for ~10 minutes. Wait, then try again.

**Everything looks fine but data seems stale**
Simperium responses are cached for 60 seconds; the native macOS provider refreshes when the store file's mtime changes. Wait a minute, or restart the MCP client to force a re-fetch.

## Development

Source lives in `src/`, compiled output in `dist/`.

```bash
git clone https://github.com/Automattic/simplenote-mcp.git
cd simplenote-mcp
npm install          # installs deps + builds via `prepare`
npm test             # runs the test suite
npm run typecheck    # tsc --noEmit
npm run build        # tsc + chmod +x on the bin
```

### Testing locally with MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) gives you a browser UI for an MCP server — it lists the tools, prompts, and resources the server exposes, lets you call them with arbitrary arguments, and prints the raw JSON-RPC on both sides. Useful when you want to exercise a code change without wiring the server into a real client.

**Run against the local build:**

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/server.js
```

Open the URL it prints and click **Connect**.

**Run from source without rebuilding** (fastest iteration — uses `tsx`):

```bash
npx @modelcontextprotocol/inspector npx tsx src/server.ts
```

**Test the published npm package** (exactly what users get):

```bash
npx @modelcontextprotocol/inspector npx -y simplenote-mcp
```

**Pick a provider explicitly:**

- Force the native macOS provider against a custom store (overrides config):
  ```bash
  npx @modelcontextprotocol/inspector node dist/server.js --path /path/to/Simplenote.storedata
  ```
- Use the Simperium API provider — requires `simplenote-mcp setup` to have been run with API mode selected first, which writes a config with `source: 'api'` and an `auth.json` token. Inspector then picks the API provider automatically. To use a different token for the session, export `SIMPLENOTE_TOKEN` before launching Inspector (overrides `auth.json`), or paste it into the Inspector UI's **Environment Variables** panel.

Inspector spawns the server as a subprocess over stdio, so anything that works in a real MCP client config works here — including `--path`, env vars, and alternate Node binaries.

`server.js` at the repo root is a thin shim that imports `dist/server.js`, kept stable for users who wired up configs pointing at the local clone before the npm package existed.

## License

MIT
