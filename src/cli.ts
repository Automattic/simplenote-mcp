import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
	AuthError,
	completeLogin,
	deleteToken,
	requestLoginCode,
	saveToken,
} from './providers/auth.js';
import { getTokenPath } from './providers/paths.js';

export type Subcommand = 'setup' | 'logout';

export async function runSubcommand(name: Subcommand): Promise<number> {
	switch (name) {
		case 'setup':
			return setupCommand();
		case 'logout':
			return logoutCommand();
	}
}

async function setupCommand(): Promise<number> {
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const email = (await rl.question('Simplenote email: ')).trim();
		if (!email) {
			console.error('Email is required.');
			return 1;
		}

		try {
			await requestLoginCode(email);
		} catch (err) {
			return reportAuthError(err, 'Could not request login code.');
		}

		console.log(`\nCheck ${email} for a message from Simplenote with a short auth code.`);
		const authCode = (await rl.question('Auth code: ')).trim().toUpperCase();
		if (!authCode) {
			console.error('Auth code is required.');
			return 1;
		}

		let token;
		try {
			token = await completeLogin(email, authCode);
		} catch (err) {
			return reportAuthError(err, 'Login failed.');
		}

		const path = await saveToken(token);
		console.log(`\nLogged in as ${token.username ?? email}.`);
		console.log(`Token saved to ${path}`);
		return 0;
	} catch (err) {
		if (isAbortError(err)) {
			console.log('\nAborted.');
			return 1;
		}
		throw err;
	} finally {
		rl.close();
	}
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ABORT_ERR';
}

async function logoutCommand(): Promise<number> {
	const existed = await deleteToken();
	if (existed) {
		console.log(`Removed ${getTokenPath()}`);
	} else {
		console.log('No stored token found.');
	}
	return 0;
}

export const _test = { reportAuthError, parseWriteModeResponse };

function parseWriteModeResponse(input: string): boolean {
	const normalized = input.trim().toLowerCase();
	return normalized === 'y' || normalized === 'yes';
}

function reportAuthError(err: unknown, prefix: string): number {
	if (err instanceof AuthError) {
		console.error(`${prefix} ${err.message}`);
		if (err.code === 'network_error') {
			console.error('Check your network connection and try again.');
		}
	} else {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`${prefix} ${message}`);
	}
	return 1;
}
