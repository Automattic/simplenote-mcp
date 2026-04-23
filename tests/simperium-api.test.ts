import { afterEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { ApiError, createApiProvider, _test } from '../src/providers/simperium-api.ts';
import {
	emptyIndexResponse,
	isNotePost,
	isRawNoteGet,
	mockFetch,
	rawNoteResponse,
	setupTestToken,
} from './helpers/simperium.ts';

const { normalizeNote, normalizeTag, toBool, toIsoFromUnix, mergeSystemTags, simperiumRequest } =
	_test;

// Sets SIMPLENOTE_TOKEN for each test and restores mocks in afterEach.
// Harmless for the pure-helper suites below (which don't make HTTP calls).
setupTestToken();

// ---------- pure helpers ----------

describe('toBool', () => {
	it('handles boolean inputs', () => {
		assert.equal(toBool(true), true);
		assert.equal(toBool(false), false);
	});
	it('handles numeric inputs', () => {
		assert.equal(toBool(1), true);
		assert.equal(toBool(0), false);
	});
	it('handles string inputs', () => {
		assert.equal(toBool('1'), true);
		assert.equal(toBool('true'), true);
		assert.equal(toBool('TRUE'), true);
		assert.equal(toBool('0'), false);
		assert.equal(toBool('false'), false);
	});
	it('returns false for unknown / undefined / null', () => {
		assert.equal(toBool(undefined), false);
		assert.equal(toBool(null), false);
		assert.equal(toBool({}), false);
	});
});

describe('toIsoFromUnix', () => {
	it('converts a number to ISO', () => {
		assert.equal(toIsoFromUnix(0), '1970-01-01T00:00:00.000Z');
	});
	it('converts a numeric string', () => {
		assert.equal(toIsoFromUnix('1700000000'), new Date(1700000000_000).toISOString());
	});
	it('preserves fractional seconds', () => {
		assert.equal(toIsoFromUnix(1700000000.5), new Date(1700000000_500).toISOString());
	});
	it('returns null for non-finite / missing', () => {
		assert.equal(toIsoFromUnix(undefined), null);
		assert.equal(toIsoFromUnix('not a number'), null);
		assert.equal(toIsoFromUnix(NaN), null);
	});
});

describe('normalizeNote', () => {
	it('returns null when id is missing', () => {
		assert.equal(normalizeNote({ d: { content: 'x' } }), null);
	});

	it('returns null when data is missing', () => {
		assert.equal(normalizeNote({ id: 'abc' }), null);
	});

	it('builds a normalized note from a full payload', () => {
		const out = normalizeNote({
			id: 'abc-123',
			d: {
				content: 'Hello\nworld',
				tags: ['recipes', 'saved'],
				systemTags: ['pinned', 'markdown'],
				deleted: false,
				creationDate: 1700000000,
				modificationDate: 1700000100,
			},
		});
		assert.deepEqual(out, {
			id: 'abc-123',
			content: 'Hello\nworld',
			tags: ['recipes', 'saved'],
			pinned: true,
			markdown: true,
			deleted: false,
			created: new Date(1700000000_000).toISOString(),
			modified: new Date(1700000100_000).toISOString(),
		});
	});

	it('treats absent systemTags entries as false flags', () => {
		const out = normalizeNote({
			id: 'x',
			d: { content: '', systemTags: [] },
		});
		assert.equal(out?.pinned, false);
		assert.equal(out?.markdown, false);
	});

	it('filters non-string entries from tags / systemTags', () => {
		const out = normalizeNote({
			id: 'x',
			d: { tags: ['ok', 1, null, 'fine'], systemTags: ['pinned', 42] },
		});
		assert.deepEqual(out?.tags, ['ok', 'fine']);
		assert.equal(out?.pinned, true);
	});

	it('defaults content to empty string when missing', () => {
		const out = normalizeNote({ id: 'x', d: {} });
		assert.equal(out?.content, '');
		assert.equal(out?.created, null);
		assert.equal(out?.modified, null);
	});
});

describe('normalizeTag', () => {
	it('returns null when neither name nor id is usable', () => {
		assert.equal(normalizeTag({ d: {} }), null);
	});

	it('uses entry.id as a fallback when d.name is missing', () => {
		const out = normalizeTag({ id: 'recipes', d: { index: 5 } });
		assert.deepEqual(out, { name: 'recipes', index: 5 });
	});

	it('parses a numeric-string index', () => {
		const out = normalizeTag({ id: 'x', d: { name: 'work', index: '3' } });
		assert.deepEqual(out, { name: 'work', index: 3 });
	});

	it('defaults index to 0 when missing or unparseable', () => {
		assert.deepEqual(normalizeTag({ id: 'x', d: { name: 'a' } }), {
			name: 'a',
			index: 0,
		});
		assert.deepEqual(normalizeTag({ id: 'x', d: { name: 'a', index: 'nope' } }), {
			name: 'a',
			index: 0,
		});
	});
});

describe('mergeSystemTags', () => {
	it('returns empty when no existing tags and no toggles', () => {
		assert.deepEqual(mergeSystemTags([], {}), []);
	});

	it('adds toggled-on tags starting from empty', () => {
		assert.deepEqual(mergeSystemTags([], { markdown: true }), ['markdown']);
		assert.deepEqual(mergeSystemTags([], { pinned: true }), ['pinned']);
		assert.deepEqual(
			mergeSystemTags([], { markdown: true, pinned: true }).sort(),
			['markdown', 'pinned'],
		);
	});

	it('preserves existing tags when toggles are undefined', () => {
		assert.deepEqual(mergeSystemTags(['unread', 'markdown'], {}), ['unread', 'markdown']);
		assert.deepEqual(
			mergeSystemTags(['unread'], { markdown: undefined, pinned: undefined }),
			['unread'],
		);
	});

	it('removes a tag when toggle is false, leaves unrelated tags alone', () => {
		assert.deepEqual(
			mergeSystemTags(['markdown', 'pinned', 'unread'], { markdown: false }).sort(),
			['pinned', 'unread'],
		);
	});

	it('adds a tag when toggle is true, leaves unrelated tags alone', () => {
		assert.deepEqual(
			mergeSystemTags(['unread'], { pinned: true }).sort(),
			['pinned', 'unread'],
		);
	});

	it('is idempotent when toggle matches existing state', () => {
		assert.deepEqual(mergeSystemTags(['markdown'], { markdown: true }), ['markdown']);
		assert.deepEqual(mergeSystemTags(['unread'], { markdown: false }), ['unread']);
	});
});

// ---------- request primitive ----------

describe('simperiumRequest', () => {
	it('builds URL from API_BASE + APP_ID + path', async () => {
		let capturedUrl: string | undefined;
		mockFetch(async (url) => {
			capturedUrl = url;
			return new Response('', { status: 200 });
		});

		await simperiumRequest({
			method: 'GET',
			path: '/note/i/abc',
			token: 't',
			context: 'fetching note',
		});

		assert.match(capturedUrl!, /^https:\/\/api\.simperium\.com\/1\/[^/]+\/note\/i\/abc$/);
	});

	it('attaches X-Simperium-Token header', async () => {
		let capturedHeaders: Record<string, string> | undefined;
		mockFetch(async (_url, opts) => {
			capturedHeaders = Object.fromEntries(
				Object.entries(opts?.headers ?? {}).map(([k, v]) => [k, String(v)]),
			);
			return new Response('', { status: 200 });
		});

		await simperiumRequest({ method: 'GET', path: '/x', token: 'my-token', context: 'x' });
		assert.equal(capturedHeaders!['X-Simperium-Token'], 'my-token');
	});

	it('omits Content-Type and body when no body is given', async () => {
		let capturedHeaders: Record<string, string> | undefined;
		let capturedBody: unknown;
		mockFetch(async (_url, opts) => {
			capturedHeaders = Object.fromEntries(
				Object.entries(opts?.headers ?? {}).map(([k, v]) => [k, String(v)]),
			);
			capturedBody = opts?.body;
			return new Response('', { status: 200 });
		});

		await simperiumRequest({ method: 'GET', path: '/x', token: 't', context: 'x' });
		assert.equal(capturedHeaders!['Content-Type'], undefined);
		assert.equal(capturedBody, undefined);
	});

	it('sets Content-Type and JSON-encodes body when body is given', async () => {
		let capturedHeaders: Record<string, string> | undefined;
		let capturedBody: string | undefined;
		mockFetch(async (_url, opts) => {
			capturedHeaders = Object.fromEntries(
				Object.entries(opts?.headers ?? {}).map(([k, v]) => [k, String(v)]),
			);
			capturedBody = opts?.body as string | undefined;
			return new Response('', { status: 200 });
		});

		await simperiumRequest({
			method: 'POST',
			path: '/x',
			token: 't',
			body: { foo: 1 },
			context: 'x',
		});
		assert.equal(capturedHeaders!['Content-Type'], 'application/json');
		assert.deepEqual(JSON.parse(capturedBody!), { foo: 1 });
	});

	it('throws network_error with context when fetch throws', async () => {
		mockFetch(async () => {
			throw new Error('boom');
		});

		await assert.rejects(
			() =>
				simperiumRequest({
					method: 'GET',
					path: '/x',
					token: 't',
					context: 'fetching widget',
				}),
			(err: unknown) =>
				err instanceof ApiError &&
				err.code === 'network_error' &&
				err.message.includes('fetching widget') &&
				err.message.includes('boom'),
		);
	});

	it('throws unauthorized on 401', async () => {
		mockFetch(async () => new Response('', { status: 401 }));

		await assert.rejects(
			() => simperiumRequest({ method: 'GET', path: '/x', token: 't', context: 'x' }),
			(err: unknown) =>
				err instanceof ApiError && err.code === 'unauthorized' && err.status === 401,
		);
	});

	it('throws request_failed on non-2xx by default, including context and status', async () => {
		mockFetch(async () => new Response('', { status: 503 }));

		await assert.rejects(
			() =>
				simperiumRequest({
					method: 'GET',
					path: '/x',
					token: 't',
					context: 'doing X',
				}),
			(err: unknown) =>
				err instanceof ApiError &&
				err.code === 'request_failed' &&
				err.status === 503 &&
				err.message.includes('doing X') &&
				err.message.includes('503'),
		);
	});

	it('returns the Response for a status listed in passthroughStatus', async () => {
		mockFetch(async () => new Response('', { status: 404 }));

		const res = await simperiumRequest({
			method: 'GET',
			path: '/x',
			token: 't',
			context: 'x',
			passthroughStatus: [404],
		});
		assert.equal(res.status, 404);
	});

	it('still throws unauthorized for 401 even when 401 is in passthroughStatus', async () => {
		// 401 is special-cased before the passthrough check — auth failures must
		// always surface, even if a caller tried to handle them.
		mockFetch(async () => new Response('', { status: 401 }));

		await assert.rejects(
			() =>
				simperiumRequest({
					method: 'GET',
					path: '/x',
					token: 't',
					context: 'x',
					passthroughStatus: [401],
				}),
			(err: unknown) => err instanceof ApiError && err.code === 'unauthorized',
		);
	});
});

// ---------- provider.createNote ----------

describe('createNote', () => {
	it('sends a POST to the Simperium API with correct payload', async () => {
		const provider = createApiProvider();
		let capturedUrl: string | undefined;
		let capturedBody: Record<string, unknown> | undefined;
		let capturedHeaders: Record<string, string> | undefined;

		mockFetch(async (url: string, opts?: RequestInit) => {
			capturedUrl = url;
			capturedHeaders = Object.fromEntries(
				Object.entries(opts?.headers ?? {}).map(([k, v]) => [k, String(v)]),
			);
			capturedBody = JSON.parse(opts?.body as string);
			return new Response('1', { status: 200 });
		});

		const result = await provider.createNote!({
			content: 'Test note content',
			tags: ['test'],
			markdown: true,
			pinned: false,
		});

		// Verify URL pattern
		assert.match(capturedUrl!, /api\.simperium\.com\/1\/[^/]+\/note\/i\/[a-f0-9-]+/);

		// Verify headers
		assert.equal(capturedHeaders!['X-Simperium-Token'], 'test-token');
		assert.equal(capturedHeaders!['Content-Type'], 'application/json');

		// Verify body structure
		assert.equal(capturedBody!.content, 'Test note content');
		assert.deepEqual(capturedBody!.tags, ['test']);
		assert.deepEqual(capturedBody!.systemTags, ['markdown']);
		assert.equal(capturedBody!.deleted, false);
		assert.equal(capturedBody!.publishURL, '');
		assert.equal(capturedBody!.shareURL, '');
		assert.equal(typeof capturedBody!.creationDate, 'number');
		assert.equal(typeof capturedBody!.modificationDate, 'number');

		// Verify result
		assert.equal(typeof result.id, 'string');
		assert.ok(result.id.length > 0);
		assert.equal(result.version, 1);
	});

	it('includes pinned in systemTags when pinned=true', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;

		mockFetch(async (_url: string, opts?: RequestInit) => {
			capturedBody = JSON.parse(opts?.body as string);
			return new Response('1', { status: 200 });
		});

		await provider.createNote!({
			content: 'Pinned note',
			pinned: true,
		});

		assert.ok((capturedBody!.systemTags as string[]).includes('pinned'));
		assert.ok((capturedBody!.systemTags as string[]).includes('markdown'));
	});

	it('excludes markdown from systemTags when markdown=false', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;

		mockFetch(async (_url: string, opts?: RequestInit) => {
			capturedBody = JSON.parse(opts?.body as string);
			return new Response('1', { status: 200 });
		});

		await provider.createNote!({
			content: 'Plain text note',
			markdown: false,
		});

		assert.ok(!(capturedBody!.systemTags as string[]).includes('markdown'));
	});

	it('clears cache after creating a note', async () => {
		const provider = createApiProvider();
		let fetchCount = 0;

		mockFetch(async (url: string) => {
			if (url.includes('/index')) {
				fetchCount++;
				return Response.json({ index: [], mark: undefined });
			}
			return new Response('1', { status: 200 });
		});

		// Initial load
		await provider.loadStore();
		assert.equal(fetchCount, 2); // note + tag indices

		// Load again (should use cache)
		await provider.loadStore();
		assert.equal(fetchCount, 2);

		// Create a note
		await provider.createNote!({ content: 'New note' });

		// Load again (cache should be cleared)
		await provider.loadStore();
		assert.equal(fetchCount, 4);
	});
});

// ---------- provider.updateNote ----------

describe('updateNote', () => {
	it('sends POST to the correct URL with note ID', async () => {
		const provider = createApiProvider();
		let capturedUrl: string | undefined;
		let capturedMethod: string | undefined;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'Original content' });
			}
			if (isNotePost(opts?.method)) {
				capturedUrl = url;
				capturedMethod = opts?.method;
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'test-note-123', content: 'Updated content' });

		assert.match(capturedUrl!, /api\.simperium\.com\/1\/[^/]+\/note\/i\/test-note-123(?:\?|$)/);
		assert.equal(capturedMethod, 'POST');
	});

	it('merges content update with existing note values', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Original',
					tags: ['existing-tag'],
					systemTags: ['markdown', 'pinned'],
				});
			}
			if (isNotePost(opts?.method)) {
				capturedBody = JSON.parse(opts?.body as string);
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'New content' });

		// Content should be updated
		assert.equal(capturedBody!.content, 'New content');
		// Tags should be preserved from existing note
		assert.deepEqual(capturedBody!.tags, ['existing-tag']);
		// SystemTags should preserve existing markdown and pinned
		assert.ok((capturedBody!.systemTags as string[]).includes('markdown'));
		assert.ok((capturedBody!.systemTags as string[]).includes('pinned'));
	});

	it('preserves publishURL, shareURL, and unknown systemTags', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Original',
					systemTags: ['markdown', 'unread', 'some-future-tag'],
					publishURL: 'https://simp.ly/p/abc123',
					shareURL: 'https://simp.ly/s/xyz789',
				});
			}
			if (isNotePost(opts?.method)) {
				capturedBody = JSON.parse(opts?.body as string);
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'New content' });

		assert.equal(capturedBody!.publishURL, 'https://simp.ly/p/abc123');
		assert.equal(capturedBody!.shareURL, 'https://simp.ly/s/xyz789');
		const systemTags = capturedBody!.systemTags as string[];
		assert.ok(systemTags.includes('markdown'));
		assert.ok(systemTags.includes('unread'));
		assert.ok(systemTags.includes('some-future-tag'));
	});

	it('preserves creationDate from existing note', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;
		const originalCreationDate = 1705314600;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Original',
					creationDate: originalCreationDate,
				});
			}
			if (isNotePost(opts?.method)) {
				capturedBody = JSON.parse(opts?.body as string);
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'Updated' });

		assert.equal(capturedBody!.creationDate, originalCreationDate);
	});

	it('updates modificationDate to current time', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;
		const beforeUpdate = Math.floor(Date.now() / 1000);

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'Original' });
			}
			if (isNotePost(opts?.method)) {
				capturedBody = JSON.parse(opts?.body as string);
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'Updated' });

		const afterUpdate = Math.floor(Date.now() / 1000);
		const modificationDate = capturedBody!.modificationDate as number;
		assert.ok(modificationDate >= beforeUpdate);
		assert.ok(modificationDate <= afterUpdate);
	});

	it('updates tags when provided', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Content',
					tags: ['old-tag'],
				});
			}
			if (isNotePost(opts?.method)) {
				capturedBody = JSON.parse(opts?.body as string);
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', tags: ['new-tag-1', 'new-tag-2'] });

		// Tags should be replaced entirely
		assert.deepEqual(capturedBody!.tags, ['new-tag-1', 'new-tag-2']);
		// Content should be preserved
		assert.equal(capturedBody!.content, 'Content');
	});

	it('removes markdown from systemTags when markdown=false, preserves others', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Content',
					systemTags: ['markdown', 'pinned', 'unread'],
				});
			}
			if (isNotePost(opts?.method)) {
				capturedBody = JSON.parse(opts?.body as string);
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', markdown: false });

		const systemTags = capturedBody!.systemTags as string[];
		assert.ok(!systemTags.includes('markdown'));
		assert.ok(systemTags.includes('pinned'));
		assert.ok(systemTags.includes('unread'));
	});

	it('adds pinned to systemTags when pinned=true, preserves others', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Content',
					systemTags: ['markdown', 'unread'],
				});
			}
			if (isNotePost(opts?.method)) {
				capturedBody = JSON.parse(opts?.body as string);
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', pinned: true });

		const systemTags = capturedBody!.systemTags as string[];
		assert.ok(systemTags.includes('pinned'));
		assert.ok(systemTags.includes('markdown'));
		assert.ok(systemTags.includes('unread'));
	});

	it('throws ApiError(not_found) when GET returns 404', async () => {
		const provider = createApiProvider();

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return new Response('', { status: 404 });
			}
			return new Response('', { status: 200 });
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'non-existent-note', content: 'Test' }),
			(err: unknown) => err instanceof ApiError && err.code === 'not_found',
		);
	});

	it('throws ApiError(unauthorized) on 401 from POST', async () => {
		const provider = createApiProvider();

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'Content' });
			}
			return new Response('', { status: 401 });
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'note-1', content: 'Test' }),
			(err: unknown) => err instanceof ApiError && err.code === 'unauthorized',
		);
	});

	it('throws ApiError(request_failed) on non-2xx from POST', async () => {
		const provider = createApiProvider();

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'Content' });
			}
			return new Response('', { status: 500 });
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'note-1', content: 'Test' }),
			(err: unknown) =>
				err instanceof ApiError &&
				err.code === 'request_failed' &&
				err.message.includes('updating'),
		);
	});

	it('throws ApiError(network_error) with "updating" label when POST fetch throws', async () => {
		const provider = createApiProvider();

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'Content' });
			}
			throw new Error('Network failure');
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'note-1', content: 'Test' }),
			(err: unknown) =>
				err instanceof ApiError &&
				err.code === 'network_error' &&
				err.message.includes('updating'),
		);
	});

	it('parses version from response body', async () => {
		const provider = createApiProvider();

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'Content' });
			}
			return new Response('42', { status: 200 });
		});

		const result = await provider.updateNote!({ id: 'note-1', content: 'Updated' });
		assert.equal(result.version, 42);
	});

	it('clears cache after updating a note', async () => {
		const provider = createApiProvider();
		let indexFetchCount = 0;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (url.includes('/index')) {
				indexFetchCount++;
				return Response.json({ index: [], mark: undefined });
			}
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'Content' });
			}
			return new Response('2', { status: 200 });
		});

		// Initial load (two index fetches: note + tag)
		await provider.loadStore();
		assert.equal(indexFetchCount, 2);

		// Cached load
		await provider.loadStore();
		assert.equal(indexFetchCount, 2);

		await provider.updateNote!({ id: 'note-1', content: 'New content' });

		// Load again — cache should be cleared, so two more index fetches
		await provider.loadStore();
		assert.equal(indexFetchCount, 4);
	});
});

// ---------- provider.loadStore caching ----------

describe('loadStore stale-cache fallback', () => {
	// Timers are enabled per-test; reset so one test's fake Date doesn't leak into another.
	afterEach(() => mock.timers.reset());

	it('returns cached data on network_error after TTL expiry', async () => {
		mock.timers.enable({ apis: ['Date'] });
		const provider = createApiProvider();

		mockFetch(async () => emptyIndexResponse());
		const first = await provider.loadStore();

		mock.timers.tick(61_000);
		mockFetch(async () => {
			throw new Error('ENOTFOUND');
		});
		const second = await provider.loadStore();
		assert.deepEqual(second, first);
	});

	it('returns cached data on request_failed (5xx) after TTL expiry', async () => {
		mock.timers.enable({ apis: ['Date'] });
		const provider = createApiProvider();

		mockFetch(async () => emptyIndexResponse());
		const first = await provider.loadStore();

		mock.timers.tick(61_000);
		mockFetch(async () => new Response('', { status: 503 }));
		const second = await provider.loadStore();
		assert.deepEqual(second, first);
	});

	it('rethrows unauthorized (401) instead of serving stale cache', async () => {
		mock.timers.enable({ apis: ['Date'] });
		const provider = createApiProvider();

		mockFetch(async () => emptyIndexResponse());
		await provider.loadStore();

		mock.timers.tick(61_000);
		mockFetch(async () => new Response('', { status: 401 }));
		await assert.rejects(
			() => provider.loadStore(),
			(err: unknown) => err instanceof ApiError && err.code === 'unauthorized',
		);
	});

	it('rethrows invalid_response instead of serving stale cache', async () => {
		mock.timers.enable({ apis: ['Date'] });
		const provider = createApiProvider();

		mockFetch(async () => emptyIndexResponse());
		await provider.loadStore();

		mock.timers.tick(61_000);
		mockFetch(async () => new Response('not json', { status: 200 }));
		await assert.rejects(
			() => provider.loadStore(),
			(err: unknown) => err instanceof ApiError && err.code === 'invalid_response',
		);
	});
});
