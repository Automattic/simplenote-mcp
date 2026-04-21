import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { loadToken } from './auth.js';
import type { Provider } from './normalize.js';
import { createNativeProvider } from './native-macos.js';
import { createApiProvider } from './simperium-api.js';

export const DEFAULT_NATIVE_STORE_PATH = `${homedir()}/Library/Group Containers/PZYM8XX95Q.com.automattic.SimplenoteMac/Data/Simplenote.storedata`;

export type ResolveOptions = {
	explicitPath?: string;
};

export async function resolveProvider(options: ResolveOptions = {}): Promise<Provider> {
	if (options.explicitPath) {
		if (!existsSync(options.explicitPath)) {
			throw new Error(
				`Simplenote store not found at: ${options.explicitPath}\n` +
					'Check that --path points to a valid Simplenote.storedata file.',
			);
		}
		return createNativeProvider(options.explicitPath);
	}

	const isMac = platform() === 'darwin';
	if (isMac && existsSync(DEFAULT_NATIVE_STORE_PATH)) {
		return createNativeProvider(DEFAULT_NATIVE_STORE_PATH);
	}

	const token = await loadToken();
	if (token) {
		return createApiProvider();
	}

	if (isMac) {
		throw new Error(
			'No Simplenote data source available.\n' +
				`Either install/sync the Simplenote desktop app (default path: ${DEFAULT_NATIVE_STORE_PATH}),\n` +
				'or run `simplenote-mcp login` to authenticate against the Simperium API.',
		);
	}
	throw new Error(
		'Not logged in. Run `simplenote-mcp login` to authenticate, or set SIMPLENOTE_TOKEN.',
	);
}
