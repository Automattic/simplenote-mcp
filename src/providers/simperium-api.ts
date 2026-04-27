import { randomUUID } from 'node:crypto';
import { loadToken } from './auth.js';
import type {
	NormalizedNote,
	NormalizedStore,
	NormalizedTag,
	NoteCreateInput,
	NoteCreateResult,
	NoteHistoryResult,
	NoteRevertInput,
	NoteRevertResult,
	NoteUpdateInput,
	NoteUpdateResult,
	NoteVersionEntry,
	NoteVersionResult,
	Provider,
} from './normalize.js';

// Defaults to the production Simplenote app. Override with SIMPLENOTE_APP_ID
// to target the testing app (history-analyst-dad) during development.
const DEFAULT_APP_ID = 'chalk-bump-f49';
const APP_ID = process.env.SIMPLENOTE_APP_ID?.trim() || DEFAULT_APP_ID;
const API_BASE = 'https://api.simperium.com/1';
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;

// Rolling-window cap on successful writes across all write tools. Catches
// runaway bulk loops (e.g. "blank every note") by forcing the LLM back to
// the user after a burst. Only successful writes count; failed writes
// leave the budget untouched.
const WRITE_RATE_WINDOW_MS = 30_000;
const WRITE_RATE_MAX = 5;

export type ApiErrorCode =
	| 'no_token'
	| 'unauthorized'
	| 'request_failed'
	| 'network_error'
	| 'invalid_response'
	| 'not_found'
	| 'note_in_trash'
	| 'empty_content'
	| 'rate_limited'
	| 'invalid_argument'
	| 'version_not_found';

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
	private writeTimestamps: number[] = [];

	// Refuse the call if the rolling window has already seen WRITE_RATE_MAX
	// successful writes. Older timestamps age out passively — no explicit
	// acknowledgment mechanism. Called immediately before each POST so
	// state-based early-returns (no-op, already-trashed, already-restored)
	// surface their specific errors instead of a generic rate_limited.
	private checkWriteRate(): void {
		const now = Date.now();
		const windowStart = now - WRITE_RATE_WINDOW_MS;
		this.writeTimestamps = this.writeTimestamps.filter((t) => t >= windowStart);
		if (this.writeTimestamps.length >= WRITE_RATE_MAX) {
			throw new ApiError(
				'rate_limited',
				`Paused after ${WRITE_RATE_MAX} writes in ${WRITE_RATE_WINDOW_MS / 1000} seconds. Confirm with the user that this bulk operation should continue before retrying.`,
			);
		}
	}

	private recordWrite(): void {
		this.writeTimestamps.push(Date.now());
	}

	async loadStore(): Promise<NormalizedStore> {
		if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
			return this.cache.data;
		}

		const auth = await loadToken();
		if (!auth) {
			throw new ApiError(
				'no_token',
				'Not logged in. Run `simplenote-mcp setup` to authenticate.',
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
		this.checkWriteRate();

		const auth = await loadToken();
		if (!auth) {
			throw new ApiError(
				'no_token',
				'Not logged in. Run `simplenote-mcp setup` to authenticate.',
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

		this.recordWrite();

		// Invalidate cache so subsequent reads see the new note
		this.clearCache();

		return result;
	}

	async updateNote(input: NoteUpdateInput): Promise<NoteUpdateResult> {
		if (input.content !== undefined && input.content.trim().length === 0) {
			throw new ApiError(
				'empty_content',
				'Refusing to replace note content with blank text. Use `trash_note` if you want to remove this note.',
			);
		}

		const auth = await loadToken();
		if (!auth) {
			throw new ApiError(
				'no_token',
				'Not logged in. Run `simplenote-mcp setup` to authenticate.',
			);
		}

		// Fetch the raw remote record so we preserve fields we don't model in
		// NormalizedNote (publishURL, shareURL, unknown systemTags, etc.) and
		// avoid clobbering them on write. Always fresh — bypasses the 60s cache.
		const { data: existing, version: existingVersion } = await fetchRawNote(
			input.id,
			auth.token,
		);

		if (toBool(existing.deleted)) {
			throw new ApiError(
				'note_in_trash',
				'Note is in the trash and cannot be updated. Restore it in the Simplenote app to edit.',
			);
		}

		const existingSystemTags = Array.isArray(existing.systemTags)
			? existing.systemTags.filter((t): t is string => typeof t === 'string')
			: [];

		// Skip the POST entirely when every provided field already matches
		// existing state. Avoids version churn and wasted writes from retry loops.
		if (isUpdateNoOp(input, existing, existingSystemTags)) {
			return { id: input.id, version: existingVersion };
		}

		this.checkWriteRate();

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

		this.recordWrite();

		// Invalidate cache so subsequent reads see the updated note
		this.clearCache();

		return { id: input.id, version: result.version };
	}

	async trashNote(id: string): Promise<NormalizedNote> {
		const auth = await loadToken();
		if (!auth) {
			throw new ApiError(
				'no_token',
				'Not logged in. Run `simplenote-mcp setup` to authenticate.',
			);
		}

		// Fetch the raw record so we preserve fields we don't model in
		// NormalizedNote (publishURL, shareURL, creationDate, unknown
		// systemTags, etc.). Simperium's REST POST replaces the note body, so
		// a partial POST would wipe those fields. Same approach as updateNote.
		// The fresh GET also catches the case where another client trashed the
		// note between any caller's cached pre-check and now.
		const { data: existing } = await fetchRawNote(id, auth.token);

		// Already trashed: no POST. The fresh GET is authoritative, so drop
		// any stale cache that may disagree (cross-client race).
		if (toBool(existing.deleted)) {
			this.clearCache();
			return normalizeOrThrow(id, existing);
		}

		this.checkWriteRate();

		const nowUnix = Math.floor(Date.now() / 1000);
		const noteData: Record<string, unknown> = {
			...existing,
			deleted: true,
			modificationDate: nowUnix,
		};

		const ccid = randomUUID();
		await simperiumRequest({
			method: 'POST',
			path: `/note/i/${encodeURIComponent(id)}?ccid=${ccid}`,
			token: auth.token,
			body: noteData,
			context: 'trashing note',
		});

		this.recordWrite();
		this.clearCache();
		return normalizeOrThrow(id, noteData);
	}

	async restoreNote(id: string): Promise<NormalizedNote> {
		const auth = await loadToken();
		if (!auth) {
			throw new ApiError(
				'no_token',
				'Not logged in. Run `simplenote-mcp setup` to authenticate.',
			);
		}

		// Same fetch-merge-POST pattern as trashNote — the fresh GET preserves
		// fields we don't model (publishURL, shareURL, creationDate, unknown
		// systemTags) and catches cross-client races.
		const { data: existing } = await fetchRawNote(id, auth.token);

		// Already restored: no POST. The fresh GET is authoritative, so drop
		// any stale cache that may disagree (cross-client race).
		if (!toBool(existing.deleted)) {
			this.clearCache();
			return normalizeOrThrow(id, existing);
		}

		this.checkWriteRate();

		const nowUnix = Math.floor(Date.now() / 1000);
		const noteData: Record<string, unknown> = {
			...existing,
			deleted: false,
			modificationDate: nowUnix,
		};

		const ccid = randomUUID();
		await simperiumRequest({
			method: 'POST',
			path: `/note/i/${encodeURIComponent(id)}?ccid=${ccid}`,
			token: auth.token,
			body: noteData,
			context: 'restoring note',
		});

		this.recordWrite();
		this.clearCache();
		return normalizeOrThrow(id, noteData);
	}

	async getNoteVersion(id: string, version: number): Promise<NoteVersionResult> {
		if (!Number.isInteger(version) || version < 1) {
			throw new ApiError(
				'invalid_argument',
				`Invalid version ${version}: must be a positive integer.`,
			);
		}
		const auth = await loadToken();
		if (!auth) {
			throw new ApiError(
				'no_token',
				'Not logged in. Run `simplenote-mcp setup` to authenticate.',
			);
		}
		const data = await fetchNoteVersion(id, version, auth.token);
		const normalized = normalizeOrThrow(id, data);
		return { ...normalized, version };
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
			'Token rejected. Run `simplenote-mcp setup` to re-authenticate.',
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
): Promise<{ data: Record<string, unknown>; version: number }> {
	// Encode the id so a value like `../tag/i/x` can't be normalized away by
	// the URL parser and redirected to a different bucket.
	const res = await simperiumRequest({
		method: 'GET',
		path: `/note/i/${encodeURIComponent(noteId)}`,
		token,
		context: 'fetching note',
		passthroughStatus: [404],
	});
	if (res.status === 404) {
		throw new ApiError('not_found', `Note not found: ${noteId}`, 404);
	}

	const versionHeader = res.headers.get('X-Simperium-Version');
	const parsedVersion = versionHeader ? Number.parseInt(versionHeader, 10) : 0;
	const version = Number.isFinite(parsedVersion) ? parsedVersion : 0;

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
	return { data: body as Record<string, unknown>, version };
}

async function fetchNoteVersion(
	noteId: string,
	version: number,
	token: string,
): Promise<Record<string, unknown>> {
	const res = await simperiumRequest({
		method: 'GET',
		path: `/note/i/${encodeURIComponent(noteId)}/v/${version}`,
		token,
		context: 'fetching note version',
		passthroughStatus: [404],
	});
	if (res.status === 404) {
		// 404 here can mean either (a) the note exists but this specific
		// version is outside Simperium's retention window, or (b) the note
		// itself doesn't exist. Callers that want to disambiguate can
		// verify note existence via fetchRawNote first.
		throw new ApiError(
			'version_not_found',
			`Version ${version} of note ${noteId} not available; it may not exist or may be outside Simperium's retention window.`,
			404,
		);
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		throw new ApiError(
			'invalid_response',
			'Simperium note version returned invalid JSON.',
		);
	}
	if (!body || typeof body !== 'object') {
		throw new ApiError(
			'invalid_response',
			'Simperium note version response was not a JSON object.',
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
	// Encode the id so a value like `../tag/i/x` can't be normalized away by
	// the URL parser and redirected to a different bucket. ccid is a per-call
	// idempotency token: a retry after a network blip won't duplicate the note.
	const ccid = randomUUID();
	const res = await simperiumRequest({
		method: 'POST',
		path: `/note/i/${encodeURIComponent(noteId)}?ccid=${ccid}`,
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

// Wrap normalizeNote for callers that hold a known-good raw note body and
// want a hard failure instead of a nullable result.
function normalizeOrThrow(
	id: string,
	raw: Record<string, unknown>,
): NormalizedNote {
	const normalized = normalizeNote({ id, d: raw });
	if (!normalized) {
		throw new ApiError(
			'invalid_response',
			`Could not normalize note response for ${id}.`,
		);
	}
	return normalized;
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

function isUpdateNoOp(
	input: NoteUpdateInput,
	existing: Record<string, unknown>,
	existingSystemTags: readonly string[],
): boolean {
	if (input.content !== undefined && input.content !== existing.content) {
		return false;
	}
	if (input.tags !== undefined) {
		const existingTags = Array.isArray(existing.tags)
			? existing.tags.filter((t): t is string => typeof t === 'string')
			: [];
		if (!stringArraysSetEqual(input.tags, existingTags)) return false;
	}
	if (
		input.markdown !== undefined &&
		input.markdown !== existingSystemTags.includes('markdown')
	) {
		return false;
	}
	if (
		input.pinned !== undefined &&
		input.pinned !== existingSystemTags.includes('pinned')
	) {
		return false;
	}
	return true;
}

// Tags are semantically a set in Simplenote, so ['a', 'b'] and ['b', 'a'] are
// equivalent for the purposes of no-op detection. Compare via set sizes to
// handle duplicate entries correctly on either side.
function stringArraysSetEqual(a: readonly string[], b: readonly string[]): boolean {
	const setA = new Set(a);
	const setB = new Set(b);
	if (setA.size !== setB.size) return false;
	for (const t of setA) {
		if (!setB.has(t)) return false;
	}
	return true;
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

export const _test = {
	normalizeNote,
	normalizeTag,
	toBool,
	toIsoFromUnix,
	mergeSystemTags,
	simperiumRequest,
	fetchNoteVersion,
};
