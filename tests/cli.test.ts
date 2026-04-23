import { afterEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, stat, writeFile } from 'node:fs/promises';
import type { Interface } from 'node:readline/promises';
import { AuthError } from '../src/providers/auth.ts';
import { _test } from '../src/cli.ts';
import {
	captureConsole,
	captureConsoleSync,
	mockFetchQueue,
	useEnvVar,
	useTmpDir,
} from './helpers.ts';

const {
	reportAuthError,
	parseWriteModeResponse,
	parseUseLocalResponse,
	setupCommand,
} = _test;

describe('reportAuthError', () => {
	it('formats AuthError with the provided prefix', () => {
		const calls = captureConsoleSync('error', () => {
			const code = reportAuthError(
				new AuthError('invalid_code', 'Auth code rejected.'),
				'Login failed.',
			);
			assert.equal(code, 1);
		});
		assert.ok(calls.some((c) => c.includes('Login failed. Auth code rejected.')));
	});

	it('adds the network-connection hint for network_error', () => {
		const calls = captureConsoleSync('error', () => {
			reportAuthError(
				new AuthError('network_error', 'connection refused'),
				'Login failed.',
			);
		});
		assert.ok(calls.some((c) => c.includes('network connection')));
	});

	it('handles plain Error instances', () => {
		const calls = captureConsoleSync('error', () => {
			const code = reportAuthError(new Error('boom'), 'Oops.');
			assert.equal(code, 1);
		});
		assert.ok(calls.some((c) => c.includes('Oops. boom')));
	});

	it('handles non-Error thrown values without leaking undefined', () => {
		// Throwing a raw string / plain object is legal in JS. The old
		// `(err as Error).message` would print "undefined" (or throw on null).
		const calls = captureConsoleSync('error', () => {
			reportAuthError('raw string value', 'Prefix:');
		});
		assert.ok(calls.some((c) => c.includes('raw string value')));
		assert.ok(!calls.some((c) => c.includes('undefined')));
	});

	it('coerces null without crashing', () => {
		const calls = captureConsoleSync('error', () => {
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

describe('parseUseLocalResponse', () => {
	it('returns true for empty/whitespace (default Y)', () => {
		assert.equal(parseUseLocalResponse(''), true);
		assert.equal(parseUseLocalResponse('   '), true);
		assert.equal(parseUseLocalResponse('\t'), true);
	});

	it('returns true for y/yes in any case', () => {
		assert.equal(parseUseLocalResponse('y'), true);
		assert.equal(parseUseLocalResponse('Y'), true);
		assert.equal(parseUseLocalResponse('yes'), true);
		assert.equal(parseUseLocalResponse('YES'), true);
	});

	it('returns false for n/no and anything else', () => {
		assert.equal(parseUseLocalResponse('n'), false);
		assert.equal(parseUseLocalResponse('no'), false);
		assert.equal(parseUseLocalResponse('N'), false);
		assert.equal(parseUseLocalResponse('NO'), false);
		assert.equal(parseUseLocalResponse('maybe'), false);
	});
});

// ---------- setupCommand helpers ----------

// Defaults for tests: local-DB detection off, so the local-DB prompt is
// skipped and the existing flow is exercised. Tests exercising the local
// branch pass their own platform/fileExists overrides.
const NO_LOCAL = {
	platform: () => 'linux' as NodeJS.Platform,
	fileExists: () => false,
};

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

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

// ---------- setupCommand — already logged in ----------

describe('setupCommand — already logged in', () => {
	const tmp = useTmpDir('smn-setup-');
	useEnvVar('SIMPLENOTE_TOKEN');
	afterEach(() => {
		mock.restoreAll();
	});

	it('saves {source:api, writeMode:true} when user answers y', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		await writeFile(
			authPath,
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
		const { restore } = captureConsole('log');
		try {
			const exitCode = await setupCommand({
				...NO_LOCAL,
				authPath,
				configPath,
				createPrompt: makePrompt(['y']),
			});
			assert.equal(exitCode, 0);
		} finally {
			restore();
		}
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: true });
	});

	it('saves {source:api, writeMode:false} when user answers n', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		await writeFile(
			authPath,
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
		const { restore } = captureConsole('log');
		try {
			const exitCode = await setupCommand({
				...NO_LOCAL,
				authPath,
				configPath,
				createPrompt: makePrompt(['n']),
			});
			assert.equal(exitCode, 0);
		} finally {
			restore();
		}
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: false });
	});

	it('saves writeMode=false when user hits enter (default)', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		await writeFile(
			authPath,
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
		const { restore } = captureConsole('log');
		try {
			const exitCode = await setupCommand({
				...NO_LOCAL,
				authPath,
				configPath,
				createPrompt: makePrompt(['']),
			});
			assert.equal(exitCode, 0);
		} finally {
			restore();
		}
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: false });
	});

	it('prints current logged-in email and writeMode OFF when config says false', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		await writeFile(
			authPath,
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
		await writeFile(
			configPath,
			JSON.stringify({ source: 'api', writeMode: false }),
		);
		const { lines, restore } = captureConsole('log');
		try {
			await setupCommand({
				...NO_LOCAL,
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
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		await writeFile(
			authPath,
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
		const { lines, restore } = captureConsole('log');
		try {
			await setupCommand({
				...NO_LOCAL,
				authPath,
				configPath,
				createPrompt: makePrompt(['']),
			});
		} finally {
			restore();
		}
		assert.match(lines.join('\n'), /Write-mode is currently: not configured/);
	});

	it('shows "Previously using local" when prior config was source=local', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		await writeFile(
			authPath,
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
		await writeFile(
			configPath,
			JSON.stringify({ source: 'local', writeMode: false }),
		);
		const { lines, restore } = captureConsole('log');
		try {
			await setupCommand({
				...NO_LOCAL,
				authPath,
				configPath,
				createPrompt: makePrompt(['']),
			});
		} finally {
			restore();
		}
		const joined = lines.join('\n');
		assert.match(joined, /Logged in as mark@example\.com/);
		assert.match(joined, /Previously using local Simplenote database/);
		// No ON/OFF display in this branch — writeMode wasn't a prior choice.
		assert.ok(!/Write-mode is currently: (ON|OFF)/.test(joined));
	});

	it('recovers from a malformed config file (not JSON)', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		await writeFile(
			authPath,
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
		await writeFile(configPath, 'not json at all');
		const err = captureConsole('error');
		const out = captureConsole('log');
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				...NO_LOCAL,
				authPath,
				configPath,
				createPrompt: makePrompt(['y']),
			});
		} finally {
			out.restore();
			err.restore();
		}
		assert.equal(exitCode, 0);
		assert.ok(
			err.lines.some((l) => /malformed/i.test(l)),
			'expected stderr note about malformed config',
		);
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: true });
	});

	it('recovers from a config file with wrong writeMode type', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		await writeFile(
			authPath,
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
		await writeFile(
			configPath,
			JSON.stringify({ source: 'api', writeMode: 'yes' }),
		);
		const err = captureConsole('error');
		const out = captureConsole('log');
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				...NO_LOCAL,
				authPath,
				configPath,
				createPrompt: makePrompt(['n']),
			});
		} finally {
			out.restore();
			err.restore();
		}
		assert.equal(exitCode, 0);
		assert.ok(
			err.lines.some((l) => /malformed/i.test(l)),
			'expected stderr note about malformed config',
		);
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: false });
	});
});

// ---------- setupCommand — not logged in ----------

describe('setupCommand — not logged in', () => {
	const tmp = useTmpDir('smn-setup-');
	useEnvVar('SIMPLENOTE_TOKEN');
	afterEach(() => {
		mock.restoreAll();
	});

	it('runs the full login flow, saves token, then saves config', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		mockFetchQueue([
			{ status: 200, body: {} },
			{
				status: 200,
				body: { username: 'mark@example.com', sync_token: 'tok123' },
			},
		]);
		const { restore } = captureConsole('log');
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				...NO_LOCAL,
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
		assert.deepEqual(config, { source: 'api', writeMode: true });
	});

	it('exits 1 on network failure and writes no config', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		mockFetchQueue([{ throws: new Error('network refused') }]);
		const err = captureConsole('error');
		const out = captureConsole('log');
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				...NO_LOCAL,
				authPath,
				configPath,
				createPrompt: makePrompt(['mark@example.com']),
			});
		} finally {
			out.restore();
			err.restore();
		}
		assert.equal(exitCode, 1);
		assert.equal(await fileExists(configPath), false);
	});

	it('exits 1 on empty email; no token, no config written', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		const err = captureConsole('error');
		const out = captureConsole('log');
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				...NO_LOCAL,
				authPath,
				configPath,
				createPrompt: makePrompt(['']),
			});
		} finally {
			out.restore();
			err.restore();
		}
		assert.equal(exitCode, 1);
		assert.equal(await fileExists(authPath), false);
		assert.equal(await fileExists(configPath), false);
		assert.ok(err.lines.some((l) => /Email is required/.test(l)));
	});
});

// ---------- setupCommand — local DB detection ----------

const LOCAL_AVAILABLE = {
	platform: () => 'darwin' as NodeJS.Platform,
	fileExists: () => true,
	nativeStorePath: '/fake/native/store.storedata',
};

describe('setupCommand — local DB detected', () => {
	const tmp = useTmpDir('smn-setup-local-');
	useEnvVar('SIMPLENOTE_TOKEN');
	afterEach(() => {
		mock.restoreAll();
	});

	it('saves source=local when user accepts (Y), skipping writeMode and login', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		// No auth.json on disk. The local-DB choice should not require login.
		const { restore } = captureConsole('log');
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				...LOCAL_AVAILABLE,
				authPath,
				configPath,
				createPrompt: makePrompt(['y']),
			});
		} finally {
			restore();
		}
		assert.equal(exitCode, 0);
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { source: 'local', writeMode: false });
		// No auth written — we never ran the login flow.
		assert.equal(await fileExists(authPath), false);
	});

	it('saves source=local when user hits enter (default is Y)', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		const { restore } = captureConsole('log');
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				...LOCAL_AVAILABLE,
				authPath,
				configPath,
				createPrompt: makePrompt(['']),
			});
		} finally {
			restore();
		}
		assert.equal(exitCode, 0);
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { source: 'local', writeMode: false });
	});

	it('when user declines local (n), falls through to login + writeMode prompt', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		mockFetchQueue([
			{ status: 200, body: {} },
			{
				status: 200,
				body: { username: 'mark@example.com', sync_token: 'tok123' },
			},
		]);
		const { restore } = captureConsole('log');
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				...LOCAL_AVAILABLE,
				authPath,
				configPath,
				// local prompt → n, then email, code, writeMode
				createPrompt: makePrompt(['n', 'mark@example.com', 'T7YLLP', 'y']),
			});
		} finally {
			restore();
		}
		assert.equal(exitCode, 0);
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: true });
	});

	it('when user declines local (n) and is already logged in, skips login but still asks writeMode', async () => {
		const authPath = tmp.path('auth.json');
		const configPath = tmp.path('config.json');
		await writeFile(
			authPath,
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
		const { restore } = captureConsole('log');
		let exitCode: number;
		try {
			exitCode = await setupCommand({
				...LOCAL_AVAILABLE,
				authPath,
				configPath,
				createPrompt: makePrompt(['n', 'y']),
			});
		} finally {
			restore();
		}
		assert.equal(exitCode, 0);
		const config = JSON.parse(await readFile(configPath, 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: true });
	});
});
