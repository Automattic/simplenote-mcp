import { z } from 'zod';

export const TagOutputSchema = z.object({
	name: z.string(),
	index: z.number(),
});

export const ListedNoteOutputSchema = z.object({
	id: z.string(),
	title: z.string(),
	tags: z.array(z.string()),
	pinned: z.boolean(),
	modified: z.string().nullable(),
	deleted: z.boolean(),
});

export const SearchResultOutputSchema = z.object({
	id: z.string(),
	title: z.string(),
	tags: z.array(z.string()),
	snippet: z.string(),
	modified: z.string().nullable(),
	deleted: z.boolean(),
});

export const NoteOutputSchema = z.object({
	id: z.string(),
	content: z.string(),
	tags: z.array(z.string()),
	pinned: z.boolean(),
	markdown: z.boolean(),
	deleted: z.boolean(),
	created: z.string().nullable(),
	modified: z.string().nullable(),
});

export const NoteVersionOutputSchema = NoteOutputSchema.extend({
	version: z.number(),
});

export const NoteVersionEntryOutputSchema = z.object({
	version: z.number(),
	modified_at: z.string().nullable(),
	content_preview: z.string(),
});

export const NoteHistoryOutputSchema = z.object({
	id: z.string(),
	current_version: z.number(),
	entries: z.array(NoteVersionEntryOutputSchema),
});

export const CreateNoteOutputSchema = z.object({
	success: z.boolean(),
	id: z.string(),
	version: z.number(),
	title: z.string(),
});

export const UpdateNoteOutputSchema = z.object({
	success: z.boolean(),
	id: z.string(),
	version: z.number(),
});

export const TrashNoteOutputSchema = z.object({
	success: z.boolean(),
	id: z.string(),
	title: z.string(),
	trashed_at: z.string().nullable(),
});

export const RestoreNoteOutputSchema = z.object({
	success: z.boolean(),
	id: z.string(),
	title: z.string(),
	restored_at: z.string().nullable(),
});

export const RevertNoteOutputSchema = z.object({
	success: z.boolean(),
	id: z.string(),
	reverted_from_version: z.number(),
	new_version: z.number(),
	no_op: z.boolean(),
});

export const ListTagsOutputSchema = z.object({
	tags: z.array(TagOutputSchema),
});

export const ListNotesOutputSchema = z.object({
	notes: z.array(ListedNoteOutputSchema),
});

export const SearchNotesOutputSchema = z.object({
	notes: z.array(SearchResultOutputSchema),
});

export const GetNoteOutputSchema = z.object({
	note: NoteOutputSchema,
});

export const GetNoteVersionOutputSchema = z.object({
	note: NoteVersionOutputSchema,
});

export const GetNoteHistoryOutputSchema = z.object({
	history: NoteHistoryOutputSchema,
});

export const CreateNoteToolOutputSchema = z.object({
	result: CreateNoteOutputSchema,
});

export const UpdateNoteToolOutputSchema = z.object({
	result: UpdateNoteOutputSchema,
});

export const TrashNoteToolOutputSchema = z.object({
	result: TrashNoteOutputSchema,
});

export const RestoreNoteToolOutputSchema = z.object({
	result: RestoreNoteOutputSchema,
});

export const RevertNoteToolOutputSchema = z.object({
	result: RevertNoteOutputSchema,
});

export function jsonResult<TStructured extends Record<string, unknown>>(
	textValue: unknown,
	structuredContent: TStructured,
): {
	content: [{ type: 'text'; text: string }];
	structuredContent: TStructured;
} {
	return {
		content: [{ type: 'text', text: JSON.stringify(textValue, null, 2) }],
		structuredContent,
	};
}
