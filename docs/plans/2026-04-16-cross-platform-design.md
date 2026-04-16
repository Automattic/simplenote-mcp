# Cross-Platform Support Design

## Overview

Add Windows and Linux support to simplenote-mcp. Currently the MCP server only works on macOS, reading directly from the native Simplenote app's Core Data XML store. The cross-platform approach uses a provider architecture: macOS keeps its native parser, while Windows and Linux use the Simperium HTTP API (the sync backend all Simplenote clients use).

## Architecture

### Provider Interface

Both providers implement the same interface, returning a normalized `{ notes, tags }` shape. The MCP tool handlers are provider-agnostic.

```
┌─────────────────────────────┐
│     MCP Tool Handlers       │
│  (list_tags, list_notes,    │
│   search_notes, get_note)   │
└─────────┬───────────────────┘
          │ calls loadStore()
          ▼
┌─────────────────────────────┐
│     Provider Resolver       │
│  (auto-detect platform +    │
│   available data sources)   │
└────┬───────────────┬────────┘
     ▼               ▼
┌──────────┐  ┌──────────────┐
│  Native  │  │  Simperium   │
│  macOS   │  │  API Client  │
│ (XML)    │  │  (HTTP)      │
└──────────┘  └──────┬───────┘
                     │ reads token from
                     ▼
              ┌──────────────┐
              │  Electron    │
              │  Token Store │
              │  (LevelDB)   │
              └──────────────┘
```

### Provider Resolution Order

**macOS:**
1. Check for native Core Data store at default path
2. If not found, check for Electron app data and use Simperium API
3. If neither found, error out

**Windows/Linux:**
1. Check for Electron app data, use Simperium API
2. If not found, error out

The `--path` flag continues to force the native macOS provider.

## Normalized Data Model

Both providers return the same shape, eliminating `getAttr()` calls from the tool handlers. Each provider is responsible for converting its native format during normalization — the native macOS provider converts Core Data timestamps (seconds since 2001-01-01) to ISO strings, the Simperium API provider converts Unix timestamps:

```javascript
{
  notes: [
    {
      id: 'abc123',              // simperiumkey
      content: 'Note text...',
      tags: ['recipes', 'saved'],
      pinned: true,
      markdown: true,
      deleted: false,
      created: '2025-01-15T...', // ISO string
      modified: '2025-04-10T...',
    }
  ],
  tags: [
    { name: 'recipes', index: 0 }
  ]
}
```

## Simperium API Provider

### Token Extraction

The Electron app stores its access token in Chromium's Local Storage, persisted as LevelDB:

| Platform | Path |
|----------|------|
| macOS    | `~/Library/Application Support/Simplenote/Local Storage/leveldb/` |
| Windows  | `%APPDATA%/Simplenote/Local Storage/leveldb/` |
| Linux    | `~/.config/Simplenote/Local Storage/leveldb/` |

Use `classic-level` to open the database read-only. If locked (Simplenote is running), copy the LevelDB files to a temp directory and read the copy. The temp copy must be cleaned up after reading (use a try/finally pattern). Note: copying while Simplenote is actively writing could produce a corrupted snapshot — if the copy fails to parse, retry once after a short delay.

For manual token override, support a `SIMPLENOTE_TOKEN` environment variable (preferred over a CLI flag, since CLI args are visible in `ps` output and shell history).

### API Calls

Using Node 22's built-in `fetch`:

- `GET https://api.simperium.com/1/{app_id}/note/index?data=true` - all notes with content
- `GET https://api.simperium.com/1/{app_id}/tag/index?data=true` - all tags
- Header: `X-Simperium-Token: {token}`

The `app_id` is a public identifier shared across all Simplenote clients, embedded as a constant. It originates from the Simperium project configuration and is the same value used by the iOS, Android, macOS, and Electron apps. If it ever changes, we'd update the constant.

### Caching

- **Native macOS provider:** File mtime-based cache (unchanged from current behavior).
- **Simperium API provider:** Time-based cache with 60-second TTL. After expiry, next `loadStore()` call re-fetches from the API. If the API request fails and cached data exists, return stale cache with a warning rather than failing outright. This prevents every tool call from hitting a down API repeatedly.

## File Organization

```
server.js                      # MCP tool handlers + provider resolution
providers/
  native-macos.js              # Core Data XML parser (extracted from current server.js)
  simperium-api.js             # Simperium HTTP client
  token.js                     # Electron Local Storage token extraction
  paths.js                     # Platform-specific path constants
  normalize.js                 # Shared helpers (extractTitle, safeJsonParse, etc.)
```

## Error Handling

- Token not found: "Simplenote Electron app not found. Install Simplenote and sign in."
- API request fails: Return the error, suggest checking network/token.
- Token expired: Suggest re-signing into Simplenote.
- Native store not found on macOS: Fall through to Simperium API provider.

## New Dependencies

- `classic-level` - LevelDB reader for extracting Electron access token

## CLI Changes

- `SIMPLENOTE_TOKEN` env var - Manual token override, bypasses LevelDB extraction
- `--path <value>` - Unchanged, forces native macOS provider

## Decisions Made

- macOS supports both native app and Electron app (prefer native, fall back to Electron/API)
- Windows/Linux use Simperium API exclusively (parsing Chromium IndexedDB directly is too complex)
- Node.js remains a requirement; documenting the dependency is sufficient
- Offline access preserved on macOS via native provider; Windows/Linux require network
