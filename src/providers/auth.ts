import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTokenPath } from './paths.js';

const SIMPLENOTE_AUTH_BASE = 'https://app.simplenote.com';
// The official macOS client uses platformName ("macOS"/"iOS"). Server-issued
// tokens appear to be scoped by request_source — using a custom value yields
// a token that is rejected by the Simperium API.
const REQUEST_SOURCE = 'macOS';

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
	| 'network_error';

async function postJson(path: string, body: unknown): Promise<Response> {
	const url = `${SIMPLENOTE_AUTH_BASE}${path}`;
	try {
		return await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
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

export async function loadToken(opts: LoadTokenOptions = {}): Promise<AuthToken | null> {
	const env = opts.env ?? process.env;
	const envToken = env.SIMPLENOTE_TOKEN?.trim();
	if (envToken) {
		return { username: null, token: envToken };
	}

	const path = opts.tokenPath ?? getTokenPath();
	let raw: string;
	try {
		raw = await readFile(path, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}

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
	await writeFile(tokenPath, payload, { mode: 0o600 });
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
