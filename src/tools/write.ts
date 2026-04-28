import { z } from 'zod';
import {
	extractTitle,
	formatNoteForDisplay,
} from '../providers/normalize.js';
import {
	CreateNoteToolOutputSchema,
	GetNoteHistoryOutputSchema,
	GetNoteVersionOutputSchema,
	RevertNoteToolOutputSchema,
	RestoreNoteToolOutputSchema,
	TrashNoteToolOutputSchema,
	UpdateNoteToolOutputSchema,
	jsonResult,
} from './results.js';
import {
	READ_ONLY_ANNOTATIONS,
	RESTORE_ANNOTATIONS,
	REVERT_ANNOTATIONS,
	TRASH_ANNOTATIONS,
	WRITE_ANNOTATIONS,
	toolError,
	type ToolRegistrationContext,
} from './common.js';

export function registerWriteTools({
	server,
	provider,
	trackedTool,
}: ToolRegistrationContext): void {
	// Register write tools only when the resolved provider advertises the
	// capability. The resolver strips write methods when write-mode is disabled
	// in config, and the native provider doesn't implement them at all.
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
				outputSchema: CreateNoteToolOutputSchema,
				annotations: WRITE_ANNOTATIONS,
			},
			trackedTool('create_note', async ({ content, tags, markdown, pinned }) => {
				try {
					const result = await createNote({ content, tags, markdown, pinned });
					const output = {
						success: true,
						id: result.id,
						version: result.version,
						title: extractTitle(content),
					};
					return jsonResult(output, { result: output });
				} catch (err) {
					return toolError(err);
				}
			}),
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
				outputSchema: UpdateNoteToolOutputSchema,
				annotations: WRITE_ANNOTATIONS,
			},
			trackedTool('update_note', async ({ id, content, tags, markdown, pinned }) => {
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
					const output = {
						success: true,
						id: result.id,
						version: result.version,
					};
					return jsonResult(output, { result: output });
				} catch (err) {
					return toolError(err);
				}
			}),
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
				outputSchema: TrashNoteToolOutputSchema,
				annotations: TRASH_ANNOTATIONS,
			},
			trackedTool('trash_note', async ({ id }) => {
				try {
					// Source of truth is the provider, which does a fresh GET — a
					// cached pre-check here could lie in either direction (claim a
					// restored-by-another-client note is still in trash, or claim a
					// just-created note doesn't exist). 404s from the GET surface
					// as ApiError('not_found') via toolError.
					const trashed = await trashNote(id);
					const output = {
						success: true,
						id: trashed.id,
						title: extractTitle(trashed.content),
						trashed_at: trashed.modified,
					};
					return jsonResult(output, { result: output });
				} catch (err) {
					return toolError(err);
				}
			}),
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
				outputSchema: RestoreNoteToolOutputSchema,
				annotations: RESTORE_ANNOTATIONS,
			},
			trackedTool('restore_note', async ({ id }) => {
				try {
					const restored = await restoreNote(id);
					const output = {
						success: true,
						id: restored.id,
						title: extractTitle(restored.content),
						restored_at: restored.modified,
					};
					return jsonResult(output, { result: output });
				} catch (err) {
					return toolError(err);
				}
			}),
		);
	}

	if (provider.getNoteVersion) {
		const getNoteVersion = provider.getNoteVersion.bind(provider);
		server.registerTool(
			'get_note_version',
			{
				title: 'Get Note Version',
				description:
					'Fetch a specific historical version of a note. Read-only — does not modify state. ' +
					'Use to preview content before calling revert_note. ' +
					'Versions outside Simperium\'s retention window return version_not_found.',
				inputSchema: {
					id: z.string().min(1).describe('Note ID'),
					version: z
						.number()
						.int()
						.positive()
						.describe('Version number (positive integer)'),
				},
				outputSchema: GetNoteVersionOutputSchema,
				annotations: READ_ONLY_ANNOTATIONS,
			},
			trackedTool('get_note_version', async ({ id, version }) => {
				try {
					const note = await getNoteVersion(id, version);
					return jsonResult(note, { note });
				} catch (err) {
					return toolError(err);
				}
			}),
		);
	}

	if (provider.getNoteHistory) {
		const getNoteHistory = provider.getNoteHistory.bind(provider);
		server.registerTool(
			'get_note_history',
			{
				title: 'Get Note History',
				description:
					'List recent versions of a note with short content previews. Read-only. ' +
					'Entries are sorted current-first; entry[1] is the next available earlier version. ' +
					'Versions outside Simperium\'s retention window are silently dropped — ' +
					'check entry.version numbers for non-contiguity.',
				inputSchema: {
					id: z.string().min(1).describe('Note ID'),
					limit: z
						.number()
						.int()
						.min(1)
						.max(25)
						.optional()
						.default(10)
						.describe('Max versions to return (1–25)'),
				},
				outputSchema: GetNoteHistoryOutputSchema,
				annotations: READ_ONLY_ANNOTATIONS,
			},
			trackedTool('get_note_history', async ({ id, limit }) => {
				try {
					const history = await getNoteHistory(id, limit);
					return jsonResult(history, { history });
				} catch (err) {
					return toolError(err);
				}
			}),
		);
	}

	if (provider.revertNote) {
		const revertNote = provider.revertNote.bind(provider);
		server.registerTool(
			'revert_note',
			{
				title: 'Revert Note',
				description:
					'Restore a note to a prior version. Normally counts toward the write-rate ' +
					'budget, except when the target version already matches the current ' +
					'version; in that no-op case, no POST is performed and no budget is ' +
					'consumed. Bypasses the trashed-note guard — reverting to a non-trashed ' +
					'version will un-trash the note; reverting to a trashed version will ' +
					're-trash. Use get_note_history first to pick a version, and ' +
					'get_note_version to preview the full content before reverting. ' +
					'Requires write-mode enabled in `simplenote-mcp setup`.',
				inputSchema: {
					id: z.string().min(1).describe('Note ID'),
					version: z
						.number()
						.int()
						.positive()
						.describe('Target version to restore (positive integer)'),
				},
				outputSchema: RevertNoteToolOutputSchema,
				annotations: REVERT_ANNOTATIONS,
			},
			trackedTool('revert_note', async ({ id, version }) => {
				try {
					const result = await revertNote({ id, version });
					const output = {
						success: true,
						id: result.id,
						reverted_from_version: result.reverted_from_version,
						new_version: result.new_version,
						no_op: result.no_op,
					};
					return jsonResult(output, { result: output });
				} catch (err) {
					return toolError(err);
				}
			}),
		);
	}
}
