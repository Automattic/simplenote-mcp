import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
	AuthError,
	completeLogin,
	deleteToken,
	loadToken,
	requestLoginCode,
	saveToken,
} from './providers/auth.js';
import {
	type Config,
	ConfigError,
	loadConfig,
	saveConfig,
} from './providers/config.js';
import { getTokenPath } from './providers/paths.js';

export type Subcommand = 'setup' | 'logout';

export type SetupOptions = {
	authPath?: string;
	configPath?: string;
	// Injection point for tests. Defaults to a real readline interface against
	// stdin/stdout.
	createPrompt?: () => Interface;
};

export async function runSubcommand(name: Subcommand): Promise<number> {
	switch (name) {
		case 'setup':
			return setupCommand();
		case 'logout':
			return logoutCommand();
	}
}

async function setupCommand(opts: SetupOptions = {}): Promise<number> {
	const rl = (opts.createPrompt ?? defaultPrompt)();
	try {
		const existingToken = await loadToken({ tokenPath: opts.authPath });

		let username: string;
		if (existingToken) {
			username = existingToken.username ?? 'unknown';
			const currentConfig = await loadCurrentConfigOrNull(opts.configPath);
			const writeModeDisplay =
				currentConfig === null
					? 'not configured'
					: currentConfig.writeMode
						? 'ON'
						: 'OFF';
			console.log(`Logged in as ${username}.`);
			console.log(`Write-mode is currently: ${writeModeDisplay}.\n`);
		} else {
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

			console.log(
				`\nCheck ${email} for a message from Simplenote with a short auth code.`,
			);
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

			try {
				await saveToken(token, opts.authPath);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`Failed to save token: ${message}`);
				return 1;
			}

			username = token.username ?? email;
			console.log(`\nLogged in as ${username}.\n`);
		}

		const response = (await rl.question('Enable write-mode? [y/N]: ')).trim();
		const writeMode = parseWriteModeResponse(response);

		try {
			await saveConfig({ writeMode }, { configPath: opts.configPath });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`Failed to save config: ${message}`);
			return 1;
		}

		console.log(`\nWrite-mode: ${writeMode ? 'enabled' : 'disabled'}.`);
		console.log('\nSetup complete.');
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

function defaultPrompt(): Interface {
	return createInterface({ input: stdin, output: stdout });
}

async function loadCurrentConfigOrNull(configPath?: string): Promise<Config | null> {
	try {
		return await loadConfig({ configPath });
	} catch (err) {
		if (err instanceof ConfigError && err.code === 'missing') return null;
		if (err instanceof ConfigError && err.code === 'invalid') {
			console.error('Existing config is malformed and will be replaced.');
			return null;
		}
		throw err;
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

export const _test = { reportAuthError, parseWriteModeResponse, setupCommand };

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
