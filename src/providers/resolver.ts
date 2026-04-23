import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadToken, type AuthToken } from './auth.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import type { Provider } from './normalize.js';
import { createNativeProvider } from './native-macos.js';
import { createApiProvider } from './simperium-api.js';

export const DEFAULT_NATIVE_STORE_PATH = `${homedir()}/Library/Group Containers/PZYM8XX95Q.com.automattic.SimplenoteMac/Data/Simplenote.storedata`;

export type ResolveOptions = {
	explicitPath?: string;
};

export type ResolveDeps = {
	fileExists?: (path: string) => boolean;
	loadToken?: () => Promise<AuthToken | null>;
	loadConfig?: () => Promise<Config>;
	nativeStorePath?: string;
	makeNative?: (path: string) => Provider;
	makeApi?: () => Provider;
};

export async function resolveProvider(
	options: ResolveOptions = {},
	deps: ResolveDeps = {},
): Promise<Provider> {
	const fileExists = deps.fileExists ?? existsSync;
	const tokenLoader = deps.loadToken ?? loadToken;
	const configLoader = deps.loadConfig ?? (() => loadConfig());
	const nativePath = deps.nativeStorePath ?? DEFAULT_NATIVE_STORE_PATH;
	const makeNative = deps.makeNative ?? createNativeProvider;
	const makeApi = deps.makeApi ?? createApiProvider;

	// --path overrides everything. Loading config is best-effort: we only do it
	// so we can warn when the user explicitly enabled write-mode but --path is
	// now forcing a read-only native provider. Missing or malformed config
	// should never block an explicit path.
	if (options.explicitPath) {
		if (!fileExists(options.explicitPath)) {
			throw new Error(
				`Simplenote store not found at: ${options.explicitPath}\n` +
					'Check that --path points to a valid Simplenote.storedata file.',
			);
		}
		try {
			const config = await configLoader();
			if (config.source === 'api' && config.writeMode) {
				console.error(
					'Note: --path overrides write-mode. Using native provider (read-only) for this session.',
				);
			}
		} catch {
			// Intentional: --path should work even if config is missing or invalid.
		}
		return makeNative(options.explicitPath);
	}

	let config: Config;
	try {
		config = await configLoader();
	} catch (err) {
		if (err instanceof ConfigError && err.code === 'missing') {
			throw new Error(
				'No configuration found. Run `simplenote-mcp setup` to get started.',
			);
		}
		if (err instanceof ConfigError && err.code === 'invalid') {
			throw new Error(
				'Configuration file is malformed. Run `simplenote-mcp setup` to reset it.',
			);
		}
		throw err;
	}

	if (config.source === 'local') {
		if (!fileExists(nativePath)) {
			throw new Error(
				'Local Simplenote database not found. Run `simplenote-mcp setup` to switch to API mode.',
			);
		}
		return makeNative(nativePath);
	}

	// source === 'api' from here. writeMode gates the error message copy but
	// both paths need a token.
	const token = await tokenLoader();
	if (config.writeMode) {
		if (!token) {
			throw new Error(
				'Write-mode is enabled but no auth token found. Run `simplenote-mcp setup`.',
			);
		}
		return makeApi();
	}

	if (!token) {
		throw new Error(
			'No auth token found. Run `simplenote-mcp setup` to authenticate.',
		);
	}
	return makeApi();
}
