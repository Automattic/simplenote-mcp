#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
	extractTitle,
	formatNoteForDisplay,
	type Provider,
} from './providers/normalize.js';
import { resolveProvider } from './providers/resolver.js';

// CLI subcommand dispatch must run before MCP/store setup.
const subcommand = process.argv[2];
if (
	subcommand === 'setup' ||
	subcommand === 'logout' ||
	subcommand === 'disable-telemetry'
) {
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

// Trashing is destructive but soft (recoverable from any Simplenote client)
// and idempotent — a second call on an already-trashed note is a no-op.
const TRASH_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: true,
} as const;

// Restoring reverses a trash. Constructive, not destructive — if the model
// restores the wrong note the user trashes it again. Idempotent: a second
// call on an already-restored note is a no-op.
const RESTORE_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;

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
			include_deleted: z
				.boolean()
				.optional()
				.default(false)
				.describe('Include trashed notes'),
		},
		annotations: READ_ONLY_ANNOTATIONS,
	},
	async ({ tag, limit, include_deleted }) => {
		try {
			const { notes } = await provider.loadStore();
			const result = notes
				.filter((n) => include_deleted || !n.deleted)
				.filter((n) => (tag ? n.tags.includes(tag) : true))
				.map((n) => ({
					id: n.id,
					title: extractTitle(n.content),
					tags: n.tags,
					pinned: n.pinned,
					modified: n.modified,
					deleted: n.deleted,
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

// Register write tools only when the resolved provider advertises the
// capability. The resolver strips createNote / updateNote when write-mode is
// disabled in config, and the native provider doesn't implement them at all.
if (provider.createNote) {
	const createNote = provider.createNote.bind(provider);
	server.registerTool(
		'create_note',
		{
			title: 'Create Note',
			description:
				'Create a new note in Simplenote. Requires write-mode enabled in `simplenote-mcp setup` and a provider that supports writes (Simperium API).',
			inputSchema: {
				content: z.string().describe('Note content (first line becomes title)'),
				tags: z
					.array(z.string())
					.optional()
					.describe('Tags to attach to the note'),
				markdown: z
					.boolean()
					.optional()
					.describe('Enable markdown rendering (default: true)'),
				pinned: z
					.boolean()
					.optional()
					.describe('Pin note to top of list (default: false)'),
			},
			annotations: WRITE_ANNOTATIONS,
		},
		async ({ content, tags, markdown, pinned }) => {
			try {
				const result = await createNote({ content, tags, markdown, pinned });
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

if (provider.updateNote) {
	const updateNote = provider.updateNote.bind(provider);
	server.registerTool(
		'update_note',
		{
			title: 'Update Note',
			description:
				'Update an existing note in Simplenote. ' +
				'IMPORTANT: When changing only part of the content (e.g. fixing a typo, adding a section), call get_note first — `content` replaces the entire note, so a partial value will erase the rest. ' +
				'Tags, when provided, also replace the existing list in full. ' +
				'Requires write-mode enabled in `simplenote-mcp setup` and a provider that supports writes (Simperium API).',
			inputSchema: {
				id: z.string().describe('Note ID to update'),
				content: z.string().optional().describe('New note content'),
				tags: z
					.array(z.string())
					.optional()
					.describe('Replace tags (provide full list)'),
				markdown: z
					.boolean()
					.optional()
					.describe('Enable/disable markdown rendering'),
				pinned: z.boolean().optional().describe('Pin/unpin note'),
			},
			annotations: WRITE_ANNOTATIONS,
		},
		async ({ id, content, tags, markdown, pinned }) => {
			if (
				content === undefined &&
				tags === undefined &&
				markdown === undefined &&
				pinned === undefined
			) {
				return {
					content: [
						{
							type: 'text',
							text: 'Error: At least one field (content, tags, markdown, pinned) must be provided.',
						},
					],
					isError: true,
				};
			}

			try {
				const result = await updateNote({ id, content, tags, markdown, pinned });
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(
								{
									success: true,
									id: result.id,
									version: result.version,
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

	// Prompt is gated alongside the update_note tool so clients without write
	// access don't see a workflow they can't complete.
	server.registerPrompt(
		'update-note-workflow',
		{
			title: 'Update Note Workflow',
			description:
				'Guided workflow to safely update a note by first reviewing its current content',
			argsSchema: {
				noteId: z.string().describe('The note ID to update'),
			},
		},
		async ({ noteId }) => {
			try {
				const { notes } = await provider.loadStore();
				const note = notes.find((n) => n.id === noteId);

				if (!note) {
					return {
						messages: [
							{
								role: 'user' as const,
								content: {
									type: 'text' as const,
									text: `Note with ID "${noteId}" was not found. Please check the ID and try again.`,
								},
							},
						],
					};
				}

				return {
					messages: [
						{
							role: 'user' as const,
							content: {
								type: 'text' as const,
								text:
									`I want to update this note. Here's the current content:\n\n` +
									`${formatNoteForDisplay(note)}\n\n` +
									`---\n\n` +
									`What changes would you like to make to this note?`,
							},
						},
					],
					description: `Update workflow for: ${extractTitle(note.content)}`,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					messages: [
						{
							role: 'user' as const,
							content: {
								type: 'text' as const,
								text: `Error loading note: ${message}`,
							},
						},
					],
				};
			}
		},
	);
}

if (provider.trashNote) {
	const trashNote = provider.trashNote.bind(provider);
	server.registerTool(
		'trash_note',
		{
			title: 'Trash Note',
			description:
				'Move a note to the Simplenote trash. Soft-delete only — the note ' +
				'stays in the bucket and can be restored from any Simplenote client. ' +
				'One note per call. ' +
				'Requires write-mode enabled in `simplenote-mcp setup` and a provider that supports writes (Simperium API).',
			inputSchema: {
				id: z.string().describe('Note ID (simperiumkey) to trash'),
			},
			annotations: TRASH_ANNOTATIONS,
		},
		async ({ id }) => {
			try {
				// Source of truth is the provider, which does a fresh GET — a
				// cached pre-check here could lie in either direction (claim a
				// restored-by-another-client note is still in trash, or claim a
				// just-created note doesn't exist). 404s from the GET surface
				// as ApiError('not_found') via toolError.
				const trashed = await trashNote(id);
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(
								{
									success: true,
									id: trashed.id,
									title: extractTitle(trashed.content),
									trashed_at: trashed.modified,
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

if (provider.restoreNote) {
	const restoreNote = provider.restoreNote.bind(provider);
	server.registerTool(
		'restore_note',
		{
			title: 'Restore Note',
			description:
				'Restore a previously-trashed note so it reappears in active lists. ' +
				'Inverse of trash_note. ' +
				'One note per call. ' +
				'Requires write-mode enabled in `simplenote-mcp setup` and a provider that supports writes (Simperium API).',
			inputSchema: {
				id: z.string().describe('Note ID (simperiumkey) to restore'),
			},
			annotations: RESTORE_ANNOTATIONS,
		},
		async ({ id }) => {
			try {
				const restored = await restoreNote(id);
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(
								{
									success: true,
									id: restored.id,
									title: extractTitle(restored.content),
									restored_at: restored.modified,
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
