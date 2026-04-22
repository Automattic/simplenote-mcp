import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Interface } from 'node:readline/promises';
import { AuthError } from '../src/providers/auth.ts';
import { _test } from '../src/cli.ts';

const { reportAuthError, parseWriteModeResponse, setupCommand } = _test;

function captureStderr(run: () => void): string[] {
	const calls: string[] = [];
	const restore = mock.method(console, 'error', (msg: unknown) => {
		calls.push(String(msg));
	});
	try {
		run();
	} finally {
		restore.mock.restore();
	}
	return calls;
}

describe('reportAuthError', () => {
	it('formats AuthError with the provided prefix', () => {
		const calls = captureStderr(() => {
			const code = reportAuthError(
				new AuthError('invalid_code', 'Auth code rejected.'),
				'Login failed.',
			);
			assert.equal(code, 1);
		});
		assert.ok(calls.some((c) => c.includes('Login failed. Auth code rejected.')));
	});

	it('adds the network-connection hint for network_error', () => {
		const calls = captureStderr(() => {
			reportAuthError(
				new AuthError('network_error', 'connection refused'),
				'Login failed.',
			);
		});
		assert.ok(calls.some((c) => c.includes('network connection')));
	});

	it('handles plain Error instances', () => {
		const calls = captureStderr(() => {
			const code = reportAuthError(new Error('boom'), 'Oops.');
			assert.equal(code, 1);
		});
		assert.ok(calls.some((c) => c.includes('Oops. boom')));
	});

	it('handles non-Error thrown values without leaking undefined', () => {
		// Throwing a raw string / plain object is legal in JS. The old
		// `(err as Error).message` would print "undefined" (or throw on null).
		const calls = captureStderr(() => {
			reportAuthError('raw string value', 'Prefix:');
		});
		assert.ok(calls.some((c) => c.includes('raw string value')));
		assert.ok(!calls.some((c) => c.includes('undefined')));
	});

	it('coerces null without crashing', () => {
		const calls = captureStderr(() => {
			const code = reportAuthError(null, 'Prefix:');
			assert.equal(code, 1);
		});
		assert.ok(calls.length > 0);
	});
});

describe('parseWriteModeResponse', () => {
	it('returns true for y/yes in any case', () => {
		assert.equal(parseWriteModeResponse('y'), true);
		assert.equal(parseWriteModeResponse('Y'), true);
		assert.equal(parseWriteModeResponse('yes'), true);
		assert.equal(parseWriteModeResponse('YES'), true);
		assert.equal(parseWriteModeResponse('Yes'), true);
		assert.equal(parseWriteModeResponse('  yes  '), true);
	});

	it('returns false for empty or whitespace-only input', () => {
		assert.equal(parseWriteModeResponse(''), false);
		assert.equal(parseWriteModeResponse('   '), false);
		assert.equal(parseWriteModeResponse('\t'), false);
		assert.equal(parseWriteModeResponse('\n'), false);
	});

	it('returns false for anything other than y/yes', () => {
		assert.equal(parseWriteModeResponse('n'), false);
		assert.equal(parseWriteModeResponse('no'), false);
		assert.equal(parseWriteModeResponse('N'), false);
		assert.equal(parseWriteModeResponse('NO'), false);
		assert.equal(parseWriteModeResponse('maybe'), false);
		assert.equal(parseWriteModeResponse('1'), false);
		assert.equal(parseWriteModeResponse('yep'), false);
		assert.equal(parseWriteModeResponse('yeah'), false);
	});
});

// ---------- setupCommand helpers ----------

// A minimal readline Interface stand-in that replays scripted responses for
// each prompt in order. Extra prompts throw so tests surface unexpected flow.
function makePrompt(responses: string[]): () => Interface {
	return () => {
		let i = 0;
		const fake = {
			question: async (_query: string) => {
				if (i >= responses.length) {
					throw new Error(
						`makePrompt: no response scripted for prompt #${i + 1}`,
					);
				}
				return responses[i++]!;
			},
			close: () => {},
		};
		return fake as unknown as Interface;
	};
}

function captureStdout(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const restore = mock.method(console, 'log', (msg: unknown) => {
		lines.push(String(msg));
	});
	return { lines, restore: () => restore.mock.restore() };
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

// Mocks globalThis.fetch with a scripted queue. Each call shifts the next
// entry; an entry with `throws` rejects, otherwise a Response is returned.
type FetchScript = Array<
	{ status: number; body: unknown } | { throws: unknown }
>;

function mockFetchQueue(script: FetchScript): { calls: number } {
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

// ---------- setupCommand — already logged in ----------

describe('setupCommand — already logged in', () => {
	let dir: string;
	let authPath: string;
	let configPath: string;
	let savedEnvToken: string | undefined;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'smn-setup-'));
		authPath = join(dir, 'auth.json');
		configPath = join(dir, 'config.json');
		await writeFile(
			authPath,
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
		// loadToken honors SIMPLENOTE_TOKEN before the file. Clear it so
		// these tests exercise the file-based "already logged in" branch.
		savedEnvToken = process.env.SIMPLENOTE_TOKEN;
		delete process.env.SIMPLENOTE_TOKEN;
	});

	afterEach(async () => {
		mock.restoreAll();
		if (savedEnvToken === undefined) {
			delete process.env.SIMPLENOTE_TOKEN;
		} else {
			process.env.SIMPLENOTE_TOKEN = savedEnvToken;
		}
		await rm(dir, { recursive: true, force: true });
	});

	it('saves writeMode=true when user answers y', async () => {
		const { restore } = captureStdout();
		try {
			const exitCode = await setupCommand({
				authPath,
				configPath,
				createPrompt: makePrompt(['y']),
			});
			assert.equal(exitCode, 0);
		} finally {
			restore();
		}
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { writeMode: true });
	});

	it('saves writeMode=false when user answers n', async () => {
		const { restore } = captureStdout();
		try {
			const exitCode = await setupCommand({
				authPath,
				configPath,
				createPrompt: makePrompt(['n']),
			});
			assert.equal(exitCode, 0);
		} finally {
			restore();
		}
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { writeMode: false });
	});

	it('saves writeMode=false when user hits enter (default)', async () => {
		const { restore } = captureStdout();
		try {
			const exitCode = await setupCommand({
				authPath,
				configPath,
				createPrompt: makePrompt(['']),
			});
			assert.equal(exitCode, 0);
		} finally {
			restore();
		}
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { writeMode: false });
	});

	it('prints current logged-in email and writeMode OFF when config says false', async () => {
		await writeFile(configPath, JSON.stringify({ writeMode: false }));
		const { lines, restore } = captureStdout();
		try {
			await setupCommand({
				authPath,
				configPath,
				createPrompt: makePrompt(['']),
			});
		} finally {
			restore();
		}
		const joined = lines.join('\n');
		assert.match(joined, /Logged in as mark@example\.com/);
		assert.match(joined, /Write-mode is currently: OFF/);
	});

	it('says "not configured" when config is missing', async () => {
		const { lines, restore } = captureStdout();
		try {
			await setupCommand({
				authPath,
				configPath,
				createPrompt: makePrompt(['']),
			});
		} finally {
			restore();
		}
		assert.match(lines.join('\n'), /Write-mode is currently: not configured/);
	});
});

// ---------- setupCommand — not logged in ----------

describe('setupCommand — not logged in', () => {
	let dir: string;
	let authPath: string;
	let configPath: string;
	let savedEnvToken: string | undefined;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'smn-setup-'));
		authPath = join(dir, 'auth.json');
		configPath = join(dir, 'config.json');
		// loadToken honors SIMPLENOTE_TOKEN before the file — clear it so
		// these tests genuinely hit the "not logged in" branch.
		savedEnvToken = process.env.SIMPLENOTE_TOKEN;
		delete process.env.SIMPLENOTE_TOKEN;
	});

	afterEach(async () => {
		mock.restoreAll();
		if (savedEnvToken === undefined) {
			delete process.env.SIMPLENOTE_TOKEN;
		} else {
			process.env.SIMPLENOTE_TOKEN = savedEnvToken;
		}
		await rm(dir, { recursive: true, force: true });
	});

	it('runs the full login flow, saves token, then saves config', async () => {
		mockFetchQueue([
			{ status: 200, body: {} },
			{
				status: 200,
				body: { username: 'mark@example.com', sync_token: 'tok123' },
			},
		]);
		const { restore } = captureStdout();
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				authPath,
				configPath,
				createPrompt: makePrompt(['mark@example.com', 'T7YLLP', 'y']),
			});
		} finally {
			restore();
		}
		assert.equal(exitCode, 0);
		assert.equal(await fileExists(authPath), true);
		const auth = JSON.parse(await readFile(authPath, 'utf-8'));
		assert.deepEqual(auth, { username: 'mark@example.com', token: 'tok123' });
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { writeMode: true });
	});

	it('exits 1 on network failure and writes no config', async () => {
		mockFetchQueue([{ throws: new Error('network refused') }]);
		const errLines: string[] = [];
		const restoreErr = mock.method(console, 'error', (msg: unknown) => {
			errLines.push(String(msg));
		});
		const { restore } = captureStdout();
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				authPath,
				configPath,
				createPrompt: makePrompt(['mark@example.com']),
			});
		} finally {
			restore();
			restoreErr.mock.restore();
		}
		assert.equal(exitCode, 1);
		assert.equal(await fileExists(configPath), false);
	});

	it('exits 1 on empty email; no token, no config written', async () => {
		const errLines: string[] = [];
		const restoreErr = mock.method(console, 'error', (msg: unknown) => {
			errLines.push(String(msg));
		});
		const { restore } = captureStdout();
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				authPath,
				configPath,
				createPrompt: makePrompt(['']),
			});
		} finally {
			restore();
			restoreErr.mock.restore();
		}
		assert.equal(exitCode, 1);
		assert.equal(await fileExists(authPath), false);
		assert.equal(await fileExists(configPath), false);
		assert.ok(errLines.some((l) => /Email is required/.test(l)));
	});
});
