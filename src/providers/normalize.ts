export type NormalizedNote = {
	id: string;
	content: string;
	tags: string[];
	pinned: boolean;
	markdown: boolean;
	deleted: boolean;
	created: string | null;
	modified: string | null;
};

export type NormalizedTag = {
	name: string;
	index: number;
};

export type NormalizedStore = {
	notes: NormalizedNote[];
	tags: NormalizedTag[];
};

export type NoteCreateInput = {
	content: string;
	tags?: string[];
	markdown?: boolean;
	pinned?: boolean;
};

export type NoteCreateResult = {
	id: string;
	version: number;
};

export type NoteUpdateInput = {
	id: string;
	content?: string;
	tags?: string[];
	markdown?: boolean;
	pinned?: boolean;
};

export type NoteUpdateResult = {
	id: string;
	version: number;
};

export type NoteVersionEntry = {
	version: number;
	modified_at: string | null;
	content_preview: string;
};

export type NoteHistoryResult = {
	id: string;
	current_version: number;
	entries: NoteVersionEntry[];
};

export type NoteVersionResult = NormalizedNote & { version: number };

export type NoteRevertInput = {
	id: string;
	version: number;
};

export type NoteRevertResult = {
	id: string;
	reverted_from_version: number;
	new_version: number;
	no_op: boolean;
};

export type Provider = {
	readonly name: 'native-macos' | 'simperium-api';
	readonly description: string;
	loadStore(): Promise<NormalizedStore>;
	createNote?(input: NoteCreateInput): Promise<NoteCreateResult>;
	updateNote?(input: NoteUpdateInput): Promise<NoteUpdateResult>;
	trashNote?(id: string): Promise<NormalizedNote>;
	restoreNote?(id: string): Promise<NormalizedNote>;
	getNoteHistory?(id: string, limit: number): Promise<NoteHistoryResult>;
	getNoteVersion?(id: string, version: number): Promise<NoteVersionResult>;
	revertNote?(input: NoteRevertInput): Promise<NoteRevertResult>;
};

export function extractTitle(content: string | null | undefined): string {
	if (typeof content !== 'string' || content.length === 0) return '(empty)';
	const firstLine = content.split('\n')[0]?.trim() ?? '';
	return firstLine.length > 0 ? firstLine.slice(0, 100) : '(empty)';
}

// Markdown-formatted view of a note, used by prompts that want the model to
// reason about a note's current state before suggesting changes.
export function formatNoteForDisplay(note: NormalizedNote): string {
	const tagsDisplay = note.tags.length > 0 ? note.tags.join(', ') : '(none)';
	const flags =
		[note.pinned ? 'pinned' : null, note.markdown ? 'markdown' : null]
			.filter(Boolean)
			.join(', ') || '(none)';
	return (
		`**ID:** ${note.id}\n` +
		`**Title:** ${extractTitle(note.content)}\n` +
		`**Tags:** ${tagsDisplay}\n` +
		`**Flags:** ${flags}\n` +
		`**Modified:** ${note.modified ?? 'unknown'}\n\n` +
		`---\n\n` +
		`${note.content}`
	);
}

export function safeJsonStringArray(value: unknown): string[] {
	if (typeof value !== 'string' || value.length === 0) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((v): v is string => typeof v === 'string');
	} catch {
		return [];
	}
}
