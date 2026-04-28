#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Provider } from './providers/normalize.js';
import { resolveProvider } from './providers/resolver.js';
import { parseServerArgs } from './server-args.js';
import { createTelemetry, makeTrackedToolHandler } from './telemetry.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

// CLI subcommand dispatch must run before MCP/store setup.
const subcommand = process.argv[2];
if (
	subcommand === 'setup' ||
	subcommand === 'logout' ||
	subcommand === 'disable-telemetry'
) {
	const { runSubcommand } = await import('./cli.js');
	process.exit(await runSubcommand(subcommand));
}

let explicitPath: string | undefined;
try {
	({ explicitPath } = parseServerArgs(process.argv.slice(2)));
} catch (err) {
	console.error(`Error: ${(err as Error).message}`);
	process.exit(1);
}

let provider: Provider;
try {
	provider = await resolveProvider({ explicitPath });
} catch (err) {
	console.error(`Error: ${(err as Error).message}`);
	process.exit(1);
}

const telemetry = await createTelemetry();
const trackTool = makeTrackedToolHandler(telemetry, () => provider.name);
const server = new McpServer({ name: 'simplenote', version: '1.0.0' });

function trackedTool<TArgs extends unknown[], TResult>(
	name: string,
	handler: (...args: TArgs) => TResult | Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
	return (...args) => trackTool(name, () => handler(...args));
}

registerReadTools({ server, provider, trackedTool });
registerWriteTools({ server, provider, trackedTool });

const transport = new StdioServerTransport();
await server.connect(transport);
