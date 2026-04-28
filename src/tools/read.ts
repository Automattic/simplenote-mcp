import { z } from 'zod';
import { extractTitle } from '../providers/normalize.js';
import {
	GetNoteOutputSchema,
	ListNotesOutputSchema,
	ListTagsOutputSchema,
	SearchNotesOutputSchema,
	jsonResult,
} from './results.js';
import {
	READ_ONLY_ANNOTATIONS,
	toolError,
	type ToolRegistrationContext,
} from './common.js';

export function registerReadTools({
	server,
	provider,
	trackedTool,
}: ToolRegistrationContext): void {
	server.registerTool(
		'list_tags',
		{
			title: 'List Tags',
			description: 'List all tags in Simplenote',
			inputSchema: {},
			outputSchema: ListTagsOutputSchema,
			annotations: READ_ONLY_ANNOTATIONS,
		},
		trackedTool('list_tags', async () => {
			try {
				const { tags } = await provider.loadStore();
				const result = [...tags].sort((a, b) => a.index - b.index);
				return jsonResult(result, { tags: result });
			} catch (err) {
				return toolError(err);
			}
		}),
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
			outputSchema: ListNotesOutputSchema,
			annotations: READ_ONLY_ANNOTATIONS,
		},
		trackedTool('list_notes', async ({ tag, limit, include_deleted }) => {
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
				return jsonResult(result, { notes: result });
			} catch (err) {
				return toolError(err);
			}
		}),
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
			outputSchema: SearchNotesOutputSchema,
			annotations: READ_ONLY_ANNOTATIONS,
		},
		trackedTool('search_notes', async ({ query, limit, include_deleted }) => {
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

				return jsonResult(result, { notes: result });
			} catch (err) {
				return toolError(err);
			}
		}),
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
			outputSchema: GetNoteOutputSchema,
			annotations: READ_ONLY_ANNOTATIONS,
		},
		trackedTool('get_note', async ({ id, include_deleted }) => {
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
				return jsonResult(note, { note });
			} catch (err) {
				return toolError(err);
			}
		}),
	);

}

function dateValue(iso: string | null): number {
	if (!iso) return 0;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : 0;
}
