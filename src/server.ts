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

server.tool('list_tags', 'List all tags in SimpleNote', {}, async () => {
	try {
		const { tags } = await provider.loadStore();
		const result = [...tags].sort((a, b) => a.index - b.index);
		return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
	} catch (err) {
		return toolError(err);
	}
});

server.tool(
	'list_notes',
	'List recent notes, optionally filtered by tag',
	{
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

server.tool(
	'search_notes',
	'Search notes by content, title, or tags',
	{
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

server.tool(
	'get_note',
	'Get full content of a specific note',
	{
		id: z.string().describe('Note ID (simperiumkey)'),
		include_deleted: z
			.boolean()
			.optional()
			.default(false)
			.describe('Allow retrieving deleted notes'),
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
