import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { ApiError, createApiProvider } from '../src/providers/simperium-api.ts';

// Provide a token without hitting auth.json.
let savedToken: string | undefined;

beforeEach(() => {
	savedToken = process.env.SIMPLENOTE_TOKEN;
	process.env.SIMPLENOTE_TOKEN = 'test-token';
});

afterEach(() => {
	mock.restoreAll();
	mock.timers.reset();
	if (savedToken === undefined) delete process.env.SIMPLENOTE_TOKEN;
	else process.env.SIMPLENOTE_TOKEN = savedToken;
});

function mockFetch(impl: (url: string) => Promise<Response> | Response) {
	mock.method(globalThis, 'fetch', impl as unknown as typeof globalThis.fetch);
}

function emptyIndexResponse() {
	return Response.json({ index: [], mark: undefined });
}

describe('loadStore stale-cache fallback', () => {
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
