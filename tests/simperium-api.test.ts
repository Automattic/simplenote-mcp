import { afterEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { ApiError, _test } from '../src/providers/simperium-api.ts';
import { mockFetch } from './helpers/simperium.ts';

const { normalizeNote, normalizeTag, toBool, toIsoFromUnix, mergeSystemTags, simperiumRequest } =
	_test;

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

describe('simperiumRequest', () => {
	afterEach(() => mock.restoreAll());

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
