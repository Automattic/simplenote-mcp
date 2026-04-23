import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createApiProvider } from '../src/providers/simperium-api.ts';
import { mockFetch, setupTestToken } from './helpers/simperium.ts';

setupTestToken();

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
