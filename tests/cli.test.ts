import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, stat, writeFile } from 'node:fs/promises';
import type { Interface } from 'node:readline/promises';
import { AuthError } from '../src/providers/auth.ts';
import { _test } from '../src/cli.ts';
import { NOOP_TELEMETRY, type Telemetry } from '../src/telemetry.ts';
import {
	captureConsole,
	captureConsoleSync,
	type FetchScriptEntry,
	mockFetchQueue,
	useEnvVar,
	useTmpDir,
} from './helpers.ts';

const {
	reportAuthError,
	parseWriteModeResponse,
	parseUseLocalResponse,
	setupCommand,
	disableTelemetryCommand,
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

const LOCAL_AVAILABLE = {
	platform: () => 'darwin' as NodeJS.Platform,
	fileExists: () => true,
	nativeStorePath: '/fake/native/store.storedata',
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

// Runs setupCommand with the common boilerplate wrapped up: captures both
// console streams, installs a fetch-queue mock if given, and returns the
// exit code alongside everything the test might want to assert against.
// authPath and configPath are always `tmp.path('auth.json')` and
// `tmp.path('config.json')`; tests set up files at those paths before calling.
type SetupProfile = Omit<
	Parameters<typeof setupCommand>[0],
	'authPath' | 'configPath' | 'createPrompt'
>;

async function runSetup(args: {
	tmp: { path: (name: string) => string };
	profile: SetupProfile;
	responses: string[];
	telemetry?: Telemetry;
	fetchScript?: FetchScriptEntry[];
}): Promise<{ exitCode: number; stdout: string[]; stderr: string[] }> {
	if (args.fetchScript) {
		mockFetchQueue(args.fetchScript);
	}
	const out = captureConsole('log');
	const err = captureConsole('error');
	let exitCode: number;
	try {
		exitCode = await setupCommand({
			...args.profile,
			authPath: args.tmp.path('auth.json'),
			configPath: args.tmp.path('config.json'),
			createPrompt: makePrompt(args.responses),
			telemetry: args.telemetry ?? NOOP_TELEMETRY,
		});
	} finally {
		out.restore();
		err.restore();
	}
	return { exitCode, stdout: out.lines, stderr: err.lines };
}

function captureTelemetry(): {
	telemetry: Telemetry;
	setupCalls: Parameters<Telemetry['trackSetup']>[0][];
} {
	const setupCalls: Parameters<Telemetry['trackSetup']>[0][] = [];
	return {
		setupCalls,
		telemetry: {
			async trackSetup(props) {
				setupCalls.push(props);
			},
			async trackToolCall() {},
		},
	};
}

// ---------- setupCommand — already logged in ----------

describe('setupCommand — already logged in', () => {
	const tmp = useTmpDir('smn-setup-');
	useEnvVar('SIMPLENOTE_TOKEN');
	afterEach(() => {
		mock.restoreAll();
	});
	beforeEach(async () => {
		await writeFile(
			tmp.path('auth.json'),
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
	});

	it('saves {source:api, writeMode:true} when user answers y', async () => {
		const { exitCode } = await runSetup({ tmp, profile: NO_LOCAL, responses: ['y'] });
		assert.equal(exitCode, 0);
		const config = JSON.parse(await readFile(tmp.path('config.json'), 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: true });
	});

	it('saves {source:api, writeMode:false} when user answers n', async () => {
		const { exitCode } = await runSetup({ tmp, profile: NO_LOCAL, responses: ['n'] });
		assert.equal(exitCode, 0);
		const config = JSON.parse(await readFile(tmp.path('config.json'), 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: false });
	});

	it('saves writeMode=false when user hits enter (default)', async () => {
		const { exitCode } = await runSetup({ tmp, profile: NO_LOCAL, responses: [''] });
		assert.equal(exitCode, 0);
		const config = JSON.parse(await readFile(tmp.path('config.json'), 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: false });
	});

	it('tracks API setup with anonymous environment metadata', async () => {
		const captured = captureTelemetry();
		const { exitCode } = await runSetup({
			tmp,
			profile: NO_LOCAL,
			responses: ['y'],
			telemetry: captured.telemetry,
		});
		assert.equal(exitCode, 0);
		assert.deepEqual(captured.setupCalls, [
			{
				type: 'api',
				env: 'linux',
				auth: 'existing_token',
				writeMode: true,
			},
		]);
	});

	it('prints current logged-in email and writeMode OFF when config says false', async () => {
		await writeFile(
			tmp.path('config.json'),
			JSON.stringify({ source: 'api', writeMode: false }),
		);
		const { stdout } = await runSetup({ tmp, profile: NO_LOCAL, responses: [''] });
		const joined = stdout.join('\n');
		assert.match(joined, /Logged in as mark@example\.com/);
		assert.match(joined, /Write-mode is currently: OFF/);
	});

	it('says "not configured" when config is missing', async () => {
		const { stdout } = await runSetup({ tmp, profile: NO_LOCAL, responses: [''] });
		assert.match(stdout.join('\n'), /Write-mode is currently: not configured/);
	});

	it('shows "Previously using local" when prior config was source=local', async () => {
		await writeFile(
			tmp.path('config.json'),
			JSON.stringify({ source: 'local', writeMode: false }),
		);
		const { stdout } = await runSetup({ tmp, profile: NO_LOCAL, responses: [''] });
		const joined = stdout.join('\n');
		assert.match(joined, /Logged in as mark@example\.com/);
		assert.match(joined, /Previously using local Simplenote database/);
		// No ON/OFF display in this branch — writeMode wasn't a prior choice.
		assert.ok(!/Write-mode is currently: (ON|OFF)/.test(joined));
	});

	it('recovers from a malformed config file (not JSON)', async () => {
		await writeFile(tmp.path('config.json'), 'not json at all');
		const { exitCode, stderr } = await runSetup({
			tmp,
			profile: NO_LOCAL,
			responses: ['y'],
		});
		assert.equal(exitCode, 0);
		assert.ok(
			stderr.some((l) => /malformed/i.test(l)),
			'expected stderr note about malformed config',
		);
		const config = JSON.parse(await readFile(tmp.path('config.json'), 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: true });
	});

	it('recovers from a config file with wrong writeMode type', async () => {
		await writeFile(
			tmp.path('config.json'),
			JSON.stringify({ source: 'api', writeMode: 'yes' }),
		);
		const { exitCode, stderr } = await runSetup({
			tmp,
			profile: NO_LOCAL,
			responses: ['n'],
		});
		assert.equal(exitCode, 0);
		assert.ok(
			stderr.some((l) => /malformed/i.test(l)),
			'expected stderr note about malformed config',
		);
		const config = JSON.parse(await readFile(tmp.path('config.json'), 'utf-8'));
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
		const captured = captureTelemetry();
		const { exitCode } = await runSetup({
			tmp,
			profile: NO_LOCAL,
			responses: ['mark@example.com', 'T7YLLP', 'y'],
			telemetry: captured.telemetry,
			fetchScript: [
				{ status: 200, body: {} },
				{
					status: 200,
					body: { username: 'mark@example.com', sync_token: 'tok123' },
				},
			],
		});
		assert.equal(exitCode, 0);
		assert.equal(await fileExists(tmp.path('auth.json')), true);
		const auth = JSON.parse(await readFile(tmp.path('auth.json'), 'utf-8'));
		assert.deepEqual(auth, { username: 'mark@example.com', token: 'tok123' });
		const config = JSON.parse(await readFile(tmp.path('config.json'), 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: true });
		assert.deepEqual(captured.setupCalls, [
			{
				type: 'api',
				env: 'linux',
				auth: 'new_login',
				writeMode: true,
			},
		]);
	});

	it('exits 1 on network failure and writes no config', async () => {
		const { exitCode } = await runSetup({
			tmp,
			profile: NO_LOCAL,
			responses: ['mark@example.com'],
			fetchScript: [{ throws: new Error('network refused') }],
		});
		assert.equal(exitCode, 1);
		assert.equal(await fileExists(tmp.path('config.json')), false);
	});

	it('exits 1 on empty email; no token, no config written', async () => {
		const { exitCode, stderr } = await runSetup({
			tmp,
			profile: NO_LOCAL,
			responses: [''],
		});
		assert.equal(exitCode, 1);
		assert.equal(await fileExists(tmp.path('auth.json')), false);
		assert.equal(await fileExists(tmp.path('config.json')), false);
		assert.ok(stderr.some((l) => /Email is required/.test(l)));
	});
});

// ---------- setupCommand — local DB detection ----------

describe('setupCommand — local DB detected', () => {
	const tmp = useTmpDir('smn-setup-local-');
	useEnvVar('SIMPLENOTE_TOKEN');
	afterEach(() => {
		mock.restoreAll();
	});

	it('saves source=local when user accepts (Y), skipping writeMode and login', async () => {
		// No auth.json on disk. The local-DB choice should not require login.
		const captured = captureTelemetry();
		const { exitCode } = await runSetup({
			tmp,
			profile: LOCAL_AVAILABLE,
			responses: ['y'],
			telemetry: captured.telemetry,
		});
		assert.equal(exitCode, 0);
		const config = JSON.parse(await readFile(tmp.path('config.json'), 'utf-8'));
		assert.deepEqual(config, { source: 'local', writeMode: false });
		// No auth written — we never ran the login flow.
		assert.equal(await fileExists(tmp.path('auth.json')), false);
		assert.deepEqual(captured.setupCalls, [{ type: 'local', env: 'mac' }]);
	});

	it('saves source=local when user hits enter (default is Y)', async () => {
		const { exitCode } = await runSetup({
			tmp,
			profile: LOCAL_AVAILABLE,
			responses: [''],
		});
		assert.equal(exitCode, 0);
		const config = JSON.parse(await readFile(tmp.path('config.json'), 'utf-8'));
		assert.deepEqual(config, { source: 'local', writeMode: false });
	});

	it('when user declines local (n), falls through to login + writeMode prompt', async () => {
		const { exitCode } = await runSetup({
			tmp,
			profile: LOCAL_AVAILABLE,
			// local prompt → n, then email, code, writeMode
			responses: ['n', 'mark@example.com', 'T7YLLP', 'y'],
			fetchScript: [
				{ status: 200, body: {} },
				{
					status: 200,
					body: { username: 'mark@example.com', sync_token: 'tok123' },
				},
			],
		});
		assert.equal(exitCode, 0);
		const config = JSON.parse(await readFile(tmp.path('config.json'), 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: true });
	});

	it('when user declines local (n) and is already logged in, skips login but still asks writeMode', async () => {
		await writeFile(
			tmp.path('auth.json'),
			JSON.stringify({ username: 'mark@example.com', token: 'tok' }),
		);
		const { exitCode } = await runSetup({
			tmp,
			profile: LOCAL_AVAILABLE,
			responses: ['n', 'y'],
		});
		assert.equal(exitCode, 0);
		const config = JSON.parse(await readFile(tmp.path('config.json'), 'utf-8'));
		assert.deepEqual(config, { source: 'api', writeMode: true });
	});
});

describe('disableTelemetryCommand', () => {
	const tmp = useTmpDir('smn-disable-telemetry-');

	it('persists telemetry opt-out', async () => {
		const out = captureConsole('log');
		let exitCode: number;
		try {
			exitCode = await disableTelemetryCommand({
				telemetryPath: tmp.path('telemetry.json'),
			});
		} finally {
			out.restore();
		}

		assert.equal(exitCode, 0);
		const raw = await readFile(tmp.path('telemetry.json'), 'utf-8');
		assert.deepEqual(JSON.parse(raw), { disabled: true });
		assert.ok(out.lines.some((l) => /Telemetry disabled/.test(l)));
	});
});
