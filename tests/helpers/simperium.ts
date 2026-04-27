import { afterEach, beforeEach, mock } from 'node:test';

export type FetchImpl = (
	url: string,
	opts?: RequestInit,
) => Promise<Response> | Response;

// Register before/afterEach hooks that ensure each test sees a deterministic
// SIMPLENOTE_TOKEN and that fetch mocks don't leak across cases.
export function setupTestToken(): void {
	let savedToken: string | undefined;
	beforeEach(() => {
		savedToken = process.env.SIMPLENOTE_TOKEN;
		process.env.SIMPLENOTE_TOKEN = 'test-token';
	});
	afterEach(() => {
		mock.restoreAll();
		if (savedToken === undefined) delete process.env.SIMPLENOTE_TOKEN;
		else process.env.SIMPLENOTE_TOKEN = savedToken;
	});
}

export function mockFetch(impl: FetchImpl): void {
	mock.method(globalThis, 'fetch', impl as unknown as typeof globalThis.fetch);
}

export type RawNote = {
	content?: string;
	tags?: string[];
	systemTags?: string[];
	deleted?: boolean;
	creationDate?: number;
	modificationDate?: number;
	publishURL?: string;
	shareURL?: string;
	[k: string]: unknown;
};

// Single-note GET response (Simperium /1/{app}/note/i/{id}). The optional
// `version` sets the X-Simperium-Version response header that callers use to
// detect the note's current version number.
export function rawNoteResponse(
	note: RawNote = {},
	opts: { version?: number } = {},
): Response {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (opts.version !== undefined) {
		headers['X-Simperium-Version'] = String(opts.version);
	}
	return new Response(
		JSON.stringify({
			content: '',
			tags: [],
			systemTags: [],
			deleted: false,
			creationDate: 1700000000,
			modificationDate: 1700000100,
			publishURL: '',
			shareURL: '',
			...note,
		}),
		{ status: 200, headers },
	);
}

export function emptyIndexResponse(): Response {
	return Response.json({ index: [], mark: undefined });
}

// Matches GET of a single note: /1/{app}/note/i/{id}  (no /index, no version).
export function isRawNoteGet(url: string, method?: string): boolean {
	return (
		(method === undefined || method === 'GET') &&
		/\/note\/i\/[^/?]+$/.test(url) &&
		!url.includes('/index')
	);
}

export function isNotePost(method?: string): boolean {
	return method === 'POST';
}
