import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openBrowser as defaultOpenBrowser } from './browser.js';
import {
	AuthError,
	type AuthToken,
	completeLogin,
	deleteToken,
	getLoginUrl,
	loadToken,
	parseLoginCredential,
	saveToken,
} from './providers/auth.js';
import {
	type Config,
	ConfigError,
	loadConfig,
	saveConfig,
} from './providers/config.js';
import { getTokenPath } from './providers/paths.js';
import { DEFAULT_NATIVE_STORE_PATH } from './providers/resolver.js';
import {
	createTelemetry,
	disableTelemetry,
	telemetryEnv,
	type Telemetry,
} from './telemetry.js';

export type Subcommand = 'setup' | 'logout' | 'disable-telemetry';

export type SetupOptions = {
	authPath?: string;
	configPath?: string;
	telemetry?: Telemetry;
	// Injection points for tests. Defaults target a real readline interface,
	// the real os.platform, the real filesystem, and the real native store
	// path on macOS.
	createPrompt?: () => Interface;
	platform?: () => NodeJS.Platform;
	fileExists?: (path: string) => boolean;
	nativeStorePath?: string;
	env?: NodeJS.ProcessEnv;
	openBrowser?: (url: string) => Promise<boolean>;
	rateLimitDelayMs?: number;
};

// A mangled paste doesn't consume the code, so allow a few tries before
// giving up.
const MAX_CREDENTIAL_PROMPTS = 3;

export async function runSubcommand(name: Subcommand): Promise<number> {
	switch (name) {
		case 'setup':
			return setupCommand();
		case 'logout':
			return logoutCommand();
		case 'disable-telemetry':
			return disableTelemetryCommand();
	}
}

async function setupCommand(opts: SetupOptions = {}): Promise<number> {
	const platformFn = opts.platform ?? platform;
	const fileExistsFn = opts.fileExists ?? existsSync;
	const nativePath = opts.nativeStorePath ?? DEFAULT_NATIVE_STORE_PATH;
	const localStoreAvailable =
		platformFn() === 'darwin' && fileExistsFn(nativePath);

	const rl = (opts.createPrompt ?? defaultPrompt)();
	try {
		if (localStoreAvailable) {
			const answer = (
				await rl.question(
					'A local Simplenote database was detected. Use it? (read-only, no network) [Y/n]: ',
				)
			).trim();
			if (parseUseLocalResponse(answer)) {
				try {
					await saveConfig(
						{ source: 'local', writeMode: false },
						{ configPath: opts.configPath },
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.error(`Failed to save config: ${message}`);
					return 1;
				}
				await trackSetup(opts, {
					type: 'local',
					env: telemetryEnv(platformFn()),
				});
				console.log('\nUsing local Simplenote database.');
				console.log('\nSetup complete.');
				return 0;
			}
		}

		let existingToken: Awaited<ReturnType<typeof loadToken>>;
		try {
			existingToken = await loadToken({ tokenPath: opts.authPath });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`Failed to load existing token: ${message}`);
			return 1;
		}

		let username: string;
		let auth: 'existing_token' | 'new_login';
		if (existingToken) {
			auth = 'existing_token';
			username = existingToken.username ?? 'unknown';
			const currentConfig = await loadCurrentConfigOrNull(opts.configPath);
			console.log(`Logged in as ${username}.`);
			if (currentConfig === null) {
				console.log(`Write-mode is currently: not configured.\n`);
			} else if (currentConfig.source === 'local') {
				// writeMode wasn't a real choice in local mode — don't print ON/OFF.
				console.log(`Previously using local Simplenote database.\n`);
			} else {
				const writeModeDisplay = currentConfig.writeMode ? 'ON' : 'OFF';
				console.log(`Write-mode is currently: ${writeModeDisplay}.\n`);
			}
		} else {
			auth = 'new_login';
			const token = await loginWithBrowser(rl, opts);
			if (typeof token === 'number') return token;

			try {
				await saveToken(token, opts.authPath);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`Failed to save token: ${message}`);
				return 1;
			}

			username = token.username ?? 'unknown';
			console.log(`\nLogged in as ${username}.\n`);
		}

		const response = (await rl.question('Enable write-mode? [y/N]: ')).trim();
		const writeMode = parseWriteModeResponse(response);

		try {
			await saveConfig(
				{ source: 'api', writeMode },
				{ configPath: opts.configPath },
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`Failed to save config: ${message}`);
			return 1;
		}

		await trackSetup(opts, {
			type: 'api',
			env: telemetryEnv(platformFn()),
			auth,
			writeMode,
		});
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

// Sends the user to the browser login and redeems the `email:CODE` string it
// shows. Returns the token, or an exit code after printing the failure.
async function loginWithBrowser(
	rl: Interface,
	opts: SetupOptions,
): Promise<AuthToken | number> {
	const env = opts.env ?? process.env;
	let loginUrl: string;
	try {
		loginUrl = getLoginUrl(env);
	} catch (err) {
		return reportAuthError(err, 'Invalid configuration.');
	}

	const opened = await (opts.openBrowser ?? defaultOpenBrowser)(loginUrl);
	if (opened) {
		console.log('Opening your browser to log in to Simplenote.');
		console.log(`If it didn't open, visit:\n\n  ${loginUrl}\n`);
	} else {
		console.log(`Open this URL in a browser to log in to Simplenote:\n\n  ${loginUrl}\n`);
	}
	console.log('After you log in, the page shows a code like you@example.com:ABC123.');

	let credential: ReturnType<typeof parseLoginCredential> = null;
	for (let i = 0; i < MAX_CREDENTIAL_PROMPTS && !credential; i++) {
		const input = await rl.question('Paste it here: ');
		credential = parseLoginCredential(input);
		if (!credential) {
			console.error('Expected the full code shown in your browser, in the form email:CODE.');
		}
	}
	if (!credential) return 1;

	// Ctrl-C closes the readline interface; abort any rate-limit wait with it.
	const controller = new AbortController();
	const onClose = () => controller.abort();
	rl.once('close', onClose);
	try {
		const token = await completeLogin(credential.username, credential.authCode, {
			env,
			signal: controller.signal,
			rateLimitDelayMs: opts.rateLimitDelayMs,
			onRateLimited: (delayMs) => {
				console.log(
					`Simplenote is rate limiting logins; retrying in ${Math.round(delayMs / 1000)}s. (Ctrl-C to cancel)`,
				);
			},
		});
		controller.signal.throwIfAborted();
		return token;
	} catch (err) {
		if (isAbortError(err)) throw err;
		if (err instanceof AuthError && err.code === 'invalid_code') {
			console.error(`Login failed. ${err.message}`);
			console.error('Run setup again to get a fresh code.');
			return 1;
		}
		return reportAuthError(err, 'Login failed.');
	} finally {
		rl.off('close', onClose);
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
	return (
		err instanceof Error &&
		((err as NodeJS.ErrnoException).code === 'ABORT_ERR' || err.name === 'AbortError')
	);
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

async function disableTelemetryCommand(opts: {
	telemetryPath?: string;
} = {}): Promise<number> {
	try {
		const path = await disableTelemetry({ telemetryPath: opts.telemetryPath });
		console.log(`Telemetry disabled. Stored preference at ${path}.`);
		return 0;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Failed to disable telemetry: ${message}`);
		console.error('Check that the telemetry settings path is writable and try again.');
		return 1;
	}
}

async function trackSetup(
	opts: SetupOptions,
	props: Parameters<Telemetry['trackSetup']>[0],
): Promise<void> {
	const telemetry = opts.telemetry ?? (await createTelemetry());
	try {
		await telemetry.trackSetup(props);
	} catch {
		// Setup should never fail because telemetry could not be sent.
	}
}

export const _test = {
	reportAuthError,
	parseWriteModeResponse,
	parseUseLocalResponse,
	setupCommand,
	disableTelemetryCommand,
};

function parseWriteModeResponse(input: string): boolean {
	const normalized = input.trim().toLowerCase();
	return normalized === 'y' || normalized === 'yes';
}

function parseUseLocalResponse(input: string): boolean {
	// Default [Y/n]: empty/whitespace means yes.
	const normalized = input.trim().toLowerCase();
	return normalized === '' || normalized === 'y' || normalized === 'yes';
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
