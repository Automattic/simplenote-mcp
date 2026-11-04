import {
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	unlink,
	writeFile,
	type FileHandle,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { USER_AGENT } from '../version.js';
import { getTokenPath } from './paths.js';

const DEFAULT_APP_URL = 'https://app.simplenote.com';
const FETCH_TIMEOUT_MS = 15_000;
// Redeeming is rate-limited, and codes expire 5 minutes after they're
// shown. Two waits keeps a retry well inside that window.
const RATE_LIMIT_DELAY_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 2;

export type AuthToken = {
	username: string | null;
	token: string;
};

export class AuthError extends Error {
	readonly code: AuthErrorCode;
	readonly status?: number;

	constructor(code: AuthErrorCode, message: string, status?: number) {
		super(message);
		this.name = 'AuthError';
		this.code = code;
		this.status = status;
	}
}

export type AuthErrorCode =
	| 'invalid_app_url'
	| 'request_failed'
	| 'invalid_code'
	| 'invalid_response'
	| 'network_error'
	| 'rate_limited';

// Base URL of the Simplenote web app. SIMPLENOTE_APP_URL lets dev builds on
// other hosts be tested. Read per call so tests can scope the env var.
export function getAppUrl(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.SIMPLENOTE_APP_URL?.trim();
	if (!raw) return DEFAULT_APP_URL;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new AuthError(
			'invalid_app_url',
			`SIMPLENOTE_APP_URL is not a valid URL: ${raw}`,
		);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new AuthError(
			'invalid_app_url',
			`SIMPLENOTE_APP_URL must be an http(s) URL: ${raw}`,
		);
	}
	return raw.replace(/\/+$/, '');
}

// `source=mcp` makes the site show an `email:CODE` credential after login
// instead of starting a browser session.
export function getLoginUrl(env?: NodeJS.ProcessEnv): string {
	return `${getAppUrl(env)}/login/?source=mcp`;
}

export type LoginCredential = {
	username: string;
	authCode: string;
};

// Parses the `email:CODE` string shown after browser login. Emails can't
// contain a colon in practice, but split on the last one to be safe.
export function parseLoginCredential(input: string): LoginCredential | null {
	const trimmed = input.trim();
	const sep = trimmed.lastIndexOf(':');
	if (sep === -1) return null;
	const username = trimmed.slice(0, sep).trim();
	const authCode = trimmed.slice(sep + 1).trim().toUpperCase();
	if (!username || !authCode) return null;
	return { username, authCode };
}

async function postJson(url: string, body: unknown): Promise<Response> {
	try {
		return await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': USER_AGENT,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		throw new AuthError(
			'network_error',
			`Network error contacting Simplenote: ${(err as Error).message}`,
		);
	}
}

export type CompleteLoginOptions = {
	env?: NodeJS.ProcessEnv;
	// Called before each rate-limit wait so the CLI can tell the user.
	onRateLimited?: (delayMs: number) => void;
	// Aborts a rate-limit wait (e.g. on Ctrl-C). Rejects with an AbortError.
	signal?: AbortSignal;
	// Test hooks.
	rateLimitDelayMs?: number;
	maxRateLimitRetries?: number;
};

// Redeems a one-time code from the browser login for a sync token. Codes are
// single-use, so only a 429 (where the server guarantees the code is still
// valid) is retried; network errors are not, because the server may have
// consumed the code before the connection failed.
export async function completeLogin(
	username: string,
	authCode: string,
	opts: CompleteLoginOptions = {},
): Promise<AuthToken> {
	const url = `${getAppUrl(opts.env)}/account/complete-login`;
	const delayMs = opts.rateLimitDelayMs ?? RATE_LIMIT_DELAY_MS;
	const maxRetries = opts.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES;

	let res: Response;
	for (let attempt = 0; ; attempt++) {
		// No `source` field: `source: "web"` would start a browser session
		// instead of returning a token.
		res = await postJson(url, { username, auth_code: authCode });
		if (res.status !== 429 || attempt >= maxRetries) break;
		opts.onRateLimited?.(delayMs);
		await sleep(delayMs, undefined, { signal: opts.signal });
	}

	if (res.status === 400 || res.status === 401 || res.status === 403) {
		throw new AuthError(
			'invalid_code',
			'Code rejected. It may be mistyped, already used, or expired (codes expire 5 minutes after they are shown).',
			res.status,
		);
	}
	if (res.status === 429) {
		throw new AuthError(
			'rate_limited',
			'Too many login attempts. Wait a few minutes and try again.',
			429,
		);
	}
	if (!res.ok) {
		throw new AuthError(
			'request_failed',
			`Failed to complete login (HTTP ${res.status}).`,
			res.status,
		);
	}

	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch {
		throw new AuthError('invalid_response', 'Login response was not valid JSON.');
	}

	const token = extractToken(parsed);
	if (!token) {
		throw new AuthError(
			'invalid_response',
			'Login response did not include a token.',
		);
	}

	return { username: extractUsername(parsed) ?? username, token };
}

function extractToken(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null;
	const obj = body as Record<string, unknown>;
	// Wire format is snake_case (Swift client uses convertFromSnakeCase).
	const candidate = obj.sync_token ?? obj.syncToken ?? obj.token;
	return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function extractUsername(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null;
	const obj = body as Record<string, unknown>;
	return typeof obj.username === 'string' && obj.username.length > 0
		? obj.username
		: null;
}

export type LoadTokenOptions = {
	tokenPath?: string;
	env?: NodeJS.ProcessEnv;
};

// On POSIX, open the token with O_NOFOLLOW so a symlink at `path` raises
// ELOOP rather than being silently followed, then operate on the resulting
// handle (fstat / fchmod / readFile). Using one handle for the whole
// check-and-use closes the TOCTOU window where a symlink could be swapped
// in between an lstat and a path-based read. O_NONBLOCK keeps the open
// from hanging on a FIFO that has no writer (POSIX says O_NONBLOCK has no
// effect on reads from regular files, so the happy path is unchanged).
// Windows lacks a meaningful POSIX mode bit, so it falls back to a plain
// readFile.
async function readTokenFileSecure(path: string): Promise<string | null> {
	if (process.platform === 'win32') {
		try {
			return await readFile(path, 'utf-8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw err;
		}
	}

	let handle: FileHandle;
	try {
		handle = await open(
			path,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return null;
		if (code === 'ELOOP') {
			throw new Error(
				`Token file at ${path} is not a regular file (symlink or special file). Refusing to read for safety.`,
			);
		}
		throw err;
	}
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) {
			throw new Error(
				`Token file at ${path} is not a regular file (symlink or special file). Refusing to read for safety.`,
			);
		}
		const mode = stats.mode & 0o777;
		if (mode !== 0o600) {
			await handle.chmod(0o600);
			console.error(
				`[simplenote-mcp] Tightened ${path} permissions from ${mode.toString(8)} to 0600.`,
			);
		}
		return await handle.readFile('utf-8');
	} finally {
		await handle.close();
	}
}

export async function loadToken(opts: LoadTokenOptions = {}): Promise<AuthToken | null> {
	const env = opts.env ?? process.env;
	const envToken = env.SIMPLENOTE_TOKEN?.trim();
	if (envToken) {
		return { username: null, token: envToken };
	}

	const path = opts.tokenPath ?? getTokenPath();
	const raw = await readTokenFileSecure(path);
	if (raw === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const obj = parsed as Record<string, unknown>;
	const token = typeof obj.token === 'string' ? obj.token : null;
	if (!token) return null;
	const username = typeof obj.username === 'string' ? obj.username : null;
	return { username, token };
}

export async function saveToken(
	auth: AuthToken,
	tokenPath: string = getTokenPath(),
): Promise<string> {
	await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
	const payload = JSON.stringify(
		{ username: auth.username, token: auth.token },
		null,
		2,
	);
	// Write to a temp file, force mode 0600, then atomically rename.
	// writeFile({mode}) only applies on create, so an existing file with
	// looser perms would keep them — chmod guarantees 0600 every save.
	const tmpPath = `${tokenPath}.tmp-${process.pid}`;
	try {
		await writeFile(tmpPath, payload, { mode: 0o600 });
		await chmod(tmpPath, 0o600);
		await rename(tmpPath, tokenPath);
	} catch (err) {
		try {
			await unlink(tmpPath);
		} catch {
			// tmp file may not exist if writeFile itself failed
		}
		throw err;
	}
	return tokenPath;
}

export async function deleteToken(
	tokenPath: string = getTokenPath(),
): Promise<boolean> {
	try {
		await unlink(tokenPath);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw err;
	}
}

export const _test = { extractToken, extractUsername };
