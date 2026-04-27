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
