#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'fs';
import { platform } from 'os';
import { z } from 'zod';

import { createNativeProvider } from './providers/native-macos.js';
import { DEFAULT_NATIVE_STORE_PATH } from './providers/paths.js';
import { extractTitle } from './providers/normalize.js';

function parseArgs() {
	const args = process.argv.slice(2);
	let forcedPath = null;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith('--path=')) {
			forcedPath = arg.slice(7);
			if (!forcedPath) {
				console.error('Error: --path= requires a value');
				process.exit(1);
			}
		} else if (arg === '--path') {
			forcedPath = args[i + 1];
			if (!forcedPath || forcedPath.startsWith('--')) {
				console.error('Error: --path requires a value');
				process.exit(1);
			}
			i++;
		}
	}

	return { forcedPath };
}

/**
 * Pick a provider based on platform and available data sources.
 *
 *   --path <p>     → native provider at <p>
 *   macOS          → native if default store exists, else Simperium API
 *   Windows/Linux  → Simperium API
 *
 * The Simperium API branch is a placeholder until the auth/API track lands.
 */
function resolveProvider({ forcedPath }) {
	if (forcedPath) {
		if (!existsSync(forcedPath)) {
			console.error(`Error: Simplenote store not found at: ${forcedPath}`);
			console.error('Check that the --path argument points to a valid Simplenote.storedata file.');
			process.exit(1);
		}
		return createNativeProvider({ storePath: forcedPath });
	}

	const os = platform();

	if (os === 'darwin' && existsSync(DEFAULT_NATIVE_STORE_PATH)) {
		return createNativeProvider({ storePath: DEFAULT_NATIVE_STORE_PATH });
	}

	if (os === 'darwin') {
		console.error(`Error: Simplenote store not found at: ${DEFAULT_NATIVE_STORE_PATH}`);
		console.error('Is Simplenote installed and has it synced at least once?');
		console.error('Remote authentication via `simplenote-mcp login` is not yet available.');
	} else {
		console.error('Error: Windows/Linux support requires the Simperium API provider.');
		console.error('Remote authentication via `simplenote-mcp login` is not yet available.');
	}
	process.exit(1);
}

const { forcedPath } = parseArgs();
const provider = resolveProvider({ forcedPath });

function errorResponse(err) {
	return {
		content: [{ type: 'text', text: `Error: ${err.message}` }],
		isError: true,
	};
}

function jsonResponse(data) {
	return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
	name: 'simplenote',
	version: '1.0.0',
});

server.tool('list_tags', 'List all tags in SimpleNote', {}, async () => {
	try {
		const { tags } = await provider.loadStore();
		const result = [...tags].sort((a, b) => a.index - b.index);
		return jsonResponse(result);
	} catch (err) {
		return errorResponse(err);
	}
});

server.tool(
	'list_notes',
	'List recent notes, optionally filtered by tag',
	{
		tag: z.string().optional().describe('Filter by tag name'),
		limit: z.number().optional().default(20).describe('Max notes to return'),
	},
	async ({ tag, limit }) => {
		try {
			const { notes } = await provider.loadStore();
			const result = notes
				.filter((n) => !n.deleted)
				.filter((n) => !tag || n.tags.includes(tag))
				.map((n) => ({
					id: n.id,
					title: extractTitle(n.content),
					tags: n.tags,
					pinned: n.pinned,
					modified: n.modified,
				}))
				.sort((a, b) => {
					if (a.pinned !== b.pinned) {
						return b.pinned - a.pinned;
					}
					return new Date(b.modified) - new Date(a.modified);
				})
				.slice(0, limit);
			return jsonResponse(result);
		} catch (err) {
			return errorResponse(err);
		}
	}
);

server.tool(
	'search_notes',
	'Search notes by content, title, or tags',
	{
		query: z.string().describe('Search term'),
		limit: z.number().optional().default(10).describe('Max results'),
		include_deleted: z.boolean().optional().default(false).describe('Include deleted notes'),
	},
	async ({ query, limit, include_deleted }) => {
		try {
			const { notes } = await provider.loadStore();
			const q = query.toLowerCase();

			const result = notes
				.filter((n) => (include_deleted ? true : !n.deleted))
				.filter((n) => {
					const content = n.content.toLowerCase();
					const title = extractTitle(n.content).toLowerCase();
					const tagsStr = n.tags.join(' ').toLowerCase();
					return content.includes(q) || title.includes(q) || tagsStr.includes(q);
				})
				.map((n) => {
					const content = n.content;
					const contentLower = content.toLowerCase();
					const pos = contentLower.indexOf(q);

					let snippet = '';
					if (pos >= 0) {
						const start = Math.max(0, pos - 40);
						const end = Math.min(content.length, pos + q.length + 60);
						snippet =
							(start > 0 ? '...' : '') +
							content.slice(start, end).trim() +
							(end < content.length ? '...' : '');
					} else {
						// Match was in tags — show the beginning of the content instead.
						snippet = content.slice(0, 100).trim() + (content.length > 100 ? '...' : '');
					}

					return {
						id: n.id,
						title: extractTitle(n.content),
						tags: n.tags,
						snippet,
						modified: n.modified,
						deleted: n.deleted,
					};
				})
				.sort((a, b) => new Date(b.modified) - new Date(a.modified))
				.slice(0, limit);

			return jsonResponse(result);
		} catch (err) {
			return errorResponse(err);
		}
	}
);

server.tool(
	'get_note',
	'Get full content of a specific note',
	{
		id: z.string().describe('Note ID (simperiumkey)'),
		include_deleted: z.boolean().optional().default(false).describe('Allow retrieving deleted notes'),
	},
	async ({ id, include_deleted }) => {
		try {
			const { notes } = await provider.loadStore();
			const note = notes.find((n) => n.id === id);

			if (!note) {
				return { content: [{ type: 'text', text: 'Note not found' }], isError: true };
			}

			if (note.deleted && !include_deleted) {
				return {
					content: [{
						type: 'text',
						text: 'Note is deleted. Use include_deleted: true to retrieve it.',
					}],
					isError: true,
				};
			}

			return jsonResponse({
				id: note.id,
				content: note.content,
				tags: note.tags,
				pinned: note.pinned,
				markdown: note.markdown,
				deleted: note.deleted,
				created: note.created,
				modified: note.modified,
			});
		} catch (err) {
			return errorResponse(err);
		}
	}
);

const transport = new StdioServerTransport();
await server.connect(transport);
