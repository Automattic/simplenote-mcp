#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Provider } from './providers/normalize.js';
import { resolveProvider } from './providers/resolver.js';
import { parseServerArgs } from './server-args.js';
import { createTelemetry, makeTrackedToolHandler } from './telemetry.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

const pkg = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

const USAGE = `Usage: simplenote-mcp [options]
       simplenote-mcp <subcommand>

Run the Simplenote MCP server. Without a subcommand, the server starts and
communicates with MCP clients over stdio.

Options:
  --path <path>      Force the read-only macOS Core Data store at <path>.
  --path=<path>      Same, with an = separator.
  -h, --help         Show this help and exit.
  -V, --version      Show version and exit.

Subcommands:
  setup              Run interactive setup (configure provider, log in).
  logout             Clear stored Simperium credentials.
  disable-telemetry  Disable anonymous telemetry.
`;

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
let mode: 'help' | 'version' | undefined;
try {
	({ explicitPath, mode } = parseServerArgs(process.argv.slice(2)));
} catch (err) {
	console.error(`Error: ${(err as Error).message}`);
	process.exit(1);
}

if (mode === 'help') {
	process.stdout.write(USAGE);
	process.exit(0);
}
if (mode === 'version') {
	console.log(pkg.version);
	process.exit(0);
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
const server = new McpServer({ name: 'simplenote', version: pkg.version });

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
