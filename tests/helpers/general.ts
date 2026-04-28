import { afterEach, beforeEach, mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Registers before/afterEach hooks that create and remove a fresh tmpdir for
// each test in the enclosing describe scope. The returned handle's `dir` is
// populated before each test; `path(...)` is a convenience for joining.
export function useTmpDir(prefix = 'simplenote-mcp-test-'): {
	dir: string;
	path: (name: string) => string;
} {
	const ctx = {
		dir: '',
		path(name: string): string {
			return join(ctx.dir, name);
		},
	};
	beforeEach(async () => {
		ctx.dir = await mkdtemp(join(tmpdir(), prefix));
	});
	afterEach(async () => {
		await rm(ctx.dir, { recursive: true, force: true });
	});
	return ctx;
}

// Registers before/afterEach hooks that scope process.env[key] to each test
// in the enclosing describe. If `value` is given, the key is set to that
// value before each test (useful for tests that need a deterministic env);
// otherwise the key is deleted before each test. The prior value is restored
// in either case.
export function useEnvVar(key: string, value?: string): void {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	});
	afterEach(() => {
		if (saved === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = saved;
		}
	});
}

export type FetchImpl = (
	input: string,
	init?: RequestInit,
) => Promise<Response> | Response;

// Replaces globalThis.fetch with `impl`. Cleaned up by mock.restoreAll()
// in an afterEach hook (callers are responsible for registering it).
export function mockFetch(impl: FetchImpl): void {
	mock.method(globalThis, 'fetch', impl as unknown as typeof globalThis.fetch);
}

export type CapturedFetch = {
	url: string;
	method?: string;
	headers: Record<string, string>;
	/** Raw request body as supplied to fetch (string, Blob, etc.), or undefined. */
	rawBody?: BodyInit;
	/** JSON-parsed body when rawBody is a JSON string; otherwise same as rawBody. */
	body?: unknown;
};

// Wraps mockFetch to also record every call. The `respond` callback decides
// what to return (often based on url/method); the returned `calls` array
// fills in as fetch is called. `rawBody` holds the original BodyInit value;
// `body` is the JSON-parsed form when rawBody is a JSON string, or the
// original value otherwise.
export function captureFetch(
	respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: CapturedFetch[] } {
	const calls: CapturedFetch[] = [];
	mockFetch(async (url, init) => {
		const headers = Object.fromEntries(
			Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)]),
		);
		const rawBody = init?.body;
		let body: unknown;
		if (typeof rawBody === 'string') {
			try {
				body = JSON.parse(rawBody);
			} catch {
				body = rawBody;
			}
		} else if (rawBody !== undefined) {
			body = rawBody;
		}
		calls.push({ url, method: init?.method, headers, rawBody, body });
		return respond(url, init);
	});
	return { calls };
}

export type FetchScriptEntry =
	| { status: number; body: unknown }
	| { throws: unknown };

// Installs a scripted fetch mock. Each call consumes the next entry; an
// entry with `throws` rejects, otherwise a JSON Response is returned. The
// returned `state.calls` tracks how many entries were consumed.
export function mockFetchQueue(script: FetchScriptEntry[]): { calls: number } {
	const state = { calls: 0 };
	mock.method(globalThis, 'fetch', async () => {
		const entry = script[state.calls++];
		if (!entry) {
			throw new Error('mockFetchQueue: unexpected extra fetch call');
		}
		if ('throws' in entry) {
			throw entry.throws;
		}
		return new Response(JSON.stringify(entry.body), {
			status: entry.status,
			headers: { 'content-type': 'application/json' },
		});
	});
	return state;
}

// Captures calls to console[stream]. The returned `lines` is mutated as
// calls come in; `restore()` reverts the mock. Use the returned restore
// before assertions that might themselves log (e.g. test failure output).
export function captureConsole(stream: 'log' | 'error'): {
	lines: string[];
	restore: () => void;
} {
	const lines: string[] = [];
	const m = mock.method(console, stream, (msg: unknown) => {
		lines.push(String(msg));
	});
	return {
		lines,
		restore: () => m.mock.restore(),
	};
}

// Synchronous variant: runs `fn`, restores the mock, returns captured lines.
export function captureConsoleSync(
	stream: 'log' | 'error',
	fn: () => void,
): string[] {
	const { lines, restore } = captureConsole(stream);
	try {
		fn();
	} finally {
		restore();
	}
	return lines;
}
