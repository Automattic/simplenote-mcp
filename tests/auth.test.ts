import { afterEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmod, stat, readFile, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import {
	AuthError,
	completeLogin,
	deleteToken,
	loadToken,
	requestLoginCode,
	saveToken,
	_test,
} from '../src/providers/auth.ts';
import { mockFetch, useTmpDir } from './helpers/general.ts';

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

describe('requestLoginCode', () => {
	it('POSTs the right URL and body', async () => {
		let observedUrl = '';
		let observedBody: unknown;
		mockFetch(async (url, init) => {
			observedUrl = String(url);
			observedBody = JSON.parse(init!.body as string);
			return new Response('', { status: 200 });
		});
		await requestLoginCode('alice@example.com');
		assert.equal(observedUrl, 'https://app.simplenote.com/account/request-login');
		assert.deepEqual(observedBody, {
			username: 'alice@example.com',
			request_source: 'macOS',
		});
	});

	it('throws AuthError(request_failed) on non-2xx', async () => {
		mockFetch(async () => new Response('', { status: 503 }));
		await assert.rejects(
			() => requestLoginCode('a@b.com'),
			(err: unknown) =>
				err instanceof AuthError && err.code === 'request_failed' && err.status === 503,
		);
	});

	it('throws AuthError(network_error) when fetch throws', async () => {
		mockFetch(async () => {
			throw new Error('ENOTFOUND');
		});
		await assert.rejects(
			() => requestLoginCode('a@b.com'),
			(err: unknown) => err instanceof AuthError && err.code === 'network_error',
		);
	});

	it('throws AuthError(rate_limited) on 429', async () => {
		mockFetch(async () => new Response('', { status: 429 }));
		await assert.rejects(
			() => requestLoginCode('a@b.com'),
			(err: unknown) =>
				err instanceof AuthError && err.code === 'rate_limited' && err.status === 429,
		);
	});
});

describe('completeLogin', () => {
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

	it('throws AuthError(rate_limited) on 429', async () => {
		mockFetch(async () => new Response('', { status: 429 }));
		await assert.rejects(
			() => completeLogin('a@b.com', 'CODE'),
			(err: unknown) =>
				err instanceof AuthError && err.code === 'rate_limited' && err.status === 429,
		);
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
		await writeFile(tokenPath, 'not json');
		const out = await loadToken({ tokenPath, env: {} });
		assert.equal(out, null);
	});

	it('loadToken returns null when token field is missing', async () => {
		const tokenPath = tmp.path('auth.json');
		await writeFile(tokenPath, JSON.stringify({ username: 'a@b.com' }));
		const out = await loadToken({ tokenPath, env: {} });
		assert.equal(out, null);
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
