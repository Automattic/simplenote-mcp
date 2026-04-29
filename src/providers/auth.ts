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
import { getTokenPath } from './paths.js';

const SIMPLENOTE_AUTH_BASE = 'https://app.simplenote.com';
// The official macOS client uses platformName ("macOS"/"iOS"). Server-issued
// tokens appear to be scoped by request_source — using a custom value yields
// a token that is rejected by the Simperium API.
const REQUEST_SOURCE = 'macOS';
const FETCH_TIMEOUT_MS = 15_000;

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
	| 'request_failed'
	| 'invalid_code'
	| 'invalid_response'
	| 'network_error'
	| 'rate_limited';

async function postJson(path: string, body: unknown): Promise<Response> {
	const url = `${SIMPLENOTE_AUTH_BASE}${path}`;
	try {
		return await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
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

export async function requestLoginCode(email: string): Promise<void> {
	const res = await postJson('/account/request-login', {
		username: email,
		request_source: REQUEST_SOURCE,
	});

	if (res.status === 429) {
		throw new AuthError(
			'rate_limited',
			'Too many login requests. Wait a few minutes and try again.',
			429,
		);
	}
	if (!res.ok) {
		throw new AuthError(
			'request_failed',
			`Failed to request login code (HTTP ${res.status}).`,
			res.status,
		);
	}
}

export async function completeLogin(
	email: string,
	authCode: string,
): Promise<AuthToken> {
	const res = await postJson('/account/complete-login', {
		username: email,
		auth_code: authCode,
	});

	if (res.status === 401 || res.status === 403) {
		throw new AuthError(
			'invalid_code',
			'Auth code rejected. Check the code from your email and try again.',
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

	const username = extractUsername(parsed) ?? email;
	return { username, token };
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
