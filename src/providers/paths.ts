import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const APP_NAME = 'simplenote-mcp';
const TOKEN_FILE = 'auth.json';

export function getConfigDir(): string {
	switch (platform()) {
		case 'darwin':
			return join(homedir(), 'Library', 'Application Support', APP_NAME);
		case 'win32': {
			const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
			return join(appData, APP_NAME);
		}
		default: {
			const xdg = process.env.XDG_CONFIG_HOME?.trim();
			const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
			return join(base, APP_NAME);
		}
	}
}

export function getTokenPath(): string {
	return join(getConfigDir(), TOKEN_FILE);
}
