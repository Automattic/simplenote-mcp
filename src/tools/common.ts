import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Provider } from '../providers/normalize.js';

export type TrackedTool = <TArgs extends unknown[], TResult>(
	name: string,
	handler: (...args: TArgs) => TResult | Promise<TResult>,
) => (...args: TArgs) => Promise<TResult>;

export interface ToolRegistrationContext {
	server: McpServer;
	provider: Provider;
	trackedTool: TrackedTool;
}

// All tools are read-only queries. The Simperium provider is network-bound,
// so openWorldHint is true even though the native macOS provider is local.
export const READ_ONLY_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;

// Pure creates: no existing state to clobber.
export const CREATE_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
} as const;

// Full-content replacement: destructive in the MCP sense even though
// Simplenote preserves history. Clients use this for confirmation UX.
export const UPDATE_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
} as const;

// Trashing is destructive but soft (recoverable from any Simplenote client)
// and idempotent — a second call on an already-trashed note is a no-op.
export const TRASH_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: true,
} as const;

// Restoring reverses a trash. Constructive, not destructive — if the model
// restores the wrong note the user trashes it again. Idempotent: a second
// call on an already-restored note is a no-op.
export const RESTORE_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;

// Revert overwrites current content with a historical version. Destructive
// because it replaces the present state, but idempotent for a fixed
// {id, version}: after the first successful revert, the provider
// short-circuits subsequent identical calls as a no-op.
export const REVERT_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: true,
} as const;

export function toolError(err: unknown): {
	content: [{ type: 'text'; text: string }];
	isError: true;
} {
	const message = err instanceof Error ? err.message : String(err);
	return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
