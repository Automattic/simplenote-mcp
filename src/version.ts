import { readFileSync } from 'node:fs';

// Resolves to the repo-root package.json from both src/ (tsx) and dist/.
const pkg = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export const VERSION = pkg.version;
export const USER_AGENT = `simplenote-mcp/${VERSION}`;
