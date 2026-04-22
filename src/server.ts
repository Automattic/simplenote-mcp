#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { extractTitle, type Provider } from './providers/normalize.js';
import { resolveProvider } from './providers/resolver.js';

// CLI subcommand dispatch must run before MCP/store setup.
const subcommand = process.argv[2];
if (subcommand === 'login' || subcommand === 'logout') {
	const { runSubcommand } = await import('./cli.js');
	process.exit(await runSubcommand(subcommand));
}

const explicitPath = parseStorePath(process.argv.slice(2));

let provider: Provider;
try {
	provider = await resolveProvider({ explicitPath });
} catch (err) {
	console.error(`Error: ${(err as Error).message}`);
	process.exit(1);
}

const server = new McpServer({ name: 'simplenote', version: '1.0.0' });

// All tools are read-only queries. The Simperium provider is network-bound,
// so openWorldHint is true even though the native macOS provider is local.
const READ_ONLY_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;

// Write operations modify remote state.
const WRITE_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
} as const;

// Gate write operations behind an explicit opt-in.
const ALLOW_WRITE = process.env.SIMPLENOTE_ALLOW_WRITE === '1';

server.registerTool(
	'list_tags',
	{
		title: 'List Tags',
		description: 'List all tags in Simplenote',
		inputSchema: {},
		annotations: READ_ONLY_ANNOTATIONS,
	},
	async () => {
		try {
			const { tags } = await provider.loadStore();
			const result = [...tags].sort((a, b) => a.index - b.index);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		} catch (err) {
			return toolError(err);
		}
	},
);

server.registerTool(
	'list_notes',
	{
		title: 'List Notes',
		description: 'List recent notes, optionally filtered by tag',
		inputSchema: {
			tag: z.string().optional().describe('Filter by tag name'),
			limit: z
				.number()
				.int()
				.min(0)
				.max(100)
				.optional()
				.default(20)
				.describe('Max notes to return (0–100)'),
		},
		annotations: READ_ONLY_ANNOTATIONS,
	},
	async ({ tag, limit }) => {
		try {
			const { notes } = await provider.loadStore();
			const result = notes
				.filter((n) => !n.deleted)
				.filter((n) => (tag ? n.tags.includes(tag) : true))
				.map((n) => ({
					id: n.id,
					title: extractTitle(n.content),
					tags: n.tags,
					pinned: n.pinned,
					modified: n.modified,
				}))
				.sort((a, b) => {
					if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
					return dateValue(b.modified) - dateValue(a.modified);
				})
				.slice(0, limit);
			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		} catch (err) {
			return toolError(err);
		}
	},
);

server.registerTool(
	'search_notes',
	{
		title: 'Search Notes',
		description: 'Search notes by content, title, or tags',
		inputSchema: {
			query: z.string().min(1).describe('Search term'),
			limit: z
				.number()
				.int()
				.min(0)
				.max(100)
				.optional()
				.default(10)
				.describe('Max results (0–100)'),
			include_deleted: z
				.boolean()
				.optional()
				.default(false)
				.describe('Include deleted notes'),
		},
		annotations: READ_ONLY_ANNOTATIONS,
	},
	async ({ query, limit, include_deleted }) => {
		try {
			const { notes } = await provider.loadStore();
			const q = query.toLowerCase();

			const result = notes
				.filter((n) => include_deleted || !n.deleted)
				.filter((n) => {
					const contentLower = n.content.toLowerCase();
					const titleLower = extractTitle(n.content).toLowerCase();
					const tagsLower = n.tags.join(' ').toLowerCase();
					return (
						contentLower.includes(q) ||
						titleLower.includes(q) ||
						tagsLower.includes(q)
					);
				})
				.map((n) => {
					const contentLower = n.content.toLowerCase();
					const pos = contentLower.indexOf(q);
					let snippet: string;
					if (pos >= 0) {
						const start = Math.max(0, pos - 40);
						const end = Math.min(n.content.length, pos + q.length + 60);
						snippet =
							(start > 0 ? '...' : '') +
							n.content.slice(start, end).trim() +
							(end < n.content.length ? '...' : '');
					} else {
						snippet =
							n.content.slice(0, 100).trim() +
							(n.content.length > 100 ? '...' : '');
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
				.sort((a, b) => dateValue(b.modified) - dateValue(a.modified))
				.slice(0, limit);

			return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
		} catch (err) {
			return toolError(err);
		}
	},
);

server.registerTool(
	'get_note',
	{
		title: 'Get Note',
		description: 'Get full content of a specific note',
		inputSchema: {
			id: z.string().describe('Note ID (simperiumkey)'),
			include_deleted: z
				.boolean()
				.optional()
				.default(false)
				.describe('Allow retrieving deleted notes'),
		},
		annotations: READ_ONLY_ANNOTATIONS,
	},
	async ({ id, include_deleted }) => {
		try {
			const { notes } = await provider.loadStore();
			const note = notes.find((n) => n.id === id);
			if (!note) {
				return {
					content: [{ type: 'text', text: 'Note not found' }],
					isError: true,
				};
			}
			if (note.deleted && !include_deleted) {
				return {
					content: [
						{
							type: 'text',
							text: 'Note is deleted. Use include_deleted: true to retrieve it.',
						},
					],
					isError: true,
				};
			}
			return { content: [{ type: 'text', text: JSON.stringify(note, null, 2) }] };
		} catch (err) {
			return toolError(err);
		}
	},
);

// Register create_note only when write operations are enabled
if (ALLOW_WRITE) {
	server.registerTool(
		'create_note',
		{
			title: 'Create Note',
			description:
				'Create a new note in Simplenote. Requires SIMPLENOTE_ALLOW_WRITE=1 and the Simperium API provider.',
			inputSchema: {
				content: z.string().describe('Note content (first line becomes title)'),
				tags: z
					.array(z.string())
					.optional()
					.describe('Tags to attach to the note'),
				markdown: z
					.boolean()
					.optional()
					.default(true)
					.describe('Enable markdown rendering (default: true)'),
				pinned: z
					.boolean()
					.optional()
					.default(false)
					.describe('Pin note to top of list'),
			},
			annotations: WRITE_ANNOTATIONS,
		},
		async ({ content, tags, markdown, pinned }) => {
			// Only the API provider supports note creation
			if (provider.name !== 'simperium-api') {
				return {
					content: [
						{
							type: 'text',
							text: 'Error: create_note requires the Simperium API provider. ' +
								'Run `simplenote-mcp login` to authenticate.',
						},
					],
					isError: true,
				};
			}

			if (!provider.createNote) {
				return {
					content: [
						{ type: 'text', text: 'Error: Note creation not implemented for this provider.' },
					],
					isError: true,
				};
			}

			try {
				const result = await provider.createNote({ content, tags, markdown, pinned });
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(
								{
									success: true,
									id: result.id,
									version: result.version,
									title: extractTitle(content),
								},
								null,
								2,
							),
						},
					],
				};
			} catch (err) {
				return toolError(err);
			}
		},
	);
}

const transport = new StdioServerTransport();
await server.connect(transport);

function parseStorePath(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (typeof arg !== 'string') continue;
		if (arg.startsWith('--path=')) {
			const value = arg.slice('--path='.length);
			if (!value) {
				console.error('Error: --path= requires a value');
				process.exit(1);
			}
			return value;
		}
		if (arg === '--path') {
			const value = args[i + 1];
			if (!value || value.startsWith('--')) {
				console.error('Error: --path requires a value');
				process.exit(1);
			}
			return value;
		}
	}
	return undefined;
}

function dateValue(iso: string | null): number {
	if (!iso) return 0;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : 0;
}

function toolError(err: unknown): {
	content: [{ type: 'text'; text: string }];
	isError: true;
} {
	const message = err instanceof Error ? err.message : String(err);
	return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
