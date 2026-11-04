import { afterEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmod, stat, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import {
	AuthError,
	completeLogin,
	deleteToken,
	getAppUrl,
	getLoginUrl,
	loadToken,
	parseLoginCredential,
	saveToken,
	_test,
} from '../src/providers/auth.ts';
import { USER_AGENT } from '../src/version.ts';
import {
	captureConsole,
	captureFetch,
	mockFetch,
	mockFetchQueue,
	useTmpDir,
} from './helpers/general.ts';

const { extractToken, extractUsername } = _test;

// ---------- pure helpers ----------

describe('extractToken', () => {
	it('prefers wire-format sync_token', () => {
		assert.equal(extractToken({ sync_token: 'A', syncToken: 'B', token: 'C' }), 'A');
	});
	it('falls back to syncToken then token', () => {
		assert.equal(extractToken({ syncToken: 'B' }), 'B');
		assert.equal(extractToken({ token: 'C' }), 'C');
	});
	it('returns null for missing or non-string token', () => {
		assert.equal(extractToken({}), null);
		assert.equal(extractToken({ sync_token: '' }), null);
		assert.equal(extractToken({ sync_token: 42 }), null);
		assert.equal(extractToken(null), null);
	});
});

describe('extractUsername', () => {
	it('returns the username string when present', () => {
		assert.equal(extractUsername({ username: 'a@b.com' }), 'a@b.com');
	});
	it('returns null when missing or non-string', () => {
		assert.equal(extractUsername({}), null);
		assert.equal(extractUsername({ username: 42 }), null);
		assert.equal(extractUsername(null), null);
	});
});

// ---------- HTTP-mocked tests ----------

afterEach(() => {
	mock.restoreAll();
});

describe('getAppUrl / getLoginUrl', () => {
	it('defaults to production', () => {
		assert.equal(getAppUrl({}), 'https://app.simplenote.com');
		assert.equal(getLoginUrl({}), 'https://app.simplenote.com/login/?source=mcp');
	});

	it('honors SIMPLENOTE_APP_URL and strips trailing slashes', () => {
		const env = { SIMPLENOTE_APP_URL: ' https://simplenote.example.test// ' };
		assert.equal(getAppUrl(env), 'https://simplenote.example.test');
		assert.equal(getLoginUrl(env), 'https://simplenote.example.test/login/?source=mcp');
	});

	it('treats an empty SIMPLENOTE_APP_URL as unset', () => {
		assert.equal(getAppUrl({ SIMPLENOTE_APP_URL: '  ' }), 'https://app.simplenote.com');
	});

	it('rejects malformed and non-http(s) values', () => {
		for (const value of ['simplenote.example.test', 'ftp://simplenote.example.test', 'javascript:alert(1)']) {
			assert.throws(
				() => getAppUrl({ SIMPLENOTE_APP_URL: value }),
				(err: unknown) => err instanceof AuthError && err.code === 'invalid_app_url',
				value,
			);
		}
	});
});

describe('parseLoginCredential', () => {
	it('splits email and code', () => {
		assert.deepEqual(parseLoginCredential('user@example.com:3QYXRL'), {
			username: 'user@example.com',
			authCode: '3QYXRL',
		});
	});

	it('trims whitespace and uppercases the code', () => {
		assert.deepEqual(parseLoginCredential('  user@example.com : 3qyxrl \n'), {
			username: 'user@example.com',
			authCode: '3QYXRL',
		});
	});

	it('splits on the last colon', () => {
		assert.deepEqual(parseLoginCredential('"odd:local"@example.com:ABC123'), {
			username: '"odd:local"@example.com',
			authCode: 'ABC123',
		});
	});

	it('does not enforce a code length', () => {
		assert.equal(parseLoginCredential('a@b.com:ABCDEFGH')?.authCode, 'ABCDEFGH');
	});

	it('returns null without a colon or with an empty side', () => {
		assert.equal(parseLoginCredential('3QYXRL'), null);
		assert.equal(parseLoginCredential(':3QYXRL'), null);
		assert.equal(parseLoginCredential('a@b.com:'), null);
		assert.equal(parseLoginCredential('   '), null);
	});
});

describe('completeLogin', () => {
	it('POSTs only username and auth_code, with our User-Agent', async () => {
		const { calls } = captureFetch(() =>
			Response.json({ username: 'alice@example.com', sync_token: 'tok' }),
		);
		await completeLogin('alice@example.com', 'CODE99', { env: {} });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, 'https://app.simplenote.com/account/complete-login');
		assert.equal(calls[0]!.method, 'POST');
		assert.deepEqual(calls[0]!.body, {
			username: 'alice@example.com',
			auth_code: 'CODE99',
		});
		assert.equal(calls[0]!.headers['User-Agent'], USER_AGENT);
		assert.match(USER_AGENT, /^simplenote-mcp\/\d+\.\d+\.\d+/);
	});

	it('uses SIMPLENOTE_APP_URL for the request', async () => {
		const { calls } = captureFetch(() => Response.json({ sync_token: 'tok' }));
		await completeLogin('a@b.com', 'CODE', {
			env: { SIMPLENOTE_APP_URL: 'https://simplenote.example.test/' },
		});
		assert.equal(calls[0]!.url, 'https://simplenote.example.test/account/complete-login');
	});

	it('returns AuthToken from a sync_token response', async () => {
		mockFetch(async () =>
			Response.json({ username: 'alice@example.com', sync_token: 'tok123' }),
		);
		const out = await completeLogin('alice@example.com', 'CODE99');
		assert.deepEqual(out, { username: 'alice@example.com', token: 'tok123' });
	});

	it('falls back to email when response username is missing', async () => {
		mockFetch(async () => Response.json({ sync_token: 'tok' }));
		const out = await completeLogin('a@b.com', 'CODE');
		assert.equal(out.username, 'a@b.com');
	});

	it('throws AuthError(invalid_code) on 400 without retrying', async () => {
		const state = mockFetchQueue([
			{ status: 400, body: { error: 'error-completing-login' } },
		]);
		await assert.rejects(
			() => completeLogin('a@b.com', 'BAD'),
			(err: unknown) =>
				err instanceof AuthError && err.code === 'invalid_code' && err.status === 400,
		);
		assert.equal(state.calls, 1);
	});

	it('throws AuthError(invalid_code) on 401', async () => {
		mockFetch(async () => new Response('', { status: 401 }));
		await assert.rejects(
			() => completeLogin('a@b.com', 'BAD'),
			(err: unknown) => err instanceof AuthError && err.code === 'invalid_code',
		);
	});

	it('throws AuthError(invalid_response) when response is not JSON', async () => {
		mockFetch(async () => new Response('not json', { status: 200 }));
		await assert.rejects(
			() => completeLogin('a@b.com', 'CODE'),
			(err: unknown) => err instanceof AuthError && err.code === 'invalid_response',
		);
	});

	it('throws AuthError(invalid_response) when token field is missing', async () => {
		mockFetch(async () => Response.json({ username: 'a@b.com' }));
		await assert.rejects(
			() => completeLogin('a@b.com', 'CODE'),
			(err: unknown) => err instanceof AuthError && err.code === 'invalid_response',
		);
	});

	it('retries the same code after a 429 and succeeds', async () => {
		const state = mockFetchQueue([
			{ status: 429, body: { error: 'too-many-requests' } },
			{ status: 200, body: { username: 'a@b.com', sync_token: 'tok' } },
		]);
		const waits: number[] = [];
		const out = await completeLogin('a@b.com', 'CODE', {
			rateLimitDelayMs: 0,
			onRateLimited: (ms) => waits.push(ms),
		});
		assert.equal(out.token, 'tok');
		assert.equal(state.calls, 2);
		assert.deepEqual(waits, [0]);
	});

	it('gives up with AuthError(rate_limited) after bounded retries', async () => {
		const state = mockFetchQueue([
			{ status: 429, body: {} },
			{ status: 429, body: {} },
			{ status: 429, body: {} },
		]);
		await assert.rejects(
			() => completeLogin('a@b.com', 'CODE', { rateLimitDelayMs: 0 }),
			(err: unknown) =>
				err instanceof AuthError && err.code === 'rate_limited' && err.status === 429,
		);
		assert.equal(state.calls, 3);
	});

	it('defaults to a 60-second wait and stops when aborted', async () => {
		const state = mockFetchQueue([{ status: 429, body: {} }]);
		const controller = new AbortController();
		const waits: number[] = [];
		await assert.rejects(
			() =>
				completeLogin('a@b.com', 'CODE', {
					signal: controller.signal,
					onRateLimited: (ms) => {
						waits.push(ms);
						controller.abort();
					},
				}),
			(err: unknown) => err instanceof Error && err.name === 'AbortError',
		);
		assert.deepEqual(waits, [60_000]);
		assert.equal(state.calls, 1);
	});

	it('does not retry after a network error', async () => {
		const state = mockFetchQueue([{ throws: new Error('ECONNRESET') }]);
		await assert.rejects(
			() => completeLogin('a@b.com', 'CODE', { rateLimitDelayMs: 0 }),
			(err: unknown) => err instanceof AuthError && err.code === 'network_error',
		);
		assert.equal(state.calls, 1);
	});
});

// ---------- token file I/O ----------

describe('token file roundtrip (tmpdir)', () => {
	const tmp = useTmpDir('simplenote-mcp-test-');

	it('saveToken creates a 0600 file with the expected payload', async () => {
		const tokenPath = tmp.path('auth.json');
		const path = await saveToken({ username: 'a@b.com', token: 'tok' }, tokenPath);
		assert.equal(path, tokenPath);

		const contents = JSON.parse(await readFile(tokenPath, 'utf-8'));
		assert.deepEqual(contents, { username: 'a@b.com', token: 'tok' });

		if (platform() !== 'win32') {
			const mode = (await stat(tokenPath)).mode & 0o777;
			assert.equal(mode, 0o600);
		}
	});

	it('saveToken tightens perms to 0600 when file already exists with looser perms', async (t) => {
		if (platform() === 'win32') {
			t.skip('POSIX permission model');
			return;
		}
		const tokenPath = tmp.path('auth.json');
		await writeFile(tokenPath, '{}');
		await chmod(tokenPath, 0o644);
		assert.equal((await stat(tokenPath)).mode & 0o777, 0o644);

		await saveToken({ username: 'a@b.com', token: 'tok' }, tokenPath);
		assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
	});

	it('loadToken reads what saveToken wrote', async () => {
		const tokenPath = tmp.path('auth.json');
		await saveToken({ username: 'a@b.com', token: 'tok' }, tokenPath);
		const out = await loadToken({ tokenPath, env: {} });
		assert.deepEqual(out, { username: 'a@b.com', token: 'tok' });
	});

	it('loadToken returns null when file is missing', async () => {
		const out = await loadToken({ tokenPath: tmp.path('auth.json'), env: {} });
		assert.equal(out, null);
	});

	it('loadToken returns null when file is invalid JSON', async () => {
		const tokenPath = tmp.path('auth.json');
		await writeFile(tokenPath, 'not json', { mode: 0o600 });
		const out = await loadToken({ tokenPath, env: {} });
		assert.equal(out, null);
	});

	it('loadToken returns null when token field is missing', async () => {
		const tokenPath = tmp.path('auth.json');
		await writeFile(tokenPath, JSON.stringify({ username: 'a@b.com' }), {
			mode: 0o600,
		});
		const out = await loadToken({ tokenPath, env: {} });
		assert.equal(out, null);
	});

	it('loadToken auto-repairs perms on a 0644 token file and warns', async (t) => {
		if (platform() === 'win32') {
			t.skip('POSIX permission model');
			return;
		}
		const tokenPath = tmp.path('auth.json');
		await writeFile(
			tokenPath,
			JSON.stringify({ username: 'a@b.com', token: 'tok' }),
		);
		await chmod(tokenPath, 0o644);

		const stderr = captureConsole('error');
		let out;
		try {
			out = await loadToken({ tokenPath, env: {} });
		} finally {
			stderr.restore();
		}

		assert.deepEqual(out, { username: 'a@b.com', token: 'tok' });
		assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
		assert.equal(stderr.lines.length, 1);
		assert.match(stderr.lines[0], /Tightened .* permissions from 644 to 0600/);
	});

	it('loadToken does not chmod or warn when file is already 0600', async (t) => {
		if (platform() === 'win32') {
			t.skip('POSIX permission model');
			return;
		}
		const tokenPath = tmp.path('auth.json');
		await writeFile(
			tokenPath,
			JSON.stringify({ username: 'a@b.com', token: 'tok' }),
			{ mode: 0o600 },
		);

		const stderr = captureConsole('error');
		let out;
		try {
			out = await loadToken({ tokenPath, env: {} });
		} finally {
			stderr.restore();
		}

		assert.deepEqual(out, { username: 'a@b.com', token: 'tok' });
		assert.equal(stderr.lines.length, 0);
		assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
	});

	it('loadToken rejects a symlinked token file', async (t) => {
		if (platform() === 'win32') {
			t.skip('POSIX permission model');
			return;
		}
		const target = tmp.path('target.json');
		await writeFile(
			target,
			JSON.stringify({ username: 'a@b.com', token: 'tok' }),
			{ mode: 0o600 },
		);
		const tokenPath = tmp.path('auth.json');
		await symlink(target, tokenPath);

		await assert.rejects(
			() => loadToken({ tokenPath, env: {} }),
			/not a regular file/,
		);

		// Symlink target must remain untouched (no auto-chmod through the link).
		assert.equal((await stat(target)).mode & 0o777, 0o600);
	});

	it('loadToken rejects a FIFO without hanging', async (t) => {
		if (platform() === 'win32') {
			t.skip('POSIX permission model');
			return;
		}
		const tokenPath = tmp.path('auth.json');
		// O_NONBLOCK in the open flags is what keeps this test from hanging:
		// without it, opening a FIFO O_RDONLY would block until a writer
		// opened the other end.
		execFileSync('mkfifo', [tokenPath]);

		await assert.rejects(
			() => loadToken({ tokenPath, env: {} }),
			/not a regular file/,
		);
	});

	it('SIMPLENOTE_TOKEN env var takes precedence over file', async () => {
		const tokenPath = tmp.path('auth.json');
		await saveToken({ username: 'a@b.com', token: 'from-file' }, tokenPath);
		const out = await loadToken({
			tokenPath,
			env: { SIMPLENOTE_TOKEN: 'from-env' },
		});
		assert.deepEqual(out, { username: null, token: 'from-env' });
	});

	it('deleteToken returns true for existing files, false otherwise', async () => {
		const tokenPath = tmp.path('auth.json');
		await saveToken({ username: 'a@b.com', token: 'tok' }, tokenPath);
		assert.equal(await deleteToken(tokenPath), true);
		assert.equal(await deleteToken(tokenPath), false);
	});
});
