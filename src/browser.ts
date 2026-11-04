import { spawn as nodeSpawn } from 'node:child_process';
import { platform as nodePlatform } from 'node:os';

export type OpenBrowserDeps = {
	platform?: () => NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	spawn?: typeof nodeSpawn;
};

// A browser opened over SSH (or on a Linux box with no display) lands on the
// wrong machine or nowhere; the caller prints the URL either way.
export function canOpenBrowser(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): boolean {
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
	if (platform === 'darwin' || platform === 'win32') return true;
	return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

function browserCommand(
	platform: NodeJS.Platform,
	url: string,
): [string, string[]] {
	switch (platform) {
		case 'darwin':
			return ['open', [url]];
		case 'win32':
			// Not `cmd /c start`: cmd splits the URL at `&`.
			return ['rundll32', ['url.dll,FileProtocolHandler', url]];
		default:
			return ['xdg-open', [url]];
	}
}

// Best-effort: resolves true if the opener process started, false if the
// environment looks headless or the opener couldn't be spawned. It does not
// wait for the opener to exit, so a launched-but-failed opener still reports
// true; callers should always show the URL as well.
export async function openBrowser(
	url: string,
	deps: OpenBrowserDeps = {},
): Promise<boolean> {
	const platform = (deps.platform ?? nodePlatform)();
	const env = deps.env ?? process.env;
	if (!canOpenBrowser(platform, env)) return false;

	const [command, args] = browserCommand(platform, url);
	const spawn = deps.spawn ?? nodeSpawn;
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, { detached: true, stdio: 'ignore' });
		} catch {
			resolve(false);
			return;
		}
		child.once('error', () => resolve(false));
		child.once('spawn', () => {
			child.unref();
			resolve(true);
		});
	});
}
