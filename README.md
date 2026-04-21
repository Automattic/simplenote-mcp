# simplenote-mcp

An MCP (Model Context Protocol) server that provides read access to your Simplenote data. Use it with any MCP-compatible AI tool to search and retrieve your notes.

On macOS it reads directly from the local Simplenote desktop app's Core Data store. On Windows and Linux it talks to the Simperium HTTP API after a one-time `simplenote-mcp login`.

## Requirements

- Node.js 22+
- One of:
  - **macOS:** [Simplenote](https://simplenote.com/) desktop app installed and synced (offline, no auth needed), **or**
  - Any platform: a Simplenote account + the Simperium production app ID (see [Authentication](#authentication))

## Installation

```bash
npm install github:Automattic/simplenote-mcp
```

Or clone and install locally:

```bash
git clone https://github.com/Automattic/simplenote-mcp.git
cd simplenote-mcp
npm install
```

`npm install` runs `tsc` automatically (via the `prepare` script) and produces the `dist/` build.

## Authentication

Skip this section if you only intend to use the native macOS data source.

### One-time login

```bash
node /path/to/simplenote-mcp/server.js login
```

Prompts for your Simplenote email, sends a magic-link email containing a short auth code, then prompts for the code. On success, the token is written with mode `0600` to:

| Platform | Path |
|----------|------|
| macOS    | `~/Library/Application Support/simplenote-mcp/auth.json` |
| Linux    | `$XDG_CONFIG_HOME/simplenote-mcp/auth.json` (default `~/.config/simplenote-mcp/auth.json`) |
| Windows  | `%APPDATA%\simplenote-mcp\auth.json` |

To remove the stored token: `node server.js logout`.

### Simperium app ID

The Simperium HTTP API requires the production Simplenote `app_id`. The default baked into this repo (`history-analyst-dad`) is the public **testing** app shipped in the open-source [`simplenote-macos`](https://github.com/Automattic/simplenote-macos) sources and **will not work** with tokens issued by `app.simplenote.com`. Provide the production value via env var:

```bash
SIMPLENOTE_APP_ID=<production-app-id> node server.js
```

The production ID is publicly visible on the wire from any official Simplenote client; it is not committed here so this repository remains safe to fork.

### Headless / CI

Skip the file entirely by exporting the token directly:

```bash
SIMPLENOTE_TOKEN=<token> SIMPLENOTE_APP_ID=<app-id> node server.js
```

The env var bypasses `auth.json`. Prefer it over a CLI flag — argv values appear in `ps` output and shell history.

### Token lifetime

Magic-link tokens appear sticky per user (re-running `login` returns the same token until invalidated server-side). No expiry has been observed in normal use; treat any 401 from the Simperium API as "re-run `login`." There is no automatic refresh — magic-link auth requires user interaction. `/account/request-login` likely has anti-abuse throttling, so don't script repeated logins.

## Provider Resolution

The server picks a data source automatically:

1. `--path <file>` — forces the native macOS provider against the given store file
2. macOS, with the Simplenote app's default Core Data store present — native provider
3. A token is available (file or `SIMPLENOTE_TOKEN`) — Simperium API provider
4. Otherwise — exits with an actionable error message

This means a macOS user with the desktop app installed gets fully offline access with no setup, while Windows/Linux users get the API path after `login`.

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your platform:

**macOS, native data source (no auth required):**

```json
{
  "mcpServers": {
    "simplenote": {
      "command": "node",
      "args": ["/path/to/simplenote-mcp/server.js"]
    }
  }
}
```

**Any platform, Simperium API:**

```json
{
  "mcpServers": {
    "simplenote": {
      "command": "node",
      "args": ["/path/to/simplenote-mcp/server.js"],
      "env": {
        "SIMPLENOTE_APP_ID": "<production-app-id>"
      }
    }
  }
}
```

Run `node /path/to/simplenote-mcp/server.js login` once before starting the MCP client.

### Claude Code

Add the same `mcpServers` block to `~/.claude/settings.json`.

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
      "command": "node",
      "args": [
        "/path/to/simplenote-mcp/server.js",
        "--path",
        "/path/to/Simplenote.storedata"
      ]
    }
  }
}
```

`--path` always forces the native provider, even if a token is configured.

## Available Tools

### list_tags

List all tags in your Simplenote account.

**Parameters:** None

**Returns:** Array of `{name, index}` sorted by index

### list_notes

List recent notes, optionally filtered by tag.

**Parameters:**
- `tag` (string, optional) - Filter by tag name
- `limit` (number, optional, default: 20) - Max notes to return

**Returns:** Array of `{id, title, tags, pinned, modified}` sorted by pinned status then modification date

### search_notes

Search notes by content, title, or tags.

**Parameters:**
- `query` (string, required) - Search term (case-insensitive)
- `limit` (number, optional, default: 10) - Max results
- `include_deleted` (boolean, optional, default: false) - Include deleted notes

**Returns:** Array of `{id, title, tags, snippet, modified, deleted}`

### get_note

Get the full content of a specific note.

**Parameters:**
- `id` (string, required) - Note ID (simperiumkey)
- `include_deleted` (boolean, optional, default: false) - Allow retrieving deleted notes

**Returns:** `{id, content, tags, pinned, markdown, deleted, created, modified}`

## Example Usage

Once configured, you can ask Claude things like:

- "List my Simplenote tags"
- "Show my recent notes"
- "Search my notes for 'recipe'"
- "Show notes tagged 'ideas'"
- "Get the full content of note [id]"

The server is read-only and does not modify your notes. Native macOS data is cached in memory and refreshed when the store file changes; Simperium API responses are cached for 60 seconds (with stale-cache fallback if the API is briefly unreachable).

## Development

Source lives in `src/`, compiled output in `dist/`. Useful scripts:

```bash
npm run build       # tsc
npm run typecheck   # tsc --noEmit
```

`server.js` at the repo root is a thin shim that imports `dist/server.js`, kept stable so existing client configs keep working.

## License

MIT
