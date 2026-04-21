import { homedir, platform } from 'os';
import { join } from 'path';

export const DEFAULT_NATIVE_STORE_PATH = join(
	homedir(),
	'Library/Group Containers/PZYM8XX95Q.com.automattic.SimplenoteMac/Data/Simplenote.storedata'
);

/**
 * Platform-appropriate path for the auth token file. Consumed by the auth
 * module (Person B) but defined here so path logic lives in one place.
 */
export function getAuthFilePath() {
	const home = homedir();
	switch (platform()) {
		case 'darwin':
			return join(home, 'Library/Application Support/simplenote-mcp/auth.json');
		case 'win32':
			return join(
				process.env.APPDATA || join(home, 'AppData/Roaming'),
				'simplenote-mcp/auth.json'
			);
		default:
			return join(
				process.env.XDG_CONFIG_HOME || join(home, '.config'),
				'simplenote-mcp/auth.json'
			);
	}
}
