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

export type Provider = {
	readonly name: 'native-macos' | 'simperium-api';
	readonly description: string;
	loadStore(): Promise<NormalizedStore>;
};

export function extractTitle(content: string | null | undefined): string {
	if (typeof content !== 'string' || content.length === 0) return '(empty)';
	const firstLine = content.split('\n')[0]?.trim() ?? '';
	return firstLine.length > 0 ? firstLine.slice(0, 100) : '(empty)';
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
