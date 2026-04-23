import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ApiError, createApiProvider } from '../src/providers/simperium-api.ts';
import {
	isNotePost,
	isRawNoteGet,
	mockFetch,
	rawNoteResponse,
	setupTestToken,
} from './helpers/simperium.ts';

setupTestToken();

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

		assert.match(capturedUrl!, /api\.simperium\.com\/1\/[^/]+\/note\/i\/test-note-123$/);
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
