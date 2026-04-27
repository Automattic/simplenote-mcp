# simplenote-mcp

An MCP (Model Context Protocol) server that gives any MCP-compatible AI tool read access to your [Simplenote](https://simplenote.com/) data.

On macOS, it reads directly from the local Simplenote desktop app's Core Data store — fully offline, no auth. On Linux and Windows (and on macOS without the desktop app), it talks to the Simperium HTTP API after a one-time `simplenote-mcp login`.

Works with Claude Desktop, Claude Code, Cursor, VS Code (Copilot), Zed, Cline, Windsurf, and anything else that speaks MCP.

## Quick start

For macOS users with the [Simplenote desktop app](https://simplenote.com/) already installed and synced — no login required, no env vars, just point your MCP client at it.

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

Restart the client and ask it to list your tags. That's it.

For Linux / Windows, or macOS without the desktop app, see [Authentication](#authentication) for the one-time login step, then apply the same config.

## Requirements

- Node.js 22+
- One of:
  - **macOS:** the [Simplenote desktop app](https://simplenote.com/) installed and synced, **or**
  - Any platform: a Simplenote account (you'll run `simplenote-mcp login` once)

## Install

Most users don't need to install anything manually — `npx -y simplenote-mcp` in the MCP config does it on first use.

If you prefer a global install (faster startup, no cold-cache download on first use):

```bash
npm install -g simplenote-mcp
```

Then reference `simplenote-mcp` directly as the `command` in your MCP config.

## Authentication

Skip this section if you only intend to use the native macOS data source.

### One-time login

```bash
npx simplenote-mcp login
```

Prompts for your Simplenote email, sends a magic-link email containing a short auth code, then prompts for the code. On success, a token is written with mode `0600` to:

| Platform | Path |
|----------|------|
| macOS    | `~/Library/Application Support/simplenote-mcp/auth.json` |
| Linux    | `$XDG_CONFIG_HOME/simplenote-mcp/auth.json` (default `~/.config/simplenote-mcp/auth.json`) |
| Windows  | `%APPDATA%\simplenote-mcp\auth.json` |

To remove the stored token:

```bash
npx simplenote-mcp logout
```

### Headless / CI

Skip the file entirely by exporting the token directly:

```bash
SIMPLENOTE_TOKEN=<token> npx simplenote-mcp
```

The env var bypasses `auth.json`. Prefer it over a CLI flag — argv values appear in `ps` output and shell history.

### Token lifetime

Magic-link tokens appear sticky per user (re-running `login` returns the same token until invalidated server-side). No expiry has been observed in normal use; treat any 401 from the Simperium API as "re-run `login`." There is no automatic refresh — magic-link auth requires user interaction. The login endpoint is rate-limited (repeated failures lock the IP out for ~10 minutes), so don't script repeated attempts.

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

For the Simperium API path (Linux, Windows, or macOS without the desktop app), run `npx simplenote-mcp login` once in a terminal before starting the client.

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

If the server can't find your Simplenote data automatically:

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

The server picks a data source automatically:

1. `--path <file>` — forces the native macOS provider against the given store file
2. macOS, with the Simplenote app's default Core Data store present — native provider
3. A token is available (file or `SIMPLENOTE_TOKEN`) — Simperium API provider
4. Otherwise — exits with an actionable error message

This means a macOS user with the desktop app gets fully offline access with no setup, while Windows/Linux users get the API path after `login`.

## Available tools

### list_tags

List all tags in your Simplenote account.

**Parameters:** None

**Returns:** Array of `{name, index}` sorted by index

### list_notes

List recent notes, optionally filtered by tag.

**Parameters:**
- `tag` (string, optional) — filter by tag name
- `limit` (number, optional, default: 20, max: 100) — max notes to return

**Returns:** Array of `{id, title, tags, pinned, modified}` sorted by pinned status then modification date

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

### get_note_history

List recent versions of a note with short content previews. Read-only.

**Parameters:**
- `id` (string, required) — note ID
- `limit` (number, optional, default: 10, max: 25) — max versions to return

**Returns:** `{id, current_version, entries: [{version, modified_at, content_preview}]}` sorted current-first. Versions outside Simperium's retention window are silently dropped — non-contiguous `version` numbers signal the gap.

### get_note_version

Get the full content of a specific historical version of a note. Read-only. Use to preview content before calling `revert_note`.

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

The server is read-only and does not modify your notes. Native macOS data is cached in memory and refreshed when the store file changes; Simperium API responses are cached for 60 seconds, with stale-cache fallback if the API is briefly unreachable.

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

**"Not logged in. Run `simplenote-mcp login`..."**
You're on the Simperium API path without a token. Run `npx simplenote-mcp login` in a terminal.

**"Token rejected."**
The token may have been invalidated server-side. Re-run `npx simplenote-mcp login`.

**Tools list empty / "Simplenote store not found"**
On macOS the default path is `~/Library/Group Containers/PZYM8XX95Q.com.automattic.SimplenoteMac/Data/Simplenote.storedata`. If your store lives elsewhere, pass `--path`. If you don't have the desktop app, switch to the API path with `simplenote-mcp login`.

**First tool call is very slow**
`npx -y` downloads the package on first use. On slow networks this can exceed the MCP client's startup timeout (~10s). Either wait for it to warm up, or install globally once: `npm install -g simplenote-mcp` and change `"command": "npx"` to `"command": "simplenote-mcp"` (drop the args).

**"command not found: npx" / "spawn npx ENOENT" on Windows**
See the `cmd /c` wrapping in [Windows notes](#windows-notes).

**Login emails aren't arriving**
Check spam. The login endpoint is rate-limited — multiple failures in quick succession will lock the IP out for ~10 minutes. Wait, then try again.

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
