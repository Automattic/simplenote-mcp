import { randomUUID } from 'node:crypto';
import { loadToken } from './auth.js';
import type {
	NormalizedNote,
	NormalizedStore,
	NormalizedTag,
	NoteCreateInput,
	NoteCreateResult,
	NoteUpdateInput,
	NoteUpdateResult,
	Provider,
} from './normalize.js';

// Defaults to the production Simplenote app. Override with SIMPLENOTE_APP_ID
// to target the testing app (history-analyst-dad) during development.
const DEFAULT_APP_ID = 'chalk-bump-f49';
const APP_ID = process.env.SIMPLENOTE_APP_ID?.trim() || DEFAULT_APP_ID;
const API_BASE = 'https://api.simperium.com/1';
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;

export type ApiErrorCode =
	| 'no_token'
	| 'unauthorized'
	| 'request_failed'
	| 'network_error'
	| 'invalid_response'
	| 'not_found';

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
			// Only fall back to stale cache for transient failures. Auth
			// rejection or shape errors must surface so the user notices.
			if (
				this.cache &&
				err instanceof ApiError &&
				(err.code === 'network_error' || err.code === 'request_failed')
			) {
				console.error(
					`[simplenote-mcp] Simperium API error, returning cached data: ${err.message}`,
				);
				return this.cache.data;
			}
			throw err;
		}
	}

	clearCache(): void {
		this.cache = null;
	}

	async createNote(input: NoteCreateInput): Promise<NoteCreateResult> {
		const auth = await loadToken();
		if (!auth) {
			throw new ApiError(
				'no_token',
				'Not logged in. Run `simplenote-mcp login` to authenticate.',
			);
		}

		const noteId = randomUUID();
		const nowUnix = Math.floor(Date.now() / 1000);

		// Defaults: markdown on, pinned off. Caller can override either.
		const systemTags = mergeSystemTags([], {
			markdown: input.markdown ?? true,
			pinned: input.pinned ?? false,
		});

		const noteData = {
			content: input.content,
			creationDate: nowUnix,
			modificationDate: nowUnix,
			deleted: false,
			publishURL: '',
			shareURL: '',
			systemTags,
			tags: input.tags ?? [],
		};

		const result = await postNote(noteId, noteData, auth.token);

		// Invalidate cache so subsequent reads see the new note
		this.clearCache();

		return result;
	}

	async updateNote(input: NoteUpdateInput): Promise<NoteUpdateResult> {
		const auth = await loadToken();
		if (!auth) {
			throw new ApiError(
				'no_token',
				'Not logged in. Run `simplenote-mcp login` to authenticate.',
			);
		}

		// Fetch the raw remote record so we preserve fields we don't model in
		// NormalizedNote (publishURL, shareURL, unknown systemTags, etc.) and
		// avoid clobbering them on write. Always fresh — bypasses the 60s cache.
		const existing = await fetchRawNote(input.id, auth.token);

		const existingSystemTags = Array.isArray(existing.systemTags)
			? existing.systemTags.filter((t): t is string => typeof t === 'string')
			: [];
		// undefined toggles preserve existing flags; explicit true/false sets them.
		const systemTags = mergeSystemTags(existingSystemTags, {
			markdown: input.markdown,
			pinned: input.pinned,
		});

		const noteData: Record<string, unknown> = {
			...existing,
			systemTags,
			modificationDate: Math.floor(Date.now() / 1000),
		};
		if (input.content !== undefined) noteData.content = input.content;
		if (input.tags !== undefined) noteData.tags = input.tags;

		const result = await postNote(input.id, noteData, auth.token, 'update');

		// Invalidate cache so subsequent reads see the updated note
		this.clearCache();

		return { id: input.id, version: result.version };
	}
}

// Centralizes auth header, timeout, and the universal status mappings shared
// by every Simperium endpoint we touch. Callers only deal with the body and
// any endpoint-specific status codes (e.g. 404 for single-note fetch).
async function simperiumRequest(opts: {
	method: 'GET' | 'POST';
	path: string;
	token: string;
	body?: unknown;
	context: string;
	passthroughStatus?: readonly number[];
}): Promise<Response> {
	const headers: Record<string, string> = { 'X-Simperium-Token': opts.token };
	let payload: string | undefined;
	if (opts.body !== undefined) {
		headers['Content-Type'] = 'application/json';
		payload = JSON.stringify(opts.body);
	}

	let res: Response;
	try {
		res = await fetch(`${API_BASE}/${APP_ID}${opts.path}`, {
			method: opts.method,
			headers,
			body: payload,
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		throw new ApiError(
			'network_error',
			`Network error ${opts.context}: ${(err as Error).message}`,
		);
	}

	if (res.status === 401) {
		throw new ApiError(
			'unauthorized',
			'Token rejected. Run `simplenote-mcp login` to re-authenticate.',
			401,
		);
	}
	if (!res.ok && !opts.passthroughStatus?.includes(res.status)) {
		throw new ApiError(
			'request_failed',
			`Simperium API error ${opts.context} (HTTP ${res.status}).`,
			res.status,
		);
	}
	return res;
}

async function fetchRawNote(
	noteId: string,
	token: string,
): Promise<Record<string, unknown>> {
	const res = await simperiumRequest({
		method: 'GET',
		path: `/note/i/${noteId}`,
		token,
		context: 'fetching note',
		passthroughStatus: [404],
	});
	if (res.status === 404) {
		throw new ApiError('not_found', `Note not found: ${noteId}`, 404);
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		throw new ApiError('invalid_response', 'Simperium note returned invalid JSON.');
	}
	if (!body || typeof body !== 'object') {
		throw new ApiError(
			'invalid_response',
			'Simperium note response was not a JSON object.',
		);
	}
	return body as Record<string, unknown>;
}

async function postNote(
	noteId: string,
	data: Record<string, unknown>,
	token: string,
	operation: 'create' | 'update' = 'create',
): Promise<NoteCreateResult> {
	// Simperium returns the new version number as plain text in the body.
	const res = await simperiumRequest({
		method: 'POST',
		path: `/note/i/${noteId}`,
		token,
		body: data,
		context: operation === 'update' ? 'updating note' : 'creating note',
	});

	let version = 1;
	try {
		const text = await res.text();
		const parsed = Number.parseInt(text, 10);
		if (Number.isFinite(parsed)) version = parsed;
	} catch {
		// fall through with default version 1
	}
	return { id: noteId, version };
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

		const res = await simperiumRequest({
			method: 'GET',
			path: `/${bucket}/index?${params}`,
			token,
			context: `fetching ${bucket} index`,
		});

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

function mergeSystemTags(
	existing: readonly string[],
	toggles: { markdown?: boolean; pinned?: boolean },
): string[] {
	const tags = new Set(existing);
	for (const [name, value] of Object.entries(toggles)) {
		if (value === undefined) continue;
		if (value) tags.add(name);
		else tags.delete(name);
	}
	return Array.from(tags);
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

export const _test = { normalizeNote, normalizeTag, toBool, toIsoFromUnix };
