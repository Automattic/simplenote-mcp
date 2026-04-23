import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const APP_NAME = 'simplenote-mcp';
const TOKEN_FILE = 'auth.json';
const CONFIG_FILE = 'config.json';

export type PathContext = {
	platform: NodeJS.Platform;
	homedir: string;
	env: NodeJS.ProcessEnv;
};

export function defaultPathContext(): PathContext {
	return { platform: platform(), homedir: homedir(), env: process.env };
}

export function getConfigDir(ctx: PathContext = defaultPathContext()): string {
	switch (ctx.platform) {
		case 'darwin':
			return join(ctx.homedir, 'Library', 'Application Support', APP_NAME);
		case 'win32': {
			const appData = ctx.env.APPDATA ?? join(ctx.homedir, 'AppData', 'Roaming');
			return join(appData, APP_NAME);
		}
		default: {
			const xdg = ctx.env.XDG_CONFIG_HOME?.trim();
			const base = xdg && xdg.length > 0 ? xdg : join(ctx.homedir, '.config');
			return join(base, APP_NAME);
		}
	}
}

export function getTokenPath(ctx?: PathContext): string {
	return join(getConfigDir(ctx), TOKEN_FILE);
}

export function getConfigPath(ctx?: PathContext): string {
	return join(getConfigDir(ctx), CONFIG_FILE);
}
