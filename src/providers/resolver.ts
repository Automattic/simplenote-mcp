import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { loadToken, type AuthToken } from './auth.js';
import type { Provider } from './normalize.js';
import { createNativeProvider } from './native-macos.js';
import { createApiProvider } from './simperium-api.js';

export const DEFAULT_NATIVE_STORE_PATH = `${homedir()}/Library/Group Containers/PZYM8XX95Q.com.automattic.SimplenoteMac/Data/Simplenote.storedata`;

export type ResolveOptions = {
	explicitPath?: string;
};

export type ResolveDeps = {
	platform?: () => NodeJS.Platform;
	fileExists?: (path: string) => boolean;
	loadToken?: () => Promise<AuthToken | null>;
	nativeStorePath?: string;
	makeNative?: (path: string) => Provider;
	makeApi?: () => Provider;
};

export async function resolveProvider(
	options: ResolveOptions = {},
	deps: ResolveDeps = {},
): Promise<Provider> {
	const platformFn = deps.platform ?? platform;
	const fileExists = deps.fileExists ?? existsSync;
	const tokenLoader = deps.loadToken ?? loadToken;
	const nativePath = deps.nativeStorePath ?? DEFAULT_NATIVE_STORE_PATH;
	const makeNative = deps.makeNative ?? createNativeProvider;
	const makeApi = deps.makeApi ?? createApiProvider;

	if (options.explicitPath) {
		if (!fileExists(options.explicitPath)) {
			throw new Error(
				`Simplenote store not found at: ${options.explicitPath}\n` +
					'Check that --path points to a valid Simplenote.storedata file.',
			);
		}
		return makeNative(options.explicitPath);
	}

	const isMac = platformFn() === 'darwin';
	if (isMac && fileExists(nativePath)) {
		return makeNative(nativePath);
	}

	const token = await tokenLoader();
	if (token) {
		return makeApi();
	}

	if (isMac) {
		throw new Error(
			'No Simplenote data source available.\n' +
				`Either install/sync the Simplenote desktop app (default path: ${nativePath}),\n` +
				'or run `simplenote-mcp login` to authenticate against the Simperium API.',
		);
	}
	throw new Error(
		'Not logged in. Run `simplenote-mcp login` to authenticate, or set SIMPLENOTE_TOKEN.',
	);
}
