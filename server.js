#!/usr/bin/env node
try {
	await import('./dist/server.js');
} catch (err) {
	console.error('Failed to start simplenote-mcp:', err?.message ?? err);
	if (err?.code === 'ERR_MODULE_NOT_FOUND') {
		console.error('Build output is missing. Run `pnpm install` or `pnpm build`.');
	}
	process.exit(1);
}
