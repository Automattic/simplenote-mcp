import { afterEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { ApiError, createApiProvider, _test } from '../src/providers/simperium-api.ts';
import { captureFetch, mockFetch, useEnvVar } from './helpers/general.ts';
import {
	emptyIndexResponse,
	isNotePost,
	isRawNoteGet,
	rawNoteResponse,
} from './helpers/simperium.ts';

const {
	normalizeNote,
	normalizeTag,
	toBool,
	toIsoFromUnix,
	mergeSystemTags,
	simperiumRequest,
	fetchNoteVersion,
} = _test;

// Pin SIMPLENOTE_TOKEN to a known value per test, and reset mocks afterwards.
// Harmless for the pure-helper suites below (which don't make HTTP calls).
useEnvVar('SIMPLENOTE_TOKEN', 'test-token');
afterEach(() => mock.restoreAll());

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
		const captured = captureFetch(() => new Response('', { status: 200 }));

		await simperiumRequest({
			method: 'GET',
			path: '/note/i/abc',
			token: 't',
			context: 'fetching note',
		});

		assert.match(
			captured.calls[0]!.url,
			/^https:\/\/api\.simperium\.com\/1\/[^/]+\/note\/i\/abc$/,
		);
	});

	it('attaches X-Simperium-Token header', async () => {
		const captured = captureFetch(() => new Response('', { status: 200 }));

		await simperiumRequest({ method: 'GET', path: '/x', token: 'my-token', context: 'x' });
		assert.equal(captured.calls[0]!.headers['X-Simperium-Token'], 'my-token');
	});

	it('omits Content-Type and body when no body is given', async () => {
		const captured = captureFetch(() => new Response('', { status: 200 }));

		await simperiumRequest({ method: 'GET', path: '/x', token: 't', context: 'x' });
		assert.equal(captured.calls[0]!.headers['Content-Type'], undefined);
		assert.equal(captured.calls[0]!.body, undefined);
	});

	it('sets Content-Type and JSON-encodes body when body is given', async () => {
		const captured = captureFetch(() => new Response('', { status: 200 }));

		await simperiumRequest({
			method: 'POST',
			path: '/x',
			token: 't',
			body: { foo: 1 },
			context: 'x',
		});
		assert.equal(captured.calls[0]!.headers['Content-Type'], 'application/json');
		assert.equal(captured.calls[0]!.rawBody, JSON.stringify({ foo: 1 }));
		assert.deepEqual(captured.calls[0]!.body, { foo: 1 });
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

// ---------- fetchNoteVersion ----------

describe('fetchNoteVersion', () => {
	it('GETs /note/i/{id}/v/{version} and returns the body', async () => {
		const captured = captureFetch((url) => {
			if (/\/note\/i\/abc\/v\/3$/.test(url)) {
				return new Response(
					JSON.stringify({ content: 'old text', tags: ['t'] }),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const result = await fetchNoteVersion('abc', 3, 'test-token');

		assert.equal(result.content, 'old text');
		assert.deepEqual(result.tags, ['t']);
		assert.equal(captured.calls.length, 1);
		assert.match(captured.calls[0]!.url, /\/note\/i\/abc\/v\/3$/);
	});

	it('throws ApiError(version_not_found) on 404', async () => {
		captureFetch(() => new Response('', { status: 404 }));
		await assert.rejects(
			() => fetchNoteVersion('abc', 999, 'test-token'),
			(err: ApiError) =>
				err instanceof ApiError &&
				err.code === 'version_not_found' &&
				err.message.includes('999') &&
				err.message.includes('abc'),
		);
	});

	it('URL-encodes the note id', async () => {
		const captured = captureFetch(() => new Response('{}', { status: 200 }));
		await fetchNoteVersion('../tag/i/x', 1, 't');
		assert.ok(captured.calls[0]!.url.endsWith('/note/i/..%2Ftag%2Fi%2Fx/v/1'));
	});
});

// ---------- provider.createNote ----------

describe('createNote', () => {
	it('sends a POST to the Simperium API with correct payload', async () => {
		const provider = createApiProvider();
		const captured = captureFetch(() => new Response('1', { status: 200 }));

		const result = await provider.createNote!({
			content: 'Test note content',
			tags: ['test'],
			markdown: true,
			pinned: false,
		});

		const call = captured.calls[0]!;
		const body = call.body as Record<string, unknown>;

		// Verify URL pattern
		assert.match(call.url, /api\.simperium\.com\/1\/[^/]+\/note\/i\/[a-f0-9-]+/);

		// Verify headers
		assert.equal(call.headers['X-Simperium-Token'], 'test-token');
		assert.equal(call.headers['Content-Type'], 'application/json');

		// Verify body structure
		assert.equal(body.content, 'Test note content');
		assert.deepEqual(body.tags, ['test']);
		assert.deepEqual(body.systemTags, ['markdown']);
		assert.equal(body.deleted, false);
		assert.equal(body.publishURL, '');
		assert.equal(body.shareURL, '');
		assert.equal(typeof body.creationDate, 'number');
		assert.equal(typeof body.modificationDate, 'number');

		// Verify result
		assert.equal(typeof result.id, 'string');
		assert.ok(result.id.length > 0);
		assert.equal(result.version, 1);
	});

	it('includes pinned in systemTags when pinned=true', async () => {
		const provider = createApiProvider();
		const captured = captureFetch(() => new Response('1', { status: 200 }));

		await provider.createNote!({
			content: 'Pinned note',
			pinned: true,
		});

		const systemTags = (captured.calls[0]!.body as Record<string, unknown>).systemTags as string[];
		assert.ok(systemTags.includes('pinned'));
		assert.ok(systemTags.includes('markdown'));
	});

	it('excludes markdown from systemTags when markdown=false', async () => {
		const provider = createApiProvider();
		const captured = captureFetch(() => new Response('1', { status: 200 }));

		await provider.createNote!({
			content: 'Plain text note',
			markdown: false,
		});

		const systemTags = (captured.calls[0]!.body as Record<string, unknown>).systemTags as string[];
		assert.ok(!systemTags.includes('markdown'));
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
		const captured = captureFetch((url, opts) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'Original content' });
			}
			if (isNotePost(opts?.method)) {
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'test-note-123', content: 'Updated content' });

		const post = captured.calls.find((c) => c.method === 'POST')!;
		assert.match(post.url, /api\.simperium\.com\/1\/[^/]+\/note\/i\/test-note-123(?:\?|$)/);
		assert.equal(post.method, 'POST');
	});

	it('merges content update with existing note values', async () => {
		const provider = createApiProvider();
		const captured = captureFetch((url, opts) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Original',
					tags: ['existing-tag'],
					systemTags: ['markdown', 'pinned'],
				});
			}
			if (isNotePost(opts?.method)) {
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'New content' });

		const body = captured.calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
		// Content should be updated
		assert.equal(body.content, 'New content');
		// Tags should be preserved from existing note
		assert.deepEqual(body.tags, ['existing-tag']);
		// SystemTags should preserve existing markdown and pinned
		assert.ok((body.systemTags as string[]).includes('markdown'));
		assert.ok((body.systemTags as string[]).includes('pinned'));
	});

	it('preserves publishURL, shareURL, and unknown systemTags', async () => {
		const provider = createApiProvider();
		const captured = captureFetch((url, opts) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Original',
					systemTags: ['markdown', 'unread', 'some-future-tag'],
					publishURL: 'https://simp.ly/p/abc123',
					shareURL: 'https://simp.ly/s/xyz789',
				});
			}
			if (isNotePost(opts?.method)) {
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'New content' });

		const body = captured.calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
		assert.equal(body.publishURL, 'https://simp.ly/p/abc123');
		assert.equal(body.shareURL, 'https://simp.ly/s/xyz789');
		const systemTags = body.systemTags as string[];
		assert.ok(systemTags.includes('markdown'));
		assert.ok(systemTags.includes('unread'));
		assert.ok(systemTags.includes('some-future-tag'));
	});

	it('preserves creationDate from existing note', async () => {
		const provider = createApiProvider();
		const originalCreationDate = 1705314600;
		const captured = captureFetch((url, opts) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Original',
					creationDate: originalCreationDate,
				});
			}
			if (isNotePost(opts?.method)) {
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'Updated' });

		const body = captured.calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
		assert.equal(body.creationDate, originalCreationDate);
	});

	it('updates modificationDate to current time', async () => {
		const provider = createApiProvider();
		const beforeUpdate = Math.floor(Date.now() / 1000);
		const captured = captureFetch((url, opts) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'Original' });
			}
			if (isNotePost(opts?.method)) {
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'Updated' });

		const afterUpdate = Math.floor(Date.now() / 1000);
		const body = captured.calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
		const modificationDate = body.modificationDate as number;
		assert.ok(modificationDate >= beforeUpdate);
		assert.ok(modificationDate <= afterUpdate);
	});

	it('updates tags when provided', async () => {
		const provider = createApiProvider();
		const captured = captureFetch((url, opts) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Content',
					tags: ['old-tag'],
				});
			}
			if (isNotePost(opts?.method)) {
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', tags: ['new-tag-1', 'new-tag-2'] });

		const body = captured.calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
		// Tags should be replaced entirely
		assert.deepEqual(body.tags, ['new-tag-1', 'new-tag-2']);
		// Content should be preserved
		assert.equal(body.content, 'Content');
	});

	it('removes markdown from systemTags when markdown=false, preserves others', async () => {
		const provider = createApiProvider();
		const captured = captureFetch((url, opts) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Content',
					systemTags: ['markdown', 'pinned', 'unread'],
				});
			}
			if (isNotePost(opts?.method)) {
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', markdown: false });

		const body = captured.calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
		const systemTags = body.systemTags as string[];
		assert.ok(!systemTags.includes('markdown'));
		assert.ok(systemTags.includes('pinned'));
		assert.ok(systemTags.includes('unread'));
	});

	it('adds pinned to systemTags when pinned=true, preserves others', async () => {
		const provider = createApiProvider();
		const captured = captureFetch((url, opts) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({
					content: 'Content',
					systemTags: ['markdown', 'unread'],
				});
			}
			if (isNotePost(opts?.method)) {
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', pinned: true });

		const body = captured.calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
		const systemTags = body.systemTags as string[];
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

	it('throws ApiError(note_in_trash) when the note is in the trash', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'Original', deleted: true });
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'trashed-note', content: 'Updated' }),
			(err: unknown) => err instanceof ApiError && err.code === 'note_in_trash',
		);
		assert.equal(postCalled, false, 'POST should not be issued for a trashed note');
	});

	it('throws ApiError(empty_content) when content is an empty string', async () => {
		const provider = createApiProvider();
		let fetchCalled = false;

		mockFetch(async () => {
			fetchCalled = true;
			return new Response('', { status: 200 });
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'note-1', content: '' }),
			(err: unknown) => err instanceof ApiError && err.code === 'empty_content',
		);
		assert.equal(fetchCalled, false, 'No HTTP request should be issued for empty content');
	});

	it('throws ApiError(empty_content) when content is whitespace only', async () => {
		const provider = createApiProvider();
		let fetchCalled = false;

		mockFetch(async () => {
			fetchCalled = true;
			return new Response('', { status: 200 });
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'note-1', content: '   \n\t  ' }),
			(err: unknown) => err instanceof ApiError && err.code === 'empty_content',
		);
		assert.equal(fetchCalled, false, 'No HTTP request should be issued for whitespace content');
	});

	it('skips POST and returns existing version when content matches existing', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'unchanged' }, { version: 7 });
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('99', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		const result = await provider.updateNote!({ id: 'note-1', content: 'unchanged' });

		assert.equal(postCalled, false, 'No-op update should not POST');
		assert.equal(result.id, 'note-1');
		assert.equal(result.version, 7);
	});

	it('skips POST when tags match existing tags', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse(
					{ content: 'Content', tags: ['a', 'b'] },
					{ version: 3 },
				);
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('99', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		const result = await provider.updateNote!({ id: 'note-1', tags: ['a', 'b'] });

		assert.equal(postCalled, false);
		assert.equal(result.version, 3);
	});

	it('POSTs when input and existing tag arrays have equal length but different sets', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		// Existing has a duplicate; naive "every input element is in existing"
		// would incorrectly treat these as equal.
		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse(
					{ content: 'Content', tags: ['a', 'a'] },
					{ version: 2 },
				);
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('3', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', tags: ['a', 'b'] });

		assert.equal(postCalled, true, 'Different tag sets should POST even at equal array length');
	});

	it('skips POST when tags match existing tags in different order', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse(
					{ content: 'Content', tags: ['a', 'b', 'c'] },
					{ version: 8 },
				);
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('99', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		const result = await provider.updateNote!({
			id: 'note-1',
			tags: ['c', 'a', 'b'],
		});

		assert.equal(postCalled, false, 'Reordered but equal tag set should be a no-op');
		assert.equal(result.version, 8);
	});

	it('skips POST when markdown flag matches existing systemTags', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse(
					{ content: 'Content', systemTags: ['markdown'] },
					{ version: 5 },
				);
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('99', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		const result = await provider.updateNote!({ id: 'note-1', markdown: true });

		assert.equal(postCalled, false);
		assert.equal(result.version, 5);
	});

	it('POSTs when at least one provided field differs from existing', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse(
					{ content: 'Same', tags: ['a'] },
					{ version: 4 },
				);
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('5', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'Same', tags: ['a', 'new'] });

		assert.equal(postCalled, true, 'Partial no-op should still POST');
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

	it('throws ApiError(suspicious_shrink) when content shrinks dramatically', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		const original = 'a'.repeat(1000);
		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: original });
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'note-1', content: 'b'.repeat(200) }),
			(err: unknown) => err instanceof ApiError && err.code === 'suspicious_shrink',
		);
		assert.equal(postCalled, false, 'POST should not be issued for a suspicious shrink');
	});

	it('allows shrink when existing content is at the 500-char gate', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'a'.repeat(500) });
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'b'.repeat(50) });
		assert.equal(postCalled, true, 'POST should be issued for shrinks below the gate');
	});

	it('allows shrink at exactly the 50% boundary', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'a'.repeat(1000) });
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'b'.repeat(500) });
		assert.equal(postCalled, true, 'POST should be issued at the 50% boundary');
	});

	it('skips suspicious_shrink check when content is undefined (tags-only update)', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'a'.repeat(1000), tags: ['old'] });
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', tags: ['new'] });
		assert.equal(postCalled, true, 'Tags-only update on a long note should still POST');
	});

	it('does not crash when existing.content is missing from the raw record', async () => {
		const provider = createApiProvider();
		let postCalled = false;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				// Simulate a malformed/legacy record with no content field.
				return rawNoteResponse({ content: undefined as unknown as string });
			}
			if (isNotePost(opts?.method)) {
				postCalled = true;
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.updateNote!({ id: 'note-1', content: 'a'.repeat(100) });
		assert.equal(postCalled, true, 'Update should succeed when existing content is absent');
	});
});

describe('getNoteVersion', () => {
	it('returns a normalized note with the requested version', async () => {
		const provider = createApiProvider();
		captureFetch((url) => {
			if (/\/note\/i\/note-1\/v\/5$/.test(url)) {
				return new Response(
					JSON.stringify({
						content: 'Old title\nbody',
						tags: ['work'],
						systemTags: ['markdown'],
						deleted: false,
						creationDate: 1700000000,
						modificationDate: 1700000100,
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const result = await provider.getNoteVersion!('note-1', 5);

		assert.equal(result.id, 'note-1');
		assert.equal(result.version, 5);
		assert.equal(result.content, 'Old title\nbody');
		assert.deepEqual(result.tags, ['work']);
		assert.equal(result.markdown, true);
		assert.equal(result.deleted, false);
		assert.equal(result.modified, '2023-11-14T22:15:00.000Z');
	});

	it('throws version_not_found on 404', async () => {
		const provider = createApiProvider();
		captureFetch(() => new Response('', { status: 404 }));
		await assert.rejects(
			() => provider.getNoteVersion!('note-1', 999),
			(err: ApiError) =>
				err instanceof ApiError && err.code === 'version_not_found',
		);
	});

	it('rejects non-positive version before any fetch', async () => {
		const provider = createApiProvider();
		let fetched = false;
		mockFetch(async () => {
			fetched = true;
			return new Response('{}', { status: 200 });
		});
		await assert.rejects(() => provider.getNoteVersion!('note-1', 0));
		await assert.rejects(() => provider.getNoteVersion!('note-1', -1));
		await assert.rejects(() => provider.getNoteVersion!('note-1', 1.5));
		assert.equal(fetched, false);
	});

	it('does not consume the write budget', async () => {
		const provider = createApiProvider();
		// Saturate the budget with successful updates first.
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse({ content: 'orig' });
			}
			if (isNotePost(init?.method)) {
				return new Response('2', { status: 200 });
			}
			if (/\/v\/\d+$/.test(url)) {
				return new Response(
					JSON.stringify({ content: 'v', modificationDate: 1700000100 }),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});
		for (let i = 0; i < 5; i++) {
			await provider.updateNote!({ id: 'note-1', content: `change ${i}` });
		}
		// updateNote would now throw rate_limited; getNoteVersion must not.
		const result = await provider.getNoteVersion!('note-1', 1);
		assert.equal(result.id, 'note-1');
	});
});

describe('getNoteHistory', () => {
	it('returns entries sorted descending by version with code-point-safe previews', async () => {
		const provider = createApiProvider();
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method) && url.endsWith('/note/i/note-1')) {
				return rawNoteResponse(
					{ content: 'current content', modificationDate: 1700000300 },
					{ version: 3 },
				);
			}
			const m = url.match(/\/note\/i\/note-1\/v\/(\d+)$/);
			if (m) {
				const v = Number(m[1]);
				return new Response(
					JSON.stringify({
						content: `version-${v} content`,
						modificationDate: 1700000000 + v * 100,
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		const result = await provider.getNoteHistory!('note-1', 10);

		assert.equal(result.id, 'note-1');
		assert.equal(result.current_version, 3);
		assert.equal(result.entries.length, 3);
		assert.deepEqual(
			result.entries.map((e) => e.version),
			[3, 2, 1],
		);
		assert.equal(result.entries[0]!.content_preview, 'version-3 content');
		assert.match(result.entries[0]!.modified_at!, /^2023-/);
	});

	it('truncates content_preview to 100 code points with a single-char ellipsis', async () => {
		const provider = createApiProvider();
		// 150 chars, all ASCII.
		const longContent = 'x'.repeat(150);
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse({ content: longContent }, { version: 1 });
			}
			if (/\/v\/1$/.test(url)) {
				return new Response(
					JSON.stringify({ content: longContent, modificationDate: 1700000000 }),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		const result = await provider.getNoteHistory!('note-1', 5);

		const preview = result.entries[0]!.content_preview;
		assert.equal(Array.from(preview).length, 101);
		assert.ok(preview.endsWith('…'));
	});

	it('handles multi-byte content without splitting code points', async () => {
		const provider = createApiProvider();
		// One ASCII char + 120 emoji misaligns the UTF-16 boundary at position 100:
		// a naive `slice(0, 100)` would slice between the surrogate halves of the
		// 50th emoji, producing an invalid string. Code-point-safe truncation
		// must land on a complete emoji.
		const mixedContent = 'a' + '😀'.repeat(120);
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse({ content: mixedContent }, { version: 1 });
			}
			if (/\/v\/1$/.test(url)) {
				return new Response(
					JSON.stringify({ content: mixedContent, modificationDate: 1700000000 }),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		const result = await provider.getNoteHistory!('note-1', 5);

		const preview = result.entries[0]!.content_preview;
		// 1 ASCII + 99 emoji + 1 ellipsis = 101 code points.
		assert.equal(Array.from(preview).length, 101);
		assert.equal(preview, 'a' + '😀'.repeat(99) + '…');
	});

	it('caps concurrent version fetches at HISTORY_FETCH_CONCURRENCY', async () => {
		const provider = createApiProvider();
		let inflight = 0;
		let maxInflight = 0;
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse({ content: 'curr' }, { version: 25 });
			}
			if (/\/v\/\d+$/.test(url)) {
				inflight++;
				maxInflight = Math.max(maxInflight, inflight);
				return new Promise<Response>((resolve) => {
					setTimeout(() => {
						inflight--;
						resolve(
							new Response(
								JSON.stringify({ content: 'v', modificationDate: 1700000000 }),
								{ status: 200, headers: { 'content-type': 'application/json' } },
							),
						);
					}, 5);
				});
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		await provider.getNoteHistory!('note-1', 25);

		assert.ok(maxInflight <= 8, `expected max in-flight <= 8, got ${maxInflight}`);
		assert.ok(maxInflight > 1, `expected concurrency > 1 (parallelism is real), got ${maxInflight}`);
	});

	it('drops pruned versions silently (404), exposing the gap via version numbers', async () => {
		const provider = createApiProvider();
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method) && url.endsWith('/note/i/note-1')) {
				return rawNoteResponse({ content: 'curr' }, { version: 5 });
			}
			const m = url.match(/\/v\/(\d+)$/);
			if (m) {
				const v = Number(m[1]);
				if (v === 3 || v === 2) {
					return new Response('', { status: 404 });
				}
				return new Response(
					JSON.stringify({ content: `v${v}`, modificationDate: 1700000000 }),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		const result = await provider.getNoteHistory!('note-1', 5);

		assert.equal(result.current_version, 5);
		assert.deepEqual(
			result.entries.map((e) => e.version),
			[5, 4, 1],
		);
	});

	it('returns entries: [] when current_version is 0 (defensive short-circuit)', async () => {
		const provider = createApiProvider();
		let versionFetches = 0;
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse({ content: 'x' }, { version: 0 });
			}
			if (/\/v\/\d+$/.test(url)) {
				versionFetches++;
				return new Response('{}', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		const result = await provider.getNoteHistory!('note-1', 10);

		assert.equal(result.current_version, 0);
		assert.deepEqual(result.entries, []);
		assert.equal(versionFetches, 0);
	});

	it('returns entries for a trashed note including pre-trash versions', async () => {
		const provider = createApiProvider();
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse(
					{ content: 'trashed now', deleted: true, modificationDate: 1700000300 },
					{ version: 3 },
				);
			}
			const m = url.match(/\/v\/(\d+)$/);
			if (m) {
				const v = Number(m[1]);
				return new Response(
					JSON.stringify({
						content: `v${v}`,
						deleted: v === 3, // only the latest version is trashed
						modificationDate: 1700000000 + v * 100,
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		const result = await provider.getNoteHistory!('note-1', 10);

		assert.equal(result.entries.length, 3);
		// No deleted/state filtering — caller can inspect previews if needed.
	});

	it('exposes null modified_at when the version body lacks modificationDate', async () => {
		const provider = createApiProvider();
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse({ content: 'x' }, { version: 1 });
			}
			if (/\/v\/1$/.test(url)) {
				return new Response(
					JSON.stringify({ content: 'no-date' }), // no modificationDate
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		const result = await provider.getNoteHistory!('note-1', 5);

		assert.equal(result.entries[0]!.modified_at, null);
	});

	it('rejects out-of-range limit before any fetch', async () => {
		const provider = createApiProvider();
		let fetched = false;
		mockFetch(async () => {
			fetched = true;
			return new Response('{}', { status: 200 });
		});
		await assert.rejects(() => provider.getNoteHistory!('note-1', 0));
		await assert.rejects(() => provider.getNoteHistory!('note-1', 26));
		await assert.rejects(() => provider.getNoteHistory!('note-1', 1.5));
		assert.equal(fetched, false);
	});

	it('does not consume the write budget', async () => {
		const provider = createApiProvider();
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse({ content: 'orig' }, { version: 1 });
			}
			if (isNotePost(init?.method)) {
				return new Response('2', { status: 200 });
			}
			if (/\/v\/\d+$/.test(url)) {
				return new Response(
					JSON.stringify({ content: 'v', modificationDate: 1700000000 }),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});
		for (let i = 0; i < 5; i++) {
			await provider.updateNote!({ id: 'note-1', content: `change ${i}` });
		}
		const result = await provider.getNoteHistory!('note-1', 5);
		assert.equal(result.current_version, 1);
	});

	it('URL-encodes the note id on both current and version GETs', async () => {
		const provider = createApiProvider();
		const captured = captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse({ content: 'x' }, { version: 1 });
			}
			if (/\/v\/\d+$/.test(url)) {
				return new Response(
					JSON.stringify({ content: 'v', modificationDate: 1700000000 }),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		await provider.getNoteHistory!('../tag/i/x', 3);

		for (const call of captured.calls) {
			assert.ok(call.url.includes('..%2Ftag%2Fi%2Fx'));
		}
	});
});

// trashNote and restoreNote are mirror operations: each GETs the current
// note, decides whether to POST a state-flipped copy, and otherwise behaves
// the same on the wire (same URL shape, same headers, same error matrix,
// same caching behavior). Generate the describe for both off one spec.
type WriteToggleSpec = {
	methodName: 'trashNote' | 'restoreNote';
	// What the GET sees BEFORE the toggle. The body should flip to !initialDeleted.
	initialDeleted: boolean;
	// What the body / result should set deleted to after the toggle.
	finalDeleted: boolean;
	// Verb that appears in the labelled error messages.
	label: 'trashing' | 'restoring';
};

function describeWriteToggle(spec: WriteToggleSpec): void {
	const { methodName, initialDeleted, finalDeleted, label } = spec;
	const targetState = finalDeleted ? 'trashed' : 'restored';

	describe(methodName, () => {
		it(`POSTs the full merged body with deleted:${finalDeleted} and a new modificationDate`, async () => {
			const provider = createApiProvider();
			const captured = captureFetch((url, opts) => {
				if (isRawNoteGet(url, opts?.method)) {
					return rawNoteResponse({
						content: 'Note body',
						tags: ['work'],
						systemTags: ['markdown'],
						deleted: initialDeleted,
						creationDate: 1700000000,
						modificationDate: 1700000100,
					});
				}
				if (isNotePost(opts?.method)) {
					return new Response('2', { status: 200 });
				}
				throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
			});

			const before = Math.floor(Date.now() / 1000);
			const result = await provider[methodName]!('note-1');
			const after = Math.floor(Date.now() / 1000);

			const post = captured.calls.find((c) => c.method === 'POST')!;
			const body = post.body as Record<string, unknown>;

			assert.equal(post.method, 'POST');
			assert.match(post.url, /\/note\/i\/note-1\?ccid=/);
			assert.equal(post.headers['X-Simperium-Token'], 'test-token');
			assert.equal(post.headers['Content-Type'], 'application/json');

			// Body contains the full note — original fields + flipped deleted + fresh mod date.
			assert.equal(body.deleted, finalDeleted);
			assert.equal(body.content, 'Note body');
			assert.deepEqual(body.tags, ['work']);
			assert.deepEqual(body.systemTags, ['markdown']);
			assert.equal(body.creationDate, 1700000000);
			const modDate = body.modificationDate as number;
			assert.ok(modDate >= before && modDate <= after);

			// Result reflects the new state.
			assert.equal(result.id, 'note-1');
			assert.equal(result.deleted, finalDeleted);
			assert.equal(result.content, 'Note body');
			assert.ok(result.modified);
		});

		it('preserves publishURL, shareURL, and unknown systemTags on the POST body', async () => {
			const provider = createApiProvider();
			const captured = captureFetch((url, opts) => {
				if (isRawNoteGet(url, opts?.method)) {
					return rawNoteResponse({
						content: 'Body',
						systemTags: ['markdown', 'unread', 'some-future-tag'],
						publishURL: 'https://simp.ly/p/abc123',
						shareURL: 'https://simp.ly/s/xyz789',
						deleted: initialDeleted,
					});
				}
				if (isNotePost(opts?.method)) {
					return new Response('2', { status: 200 });
				}
				throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
			});

			await provider[methodName]!('note-1');

			const body = captured.calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
			assert.equal(body.publishURL, 'https://simp.ly/p/abc123');
			assert.equal(body.shareURL, 'https://simp.ly/s/xyz789');
			const systemTags = body.systemTags as string[];
			assert.ok(systemTags.includes('markdown'));
			assert.ok(systemTags.includes('unread'));
			assert.ok(systemTags.includes('some-future-tag'));
		});

		it('URL-encodes the note ID on both GET and POST', async () => {
			const provider = createApiProvider();
			const captured = captureFetch((url, opts) => {
				if (isRawNoteGet(url, opts?.method)) {
					return rawNoteResponse({ content: 'Sneaky', deleted: initialDeleted });
				}
				if (isNotePost(opts?.method)) {
					return new Response('2', { status: 200 });
				}
				throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
			});

			await provider[methodName]!('../tag/i/x');

			const get = captured.calls.find((c) => c.method === undefined || c.method === 'GET')!;
			const post = captured.calls.find((c) => c.method === 'POST')!;
			// Encoded segment prevents path traversal into a different bucket.
			assert.ok(get.url.endsWith('/note/i/..%2Ftag%2Fi%2Fx'));
			assert.match(post.url, /\/note\/i\/\.\.%2Ftag%2Fi%2Fx\?ccid=/);
		});

		it(`short-circuits when the note is already ${targetState} — no POST`, async () => {
			const provider = createApiProvider();
			let postCount = 0;

			mockFetch(async (url: string, opts?: RequestInit) => {
				if (isRawNoteGet(url, opts?.method)) {
					// GET sees the note already in the target state.
					return rawNoteResponse({ content: 'Body', deleted: finalDeleted });
				}
				if (isNotePost(opts?.method)) {
					postCount++;
					return new Response('2', { status: 200 });
				}
				throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
			});

			const result = await provider[methodName]!('note-1');

			assert.equal(postCount, 0);
			assert.equal(result.id, 'note-1');
			assert.equal(result.deleted, finalDeleted);
		});

		it('throws ApiError(not_found) when GET returns 404 — no POST', async () => {
			const provider = createApiProvider();
			let postCount = 0;

			mockFetch(async (url: string, opts?: RequestInit) => {
				if (isRawNoteGet(url, opts?.method)) {
					return new Response('', { status: 404 });
				}
				if (isNotePost(opts?.method)) {
					postCount++;
					return new Response('2', { status: 200 });
				}
				throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
			});

			await assert.rejects(
				() => provider[methodName]!('does-not-exist'),
				(err: unknown) => err instanceof ApiError && err.code === 'not_found',
			);
			assert.equal(postCount, 0);
		});

		it('throws ApiError(unauthorized) on 401 from POST', async () => {
			const provider = createApiProvider();

			mockFetch(async (url: string, opts?: RequestInit) => {
				if (isRawNoteGet(url, opts?.method)) {
					return rawNoteResponse({ content: 'Body', deleted: initialDeleted });
				}
				if (isNotePost(opts?.method)) {
					return new Response('', { status: 401 });
				}
				throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
			});

			await assert.rejects(
				() => provider[methodName]!('note-1'),
				(err: unknown) => err instanceof ApiError && err.code === 'unauthorized',
			);
		});

		it(`throws ApiError(request_failed) with "${label}" label on non-2xx from POST`, async () => {
			const provider = createApiProvider();

			mockFetch(async (url: string, opts?: RequestInit) => {
				if (isRawNoteGet(url, opts?.method)) {
					return rawNoteResponse({ content: 'Body', deleted: initialDeleted });
				}
				if (isNotePost(opts?.method)) {
					return new Response('', { status: 500 });
				}
				throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
			});

			await assert.rejects(
				() => provider[methodName]!('note-1'),
				(err: unknown) =>
					err instanceof ApiError &&
					err.code === 'request_failed' &&
					err.message.includes(label),
			);
		});

		it(`throws ApiError(network_error) with "${label}" label when POST fetch throws`, async () => {
			const provider = createApiProvider();

			mockFetch(async (url: string, opts?: RequestInit) => {
				if (isRawNoteGet(url, opts?.method)) {
					return rawNoteResponse({ content: 'Body', deleted: initialDeleted });
				}
				if (isNotePost(opts?.method)) {
					throw new Error('Network failure');
				}
				throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
			});

			await assert.rejects(
				() => provider[methodName]!('note-1'),
				(err: unknown) =>
					err instanceof ApiError &&
					err.code === 'network_error' &&
					err.message.includes(label),
			);
		});

		it(`clears cache after ${label} a note`, async () => {
			const provider = createApiProvider();
			let indexFetchCount = 0;

			mockFetch(async (url: string, opts?: RequestInit) => {
				if (url.includes('/index')) {
					indexFetchCount++;
					return Response.json({ index: [], mark: undefined });
				}
				if (isRawNoteGet(url, opts?.method)) {
					return rawNoteResponse({ content: 'Body', deleted: initialDeleted });
				}
				if (isNotePost(opts?.method)) {
					return new Response('2', { status: 200 });
				}
				throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
			});

			await provider.loadStore();
			assert.equal(indexFetchCount, 2);

			// Cache hit.
			await provider.loadStore();
			assert.equal(indexFetchCount, 2);

			await provider[methodName]!('note-1');

			// After the toggle, cache is invalidated — next load refetches.
			await provider.loadStore();
			assert.equal(indexFetchCount, 4);
		});

		it(`invalidates cache on already-${targetState} short-circuit`, async () => {
			// The fresh GET is authoritative — if it reveals the note is already
			// in the target state while the cache thinks otherwise (cross-client
			// race), we must drop the stale cache even though we skipped the POST.
			const provider = createApiProvider();
			let indexFetchCount = 0;

			mockFetch(async (url: string, opts?: RequestInit) => {
				if (url.includes('/index')) {
					indexFetchCount++;
					return Response.json({ index: [], mark: undefined });
				}
				if (isRawNoteGet(url, opts?.method)) {
					return rawNoteResponse({ content: 'Body', deleted: finalDeleted });
				}
				if (isNotePost(opts?.method)) {
					throw new Error('POST should not happen on short-circuit');
				}
				throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
			});

			await provider.loadStore();
			assert.equal(indexFetchCount, 2);

			await provider[methodName]!('note-1');

			// Short-circuit still drops the cache — next load refetches.
			await provider.loadStore();
			assert.equal(indexFetchCount, 4);
		});
	});
}

describeWriteToggle({
	methodName: 'trashNote',
	initialDeleted: false,
	finalDeleted: true,
	label: 'trashing',
});

describeWriteToggle({
	methodName: 'restoreNote',
	initialDeleted: true,
	finalDeleted: false,
	label: 'restoring',
});

// ---------- write rate cap ----------

describe('write rate cap', () => {
	afterEach(() => mock.timers.reset());

	it('refuses the 6th write within a 30-second window with ApiError(rate_limited)', async () => {
		mock.timers.enable({ apis: ['Date'] });
		const provider = createApiProvider();
		let postCount = 0;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isNotePost(opts?.method)) {
				postCount++;
				return new Response('1', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		for (let i = 0; i < 5; i++) {
			await provider.createNote!({ content: `note ${i}` });
		}
		assert.equal(postCount, 5);

		await assert.rejects(
			() => provider.createNote!({ content: 'sixth' }),
			(err: unknown) =>
				err instanceof ApiError &&
				err.code === 'rate_limited' &&
				err.message.includes('5 writes in 30 seconds') &&
				err.message.includes('Confirm with the user'),
		);
		assert.equal(postCount, 5, 'rate-limited call should not POST');
	});

	it('allows another write after older timestamps age out of the window', async () => {
		mock.timers.enable({ apis: ['Date'] });
		const provider = createApiProvider();
		let postCount = 0;

		mockFetch(async (_url: string, opts?: RequestInit) => {
			if (isNotePost(opts?.method)) {
				postCount++;
				return new Response('1', { status: 200 });
			}
			throw new Error('unexpected fetch');
		});

		for (let i = 0; i < 5; i++) {
			await provider.createNote!({ content: `note ${i}` });
		}

		// Advance past the 30s rolling window so all 5 timestamps age out.
		mock.timers.tick(31_000);

		await provider.createNote!({ content: 'after window' });
		assert.equal(postCount, 6);
	});

	it('shares a single counter across createNote and updateNote', async () => {
		mock.timers.enable({ apis: ['Date'] });
		const provider = createApiProvider();
		let postCount = 0;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				return rawNoteResponse({ content: 'existing' });
			}
			if (isNotePost(opts?.method)) {
				postCount++;
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.createNote!({ content: 'a' });
		await provider.updateNote!({ id: 'x1', content: 'b' });
		await provider.createNote!({ content: 'c' });
		await provider.updateNote!({ id: 'x2', content: 'd' });
		await provider.createNote!({ content: 'e' });
		assert.equal(postCount, 5);

		await assert.rejects(
			() => provider.updateNote!({ id: 'x3', content: 'f' }),
			(err: unknown) => err instanceof ApiError && err.code === 'rate_limited',
		);
		await assert.rejects(
			() => provider.createNote!({ content: 'g' }),
			(err: unknown) => err instanceof ApiError && err.code === 'rate_limited',
		);
		assert.equal(postCount, 5, 'neither tool should POST once the cap is hit');
	});

	it('does not consume budget when the POST fails', async () => {
		mock.timers.enable({ apis: ['Date'] });
		const provider = createApiProvider();
		let attempts = 0;

		mockFetch(async (_url: string, opts?: RequestInit) => {
			if (isNotePost(opts?.method)) {
				attempts++;
				// Fail the first 5 attempts with 500, succeed afterwards.
				if (attempts <= 5) return new Response('', { status: 500 });
				return new Response('1', { status: 200 });
			}
			throw new Error('unexpected fetch');
		});

		for (let i = 0; i < 5; i++) {
			await assert.rejects(
				() => provider.createNote!({ content: `fail ${i}` }),
				(err: unknown) => err instanceof ApiError && err.code === 'request_failed',
			);
		}

		// None of the 5 failed writes should have consumed budget; all 5 of
		// the next batch should go through without hitting the cap.
		for (let i = 0; i < 5; i++) {
			await provider.createNote!({ content: `ok ${i}` });
		}
		assert.equal(attempts, 10);
	});

	it('counts trashNote and restoreNote toward the same budget', async () => {
		mock.timers.enable({ apis: ['Date'] });
		const provider = createApiProvider();
		let postCount = 0;
		// Toggle the deleted flag returned by GET so trash/restore alternately
		// see the "needs to POST" branch instead of short-circuiting.
		let getCount = 0;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (isRawNoteGet(url, opts?.method)) {
				const deleted = getCount % 2 === 1;
				getCount++;
				return rawNoteResponse({ content: 'x', deleted });
			}
			if (isNotePost(opts?.method)) {
				postCount++;
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${opts?.method} ${url}`);
		});

		await provider.createNote!({ content: 'a' });
		await provider.trashNote!('n1'); // GET sees deleted:false → POSTs trash
		await provider.restoreNote!('n2'); // GET sees deleted:true → POSTs restore
		await provider.trashNote!('n3');
		await provider.restoreNote!('n4');
		assert.equal(postCount, 5);

		await assert.rejects(
			() => provider.trashNote!('n5'),
			(err: unknown) => err instanceof ApiError && err.code === 'rate_limited',
		);
		await assert.rejects(
			() => provider.restoreNote!('n6'),
			(err: unknown) => err instanceof ApiError && err.code === 'rate_limited',
		);
		assert.equal(postCount, 5, 'trashNote and restoreNote share the budget');
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

// ---------- index response shape validation ----------

describe('loadStore index shape validation', () => {
	function jsonResponse(body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	}

	it('rejects an empty object body', async () => {
		const provider = createApiProvider();
		mockFetch(async () => jsonResponse({}));
		await assert.rejects(
			() => provider.loadStore(),
			(err: unknown) => err instanceof ApiError && err.code === 'invalid_response',
		);
	});

	it('rejects when "index" is not an array', async () => {
		const provider = createApiProvider();
		mockFetch(async () => jsonResponse({ index: 'bad' }));
		await assert.rejects(
			() => provider.loadStore(),
			(err: unknown) => err instanceof ApiError && err.code === 'invalid_response',
		);
	});

	it('rejects when "mark" is non-string', async () => {
		const provider = createApiProvider();
		mockFetch(async () => jsonResponse({ index: [], mark: 123 }));
		await assert.rejects(
			() => provider.loadStore(),
			(err: unknown) => err instanceof ApiError && err.code === 'invalid_response',
		);
	});

	it('rejects when the body is a JSON array at the root', async () => {
		const provider = createApiProvider();
		mockFetch(async () => jsonResponse([{ id: 'x' }]));
		await assert.rejects(
			() => provider.loadStore(),
			(err: unknown) => err instanceof ApiError && err.code === 'invalid_response',
		);
	});

	it('rejects when an entry is not an object', async () => {
		const provider = createApiProvider();
		mockFetch(async () => jsonResponse({ index: ['not-an-object'] }));
		await assert.rejects(
			() => provider.loadStore(),
			(err: unknown) => err instanceof ApiError && err.code === 'invalid_response',
		);
	});

	it('rethrows invalid_response after a successful read instead of caching the empty result', async () => {
		mock.timers.enable({ apis: ['Date'] });
		try {
			const provider = createApiProvider();

			mockFetch(async () => emptyIndexResponse());
			await provider.loadStore();

			mock.timers.tick(61_000);
			mockFetch(async () => jsonResponse({}));
			await assert.rejects(
				() => provider.loadStore(),
				(err: unknown) =>
					err instanceof ApiError && err.code === 'invalid_response',
			);
		} finally {
			mock.timers.reset();
		}
	});

	it('surfaces invalid_response from one bucket even when the other returns a transient error', async () => {
		mock.timers.enable({ apis: ['Date'] });
		try {
			const provider = createApiProvider();

			// Warm the cache so the stale-fallback path is otherwise live.
			mockFetch(async () => emptyIndexResponse());
			await provider.loadStore();

			mock.timers.tick(61_000);
			// note/index 503 → request_failed (transient)
			// tag/index  {}  → invalid_response (must surface)
			mockFetch(async (url: string) => {
				if (url.includes('/note/index')) {
					return new Response('', { status: 503 });
				}
				if (url.includes('/tag/index')) {
					return jsonResponse({});
				}
				throw new Error(`unexpected fetch: ${url}`);
			});
			await assert.rejects(
				() => provider.loadStore(),
				(err: unknown) =>
					err instanceof ApiError && err.code === 'invalid_response',
			);
		} finally {
			mock.timers.reset();
		}
	});
});

type RevertSpec = {
	label: string;
	startDeleted: boolean;
	targetDeleted: boolean;
};

function describeRevertToggle(spec: RevertSpec): void {
	const { label, startDeleted, targetDeleted } = spec;

	describe(`revertNote (${label})`, () => {
		it('overlays target content/tags/systemTags/deleted onto current and POSTs', async () => {
			const provider = createApiProvider();
			const captured = captureFetch((url, init) => {
				if (isRawNoteGet(url, init?.method)) {
					return rawNoteResponse(
						{
							content: 'current content',
							tags: ['current-tag'],
							systemTags: ['markdown'],
							deleted: startDeleted,
							publishURL: 'https://simp.ly/p/keep',
							shareURL: 'https://simp.ly/s/keep',
						},
						{ version: 5 },
					);
				}
				if (/\/note\/i\/note-1\/v\/2$/.test(url)) {
					return new Response(
						JSON.stringify({
							content: 'old content',
							tags: ['old-tag'],
							systemTags: ['markdown', 'pinned'],
							deleted: targetDeleted,
							modificationDate: 1700000000,
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				}
				if (isNotePost(init?.method)) {
					return new Response('6', { status: 200 });
				}
				throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
			});

			const before = Math.floor(Date.now() / 1000);
			const result = await provider.revertNote!({ id: 'note-1', version: 2 });
			const after = Math.floor(Date.now() / 1000);

			const post = captured.calls.find((c) => c.method === 'POST')!;
			const body = post.body as Record<string, unknown>;

			assert.match(post.url, /\/note\/i\/note-1\?ccid=/);
			assert.equal(post.headers['Content-Type'], 'application/json');
			assert.equal(body.content, 'old content');
			assert.deepEqual(body.tags, ['old-tag']);
			assert.deepEqual(body.systemTags, ['markdown', 'pinned']);
			assert.equal(body.deleted, targetDeleted);
			// Untracked fields preserved from current.
			assert.equal(body.publishURL, 'https://simp.ly/p/keep');
			assert.equal(body.shareURL, 'https://simp.ly/s/keep');
			// Fresh modificationDate.
			const modDate = body.modificationDate as number;
			assert.ok(modDate >= before && modDate <= after);

			assert.deepEqual(result, {
				id: 'note-1',
				reverted_from_version: 2,
				new_version: 6,
				no_op: false,
			});
		});

		it('throws rate_limited before any POST when budget is exhausted', async () => {
			const provider = createApiProvider();
			let postCount = 0;
			captureFetch((url, init) => {
				if (isRawNoteGet(url, init?.method)) {
					return rawNoteResponse(
						{ content: 'c', deleted: startDeleted },
						{ version: 5 },
					);
				}
				if (/\/v\/2$/.test(url)) {
					return new Response(
						JSON.stringify({
							content: 'old',
							deleted: targetDeleted,
							modificationDate: 1700000000,
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				}
				if (isNotePost(init?.method)) {
					postCount++;
					return new Response('6', { status: 200 });
				}
				throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
			});

			// Saturate via 5 successful reverts. Each one POSTs once.
			for (let i = 0; i < 5; i++) {
				await provider.revertNote!({ id: 'note-1', version: 2 });
			}
			const postsBefore = postCount;
			await assert.rejects(
				() => provider.revertNote!({ id: 'note-1', version: 2 }),
				(err: ApiError) =>
					err instanceof ApiError && err.code === 'rate_limited',
			);
			assert.equal(postCount, postsBefore, 'no POST should have been issued');
		});
	});
}

describeRevertToggle({ label: 'live → live', startDeleted: false, targetDeleted: false });
describeRevertToggle({ label: 'trashed → live (un-trash)', startDeleted: true, targetDeleted: false });
describeRevertToggle({ label: 'live → trashed (re-trash)', startDeleted: false, targetDeleted: true });
describeRevertToggle({ label: 'trashed → trashed', startDeleted: true, targetDeleted: true });

describe('revertNote (no-op and errors)', () => {
	it('short-circuits when target is identical to current — no POST', async () => {
		const provider = createApiProvider();
		let postCount = 0;
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse(
					{
						content: 'same',
						tags: ['t'],
						systemTags: ['markdown'],
						deleted: false,
					},
					{ version: 5 },
				);
			}
			if (/\/v\/2$/.test(url)) {
				return new Response(
					JSON.stringify({
						content: 'same',
						tags: ['t'],
						systemTags: ['markdown'],
						deleted: false,
						modificationDate: 1700000000,
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (isNotePost(init?.method)) {
				postCount++;
				return new Response('6', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		const result = await provider.revertNote!({ id: 'note-1', version: 2 });

		assert.equal(postCount, 0);
		assert.deepEqual(result, {
			id: 'note-1',
			reverted_from_version: 2,
			new_version: 5,
			no_op: true,
		});
	});

	it('does not consume budget on no-op', async () => {
		const provider = createApiProvider();
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse(
					{ content: 'same', deleted: false },
					{ version: 1 },
				);
			}
			if (/\/v\/1$/.test(url)) {
				return new Response(
					JSON.stringify({
						content: 'same',
						deleted: false,
						modificationDate: 1700000000,
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (isNotePost(init?.method)) {
				return new Response('2', { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});
		// 5 no-op reverts must not exhaust the budget.
		for (let i = 0; i < 5; i++) {
			await provider.revertNote!({ id: 'note-1', version: 1 });
		}
		// A 6th call still works (would throw if budget were spent).
		const result = await provider.revertNote!({ id: 'note-1', version: 1 });
		assert.equal(result.no_op, true);
	});

	it('surfaces version_not_found when the target version GET 404s', async () => {
		const provider = createApiProvider();
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				return rawNoteResponse({ content: 'c' }, { version: 5 });
			}
			if (/\/v\/999$/.test(url)) {
				return new Response('', { status: 404 });
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		await assert.rejects(
			() => provider.revertNote!({ id: 'note-1', version: 999 }),
			(err: ApiError) =>
				err instanceof ApiError && err.code === 'version_not_found',
		);
	});

	it('surfaces not_found when the current-state GET 404s', async () => {
		const provider = createApiProvider();
		captureFetch(() => new Response('', { status: 404 }));
		await assert.rejects(
			() => provider.revertNote!({ id: 'note-1', version: 1 }),
			(err: ApiError) => err instanceof ApiError && err.code === 'not_found',
		);
	});

	it('prefers not_found over version_not_found when the note does not exist', async () => {
		const provider = createApiProvider();
		captureFetch((url, init) => {
			if (isRawNoteGet(url, init?.method)) {
				// Make the current-state GET resolve LATER so a naive Promise.all
				// would race version_not_found ahead of not_found.
				return new Promise<Response>((resolve) => {
					setTimeout(() => resolve(new Response('', { status: 404 })), 20);
				});
			}
			if (/\/v\/\d+$/.test(url)) {
				return new Response('', { status: 404 });
			}
			throw new Error(`Unexpected fetch: ${init?.method} ${url}`);
		});

		await assert.rejects(
			() => provider.revertNote!({ id: 'missing', version: 1 }),
			(err: ApiError) => err instanceof ApiError && err.code === 'not_found',
		);
	});

	it('rejects non-positive version before any fetch', async () => {
		const provider = createApiProvider();
		let fetched = false;
		mockFetch(async () => {
			fetched = true;
			return new Response('{}', { status: 200 });
		});
		await assert.rejects(() => provider.revertNote!({ id: 'note-1', version: 0 }));
		await assert.rejects(() => provider.revertNote!({ id: 'note-1', version: -1 }));
		await assert.rejects(() => provider.revertNote!({ id: 'note-1', version: 1.5 }));
		assert.equal(fetched, false);
	});
});
