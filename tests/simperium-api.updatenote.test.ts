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
	if (savedToken === undefined) delete process.env.SIMPLENOTE_TOKEN;
	else process.env.SIMPLENOTE_TOKEN = savedToken;
});

type FetchImpl = (url: string, opts?: RequestInit) => Promise<Response> | Response;

function mockFetch(impl: FetchImpl) {
	mock.method(globalThis, 'fetch', impl as unknown as typeof globalThis.fetch);
}

// Helper to create a mock note index response
function mockNoteIndex(notes: Array<{ id: string; content: string; tags?: string[]; markdown?: boolean; pinned?: boolean; created?: string; modified?: string; deleted?: boolean }>) {
	return Response.json({
		index: notes.map((n) => ({
			id: n.id,
			d: {
				content: n.content,
				tags: n.tags ?? [],
				systemTags: [
					...(n.markdown !== false ? ['markdown'] : []),
					...(n.pinned ? ['pinned'] : []),
				],
				deleted: n.deleted ?? false,
				creationDate: n.created ? Date.parse(n.created) / 1000 : 1700000000,
				modificationDate: n.modified ? Date.parse(n.modified) / 1000 : 1700000100,
			},
		})),
		mark: undefined,
	});
}

describe('updateNote', () => {
	it('sends POST to the correct URL with note ID', async () => {
		const provider = createApiProvider();
		let capturedUrl: string | undefined;
		let capturedMethod: string | undefined;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{ id: 'test-note-123', content: 'Original content' }]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			capturedUrl = url;
			capturedMethod = opts?.method;
			return new Response('2', { status: 200 });
		});

		await provider.updateNote!({ id: 'test-note-123', content: 'Updated content' });

		assert.match(capturedUrl!, /api\.simperium\.com\/1\/[^/]+\/note\/i\/test-note-123$/);
		assert.equal(capturedMethod, 'POST');
	});

	it('merges content update with existing note values', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{
						id: 'note-1',
						content: 'Original',
						tags: ['existing-tag'],
						markdown: true,
						pinned: true,
					}]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			capturedBody = JSON.parse(opts?.body as string);
			return new Response('2', { status: 200 });
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

	it('preserves creationDate from existing note', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;
		const originalCreationDate = '2024-01-15T10:30:00.000Z';

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{
						id: 'note-1',
						content: 'Original',
						created: originalCreationDate,
					}]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			capturedBody = JSON.parse(opts?.body as string);
			return new Response('2', { status: 200 });
		});

		await provider.updateNote!({ id: 'note-1', content: 'Updated' });

		// creationDate should be preserved (converted to Unix timestamp)
		const expectedUnix = Math.floor(Date.parse(originalCreationDate) / 1000);
		assert.equal(capturedBody!.creationDate, expectedUnix);
	});

	it('updates modificationDate to current time', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;
		const beforeUpdate = Math.floor(Date.now() / 1000);

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{ id: 'note-1', content: 'Original' }]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			capturedBody = JSON.parse(opts?.body as string);
			return new Response('2', { status: 200 });
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
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{
						id: 'note-1',
						content: 'Content',
						tags: ['old-tag'],
					}]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			capturedBody = JSON.parse(opts?.body as string);
			return new Response('2', { status: 200 });
		});

		await provider.updateNote!({ id: 'note-1', tags: ['new-tag-1', 'new-tag-2'] });

		// Tags should be replaced entirely
		assert.deepEqual(capturedBody!.tags, ['new-tag-1', 'new-tag-2']);
		// Content should be preserved
		assert.equal(capturedBody!.content, 'Content');
	});

	it('toggles markdown in systemTags when markdown=false', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{
						id: 'note-1',
						content: 'Content',
						markdown: true,
						pinned: true,
					}]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			capturedBody = JSON.parse(opts?.body as string);
			return new Response('2', { status: 200 });
		});

		await provider.updateNote!({ id: 'note-1', markdown: false });

		// markdown should be removed, pinned should be preserved
		assert.ok(!(capturedBody!.systemTags as string[]).includes('markdown'));
		assert.ok((capturedBody!.systemTags as string[]).includes('pinned'));
	});

	it('toggles pinned in systemTags when pinned=true', async () => {
		const provider = createApiProvider();
		let capturedBody: Record<string, unknown> | undefined;

		mockFetch(async (url: string, opts?: RequestInit) => {
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{
						id: 'note-1',
						content: 'Content',
						markdown: true,
						pinned: false,
					}]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			capturedBody = JSON.parse(opts?.body as string);
			return new Response('2', { status: 200 });
		});

		await provider.updateNote!({ id: 'note-1', pinned: true });

		// pinned should be added, markdown should be preserved
		assert.ok((capturedBody!.systemTags as string[]).includes('pinned'));
		assert.ok((capturedBody!.systemTags as string[]).includes('markdown'));
	});

	it('throws ApiError(not_found) when note does not exist', async () => {
		const provider = createApiProvider();

		mockFetch(async (url: string) => {
			if (url.includes('/index')) {
				// Return empty note index
				return Response.json({ index: [], mark: undefined });
			}
			return new Response('', { status: 200 });
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'non-existent-note', content: 'Test' }),
			(err: unknown) => err instanceof ApiError && err.code === 'not_found',
		);
	});

	it('throws ApiError(unauthorized) on 401', async () => {
		const provider = createApiProvider();

		mockFetch(async (url: string) => {
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{ id: 'note-1', content: 'Content' }]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			return new Response('', { status: 401 });
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'note-1', content: 'Test' }),
			(err: unknown) => err instanceof ApiError && err.code === 'unauthorized',
		);
	});

	it('throws ApiError(request_failed) on non-2xx', async () => {
		const provider = createApiProvider();

		mockFetch(async (url: string) => {
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{ id: 'note-1', content: 'Content' }]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			return new Response('', { status: 500 });
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'note-1', content: 'Test' }),
			(err: unknown) => err instanceof ApiError && err.code === 'request_failed',
		);
	});

	it('throws ApiError(network_error) when fetch throws', async () => {
		const provider = createApiProvider();
		let callCount = 0;

		mockFetch(async (url: string) => {
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{ id: 'note-1', content: 'Content' }]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			// POST request - throw network error
			callCount++;
			throw new Error('Network failure');
		});

		await assert.rejects(
			() => provider.updateNote!({ id: 'note-1', content: 'Test' }),
			(err: unknown) => err instanceof ApiError && err.code === 'network_error',
		);
		assert.equal(callCount, 1);
	});

	it('parses version from response body', async () => {
		const provider = createApiProvider();

		mockFetch(async (url: string) => {
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{ id: 'note-1', content: 'Content' }]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			return new Response('42', { status: 200 });
		});

		const result = await provider.updateNote!({ id: 'note-1', content: 'Updated' });
		assert.equal(result.version, 42);
	});

	it('clears cache after updating a note', async () => {
		const provider = createApiProvider();
		let indexFetchCount = 0;

		mockFetch(async (url: string) => {
			if (url.includes('/index')) {
				indexFetchCount++;
				if (url.includes('/note/')) {
					return mockNoteIndex([{ id: 'note-1', content: 'Content' }]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			return new Response('2', { status: 200 });
		});

		// Initial load
		await provider.loadStore();
		assert.equal(indexFetchCount, 2); // note + tag indices

		// Load again (should use cache)
		await provider.loadStore();
		assert.equal(indexFetchCount, 2);

		// Update a note
		await provider.updateNote!({ id: 'note-1', content: 'New content' });

		// Load again (cache should be cleared, need to fetch again)
		await provider.loadStore();
		assert.equal(indexFetchCount, 4);
	});

	it('returns the note id and version', async () => {
		const provider = createApiProvider();

		mockFetch(async (url: string) => {
			if (url.includes('/index')) {
				if (url.includes('/note/')) {
					return mockNoteIndex([{ id: 'my-note-id', content: 'Content' }]);
				}
				return Response.json({ index: [], mark: undefined });
			}
			return new Response('5', { status: 200 });
		});

		const result = await provider.updateNote!({ id: 'my-note-id', content: 'Updated' });
		assert.equal(result.id, 'my-note-id');
		assert.equal(result.version, 5);
	});
});

describe('toUnixFromIso', () => {
	it('converts ISO string to Unix timestamp', async () => {
		const { toUnixFromIso } = (await import('../src/providers/simperium-api.ts'))._test;
		assert.equal(toUnixFromIso('1970-01-01T00:00:00.000Z'), 0);
		assert.equal(toUnixFromIso('2024-01-15T10:30:00.000Z'), 1705314600);
	});

	it('returns null for null input', async () => {
		const { toUnixFromIso } = (await import('../src/providers/simperium-api.ts'))._test;
		assert.equal(toUnixFromIso(null), null);
	});

	it('returns null for invalid date string', async () => {
		const { toUnixFromIso } = (await import('../src/providers/simperium-api.ts'))._test;
		assert.equal(toUnixFromIso('not-a-date'), null);
	});
});
