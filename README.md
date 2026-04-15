# simplenote-mcp

An MCP (Model Context Protocol) server that provides read access to your local Simplenote data on macOS. Use it with any MCP-compatible AI tool to search and retrieve your notes.

## Requirements (for now)

- macOS
- Node.js 22+
- [Simplenote](https://simplenote.com/) desktop app installed and synced

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

## Example Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

### Claude Code

Add to `~/.claude/settings.json`:

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

### Custom Store Path

If the server can't find your Simplenote data automatically, you can specify the path manually.

**To find your `Simplenote.storedata` file:**

1. Open Finder
2. Press `Cmd+Shift+G` to open "Go to Folder"
3. Paste: `~/Library/Group Containers/`
4. Look for a folder starting with `com.automattic.SimplenoteMac` (it may have a prefix like `PZYM8XX95Q.`)
5. Navigate to `Data/Simplenote.storedata`

Then use the `--path` argument in your config:

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

This server reads directly from Simplenote's local Core Data XML store on macOS. It's read-only and doesn't modify your notes. The data is cached in memory and refreshed when the store file changes.

## License

MIT
