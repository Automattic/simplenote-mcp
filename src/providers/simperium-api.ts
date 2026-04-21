import { loadToken } from './auth.js';
import type {
	NormalizedNote,
	NormalizedStore,
	NormalizedTag,
	Provider,
} from './normalize.js';

// Defaults to the public testing Simperium app shipped in simplenote-macos.
// Tokens issued by app.simplenote.com are bound to the production Simperium
// app, so real note access requires overriding this with SIMPLENOTE_APP_ID.
const DEFAULT_APP_ID = 'history-analyst-dad';
const APP_ID = process.env.SIMPLENOTE_APP_ID?.trim() || DEFAULT_APP_ID;
const API_BASE = 'https://api.simperium.com/1';
const CACHE_TTL_MS = 60_000;

export type ApiErrorCode =
	| 'no_token'
	| 'unauthorized'
	| 'request_failed'
	| 'network_error'
	| 'invalid_response';

export class ApiError extends Error {
	readonly code: ApiErrorCode;
	readonly status?: number;

	constructor(code: ApiErrorCode, message: string, status?: number) {
		super(message);
		this.name = 'ApiError';
		this.code = code;
		this.status = status;
	}
}

type IndexEntry = {
	id?: unknown;
	d?: unknown;
};

type IndexResponse = {
	index?: IndexEntry[];
	mark?: string;
};

class SimperiumApiProvider implements Provider {
	readonly name = 'simperium-api' as const;
	readonly description = `Simperium API (app_id=${APP_ID})`;
	private cache: { fetchedAt: number; data: NormalizedStore } | null = null;

	async loadStore(): Promise<NormalizedStore> {
		if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
			return this.cache.data;
		}

		const auth = await loadToken();
		if (!auth) {
			throw new ApiError(
				'no_token',
				'Not logged in. Run `simplenote-mcp login` to authenticate.',
			);
		}

		try {
			const [noteEntries, tagEntries] = await Promise.all([
				fetchAllIndex('note', auth.token),
				fetchAllIndex('tag', auth.token),
			]);

			const data: NormalizedStore = {
				notes: noteEntries
					.map(normalizeNote)
					.filter((n): n is NormalizedNote => n !== null),
				tags: tagEntries
					.map(normalizeTag)
					.filter((t): t is NormalizedTag => t !== null),
			};

			this.cache = { fetchedAt: Date.now(), data };
			return data;
		} catch (err) {
			if (this.cache) {
				console.error(
					`[simplenote-mcp] Simperium API error, returning cached data: ${(err as Error).message}`,
				);
				return this.cache.data;
			}
			throw err;
		}
	}

	clearCache(): void {
		this.cache = null;
	}
}

export function createApiProvider(): Provider {
	return new SimperiumApiProvider();
}

async function fetchAllIndex(
	bucket: 'note' | 'tag',
	token: string,
): Promise<IndexEntry[]> {
	const all: IndexEntry[] = [];
	let mark: string | undefined;

	while (true) {
		const params = new URLSearchParams({ data: 'true' });
		if (mark) params.set('mark', mark);
		const url = `${API_BASE}/${APP_ID}/${bucket}/index?${params}`;

		let res: Response;
		try {
			res = await fetch(url, { headers: { 'X-Simperium-Token': token } });
		} catch (err) {
			throw new ApiError(
				'network_error',
				`Network error contacting Simperium: ${(err as Error).message}`,
			);
		}

		if (res.status === 401) {
			throw new ApiError(
				'unauthorized',
				'Token rejected. Run `simplenote-mcp login` to re-authenticate.',
				401,
			);
		}
		if (!res.ok) {
			throw new ApiError(
				'request_failed',
				`Simperium API error fetching ${bucket} index (HTTP ${res.status}).`,
				res.status,
			);
		}

		let body: unknown;
		try {
			body = await res.json();
		} catch {
			throw new ApiError(
				'invalid_response',
				`Simperium ${bucket} index returned invalid JSON.`,
			);
		}

		const parsed = body as IndexResponse;
		if (Array.isArray(parsed.index)) {
			all.push(...parsed.index);
		}

		const nextMark = typeof parsed.mark === 'string' ? parsed.mark : undefined;
		if (!nextMark || nextMark === mark) break;
		mark = nextMark;
	}

	return all;
}

function normalizeNote(entry: IndexEntry): NormalizedNote | null {
	const id = typeof entry.id === 'string' ? entry.id : null;
	if (!id) return null;
	const data = entry.d;
	if (!data || typeof data !== 'object') return null;
	const d = data as Record<string, unknown>;

	const systemTags = Array.isArray(d.systemTags)
		? d.systemTags.filter((t): t is string => typeof t === 'string')
		: [];
	const tags = Array.isArray(d.tags)
		? d.tags.filter((t): t is string => typeof t === 'string')
		: [];

	return {
		id,
		content: typeof d.content === 'string' ? d.content : '',
		tags,
		pinned: systemTags.includes('pinned'),
		markdown: systemTags.includes('markdown'),
		deleted: toBool(d.deleted),
		created: toIsoFromUnix(d.creationDate),
		modified: toIsoFromUnix(d.modificationDate),
	};
}

function normalizeTag(entry: IndexEntry): NormalizedTag | null {
	const data = entry.d;
	if (!data || typeof data !== 'object') return null;
	const d = data as Record<string, unknown>;

	const name =
		typeof d.name === 'string' && d.name.length > 0
			? d.name
			: typeof entry.id === 'string'
				? entry.id
				: null;
	if (!name) return null;

	const rawIndex = d.index;
	let index = 0;
	if (typeof rawIndex === 'number' && Number.isFinite(rawIndex)) {
		index = rawIndex;
	} else if (typeof rawIndex === 'string') {
		const parsed = Number.parseInt(rawIndex, 10);
		if (!Number.isNaN(parsed)) index = parsed;
	}

	return { name, index };
}

function toBool(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
	return false;
}

function toIsoFromUnix(value: unknown): string | null {
	const num =
		typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isFinite(num)) return null;
	return new Date(num * 1000).toISOString();
}
