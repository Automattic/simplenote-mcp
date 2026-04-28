import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
	CreateNoteToolOutputSchema,
	GetNoteHistoryOutputSchema,
	GetNoteOutputSchema,
	GetNoteVersionOutputSchema,
	ListNotesOutputSchema,
	ListTagsOutputSchema,
	RevertNoteToolOutputSchema,
	RestoreNoteToolOutputSchema,
	SearchNotesOutputSchema,
	TrashNoteToolOutputSchema,
	UpdateNoteToolOutputSchema,
	jsonResult,
} from '../src/tools/results.ts';

describe('jsonResult', () => {
	it('returns legacy text JSON alongside structured content', () => {
		const textValue = [{ name: 'work', index: 1 }];
		const structuredContent = { tags: textValue };

		const result = jsonResult(textValue, structuredContent);

		assert.deepEqual(result.content, [
			{ type: 'text', text: JSON.stringify(textValue, null, 2) },
		]);
		assert.equal(result.structuredContent, structuredContent);
	});
});

describe('tool output schemas', () => {
	const listedNote = {
		id: 'note-1',
		title: 'Title',
		tags: ['work'],
		pinned: false,
		modified: '2026-04-28T12:00:00.000Z',
		deleted: false,
	};
	const note = {
		id: listedNote.id,
		content: 'Title\nBody',
		tags: listedNote.tags,
		pinned: listedNote.pinned,
		markdown: true,
		deleted: listedNote.deleted,
		created: null,
		modified: listedNote.modified,
	};
	const searchResult = {
		id: listedNote.id,
		title: listedNote.title,
		tags: listedNote.tags,
		snippet: 'Title',
		modified: listedNote.modified,
		deleted: listedNote.deleted,
	};
	const history = {
		id: listedNote.id,
		current_version: 3,
		entries: [
			{
				version: 3,
				modified_at: listedNote.modified,
				content_preview: 'Title',
			},
		],
	};

	it('accepts object-shaped structured outputs for read tools', () => {
		assert.deepEqual(ListTagsOutputSchema.parse({ tags: [{ name: 'work', index: 1 }] }), {
			tags: [{ name: 'work', index: 1 }],
		});
		assert.deepEqual(ListNotesOutputSchema.parse({ notes: [listedNote] }), {
			notes: [listedNote],
		});
		assert.deepEqual(
			SearchNotesOutputSchema.parse({
				notes: [searchResult],
			}),
			{
				notes: [searchResult],
			},
		);
		assert.deepEqual(GetNoteOutputSchema.parse({ note }), { note });
		assert.deepEqual(GetNoteVersionOutputSchema.parse({ note: { ...note, version: 2 } }), {
			note: { ...note, version: 2 },
		});
		assert.deepEqual(GetNoteHistoryOutputSchema.parse({ history }), { history });
	});

	it('accepts object-shaped structured outputs for write tools', () => {
		assert.deepEqual(
			CreateNoteToolOutputSchema.parse({
				result: { success: true, id: 'note-1', version: 1, title: 'Title' },
			}),
			{ result: { success: true, id: 'note-1', version: 1, title: 'Title' } },
		);
		assert.deepEqual(
			UpdateNoteToolOutputSchema.parse({
				result: { success: true, id: 'note-1', version: 2 },
			}),
			{ result: { success: true, id: 'note-1', version: 2 } },
		);
		assert.deepEqual(
			TrashNoteToolOutputSchema.parse({
				result: {
					success: true,
					id: 'note-1',
					title: 'Title',
					trashed_at: '2026-04-28T12:00:00.000Z',
				},
			}),
			{
				result: {
					success: true,
					id: 'note-1',
					title: 'Title',
					trashed_at: '2026-04-28T12:00:00.000Z',
				},
			},
		);
		assert.deepEqual(
			RestoreNoteToolOutputSchema.parse({
				result: {
					success: true,
					id: 'note-1',
					title: 'Title',
					restored_at: null,
				},
			}),
			{
				result: {
					success: true,
					id: 'note-1',
					title: 'Title',
					restored_at: null,
				},
			},
		);
		assert.deepEqual(
			RevertNoteToolOutputSchema.parse({
				result: {
					success: true,
					id: 'note-1',
					reverted_from_version: 2,
					new_version: 6,
					no_op: false,
				},
			}),
			{
				result: {
					success: true,
					id: 'note-1',
					reverted_from_version: 2,
					new_version: 6,
					no_op: false,
				},
			},
		);
	});

	it('rejects legacy top-level arrays as structured content', () => {
		assert.throws(() => ListTagsOutputSchema.parse([{ name: 'work', index: 1 }]));
	});
});
