import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import { dirname } from 'node:path';
import type { ParsedUrlQueryInput } from 'node:querystring';
import { getTelemetryPath } from './providers/paths.js';

export const TELEMETRY_USER_TYPE = 'simplenote_mcp';
const TELEMETRY_EVENT_PREFIX = 'simplenote_mcp';
const DISABLE_ENV_VAR = 'SIMPLENOTE_MCP_DISABLE_TELEMETRY';
const TRACKS_EVENT_TIMEOUT_MS = 1500;

export type SetupTelemetryType = 'local' | 'api';
export type SetupTelemetryEnv = 'mac' | 'windows' | 'linux';

export type SetupTelemetryProps = {
	type: SetupTelemetryType;
	env: SetupTelemetryEnv;
	auth?: 'existing_token' | 'new_login';
	writeMode?: boolean;
};

export type ToolTelemetryProps = {
	tool: string;
	provider: string;
	success: boolean;
};

export type Telemetry = {
	trackSetup(props: SetupTelemetryProps): Promise<void>;
	trackToolCall(props: ToolTelemetryProps): Promise<void>;
};

export type TelemetryClient = {
	trackEvent(eventName: string, props?: TelemetryProperties): Promise<void>;
};

export type TelemetryOptions = {
	telemetryPath?: string;
	env?: NodeJS.ProcessEnv;
	createClient?: (userId: string) => TelemetryClient;
};

type TelemetryProperties = Record<string, string | number | boolean | undefined>;

type TelemetryState = {
	userId?: string;
	disabled?: boolean;
};

type NodeTracksFactory = (
	prefix: string,
	globalParams: ParsedUrlQueryInput,
) => NodeTracks;

type NodeTracks = {
	trackEvent(
		eventName: string,
		extraParams?: ParsedUrlQueryInput,
		logger?: typeof NOOP_TRACKS_LOGGER,
	): Promise<void>;
};

const require = createRequire(import.meta.url);

export const NOOP_TELEMETRY: Telemetry = {
	async trackSetup() {},
	async trackToolCall() {},
};

export async function createTelemetry(
	opts: TelemetryOptions = {},
): Promise<Telemetry> {
	try {
		if (isTelemetryDisabledByEnv(opts.env)) return NOOP_TELEMETRY;
		if (await isTelemetryDisabled({ telemetryPath: opts.telemetryPath })) {
			return NOOP_TELEMETRY;
		}

		const userId = await ensureTelemetryUserId({
			telemetryPath: opts.telemetryPath,
		});
		const client = opts.createClient
			? opts.createClient(userId)
			: createNodeTracksClient(userId);
		return new TracksTelemetry(client);
	} catch {
		return NOOP_TELEMETRY;
	}
}

export async function ensureTelemetryUserId(opts: {
	telemetryPath?: string;
} = {}): Promise<string> {
	const telemetryPath = opts.telemetryPath ?? getTelemetryPath();
	const state = await loadTelemetryState(telemetryPath);
	if (state.userId && isUuid(state.userId)) return state.userId;

	const userId = randomUUID();
	await saveTelemetryState(telemetryPath, { ...state, userId });
	return userId;
}

export async function disableTelemetry(opts: {
	telemetryPath?: string;
} = {}): Promise<string> {
	const telemetryPath = opts.telemetryPath ?? getTelemetryPath();
	const state = await loadTelemetryState(telemetryPath);
	await saveTelemetryState(telemetryPath, { ...state, disabled: true });
	return telemetryPath;
}

export async function isTelemetryDisabled(opts: {
	telemetryPath?: string;
} = {}): Promise<boolean> {
	const telemetryPath = opts.telemetryPath ?? getTelemetryPath();
	const state = await loadTelemetryState(telemetryPath);
	return state.disabled === true;
}

export function isTelemetryDisabledByEnv(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const value = env[DISABLE_ENV_VAR]?.trim().toLowerCase();
	if (!value) return false;
	return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off';
}

export function telemetryEnv(
	value: NodeJS.Platform = platform(),
): SetupTelemetryEnv {
	if (value === 'darwin') return 'mac';
	if (value === 'win32') return 'windows';
	return 'linux';
}

export function makeTrackedToolHandler(
	telemetry: Telemetry,
	getProvider: () => string,
): <T>(
	tool: string,
	handler: () => T | Promise<T>,
) => Promise<T> {
	return async (tool, handler) => {
		try {
			const result = await handler();
			trackToolCall(telemetry, {
				tool,
				provider: getProvider(),
				success: !isMcpErrorResult(result),
			});
			return result;
		} catch (err) {
			trackToolCall(telemetry, {
				tool,
				provider: getProvider(),
				success: false,
			});
			throw err;
		}
	};
}

class TracksTelemetry implements Telemetry {
	constructor(private readonly client: TelemetryClient) {}

	async trackSetup(props: SetupTelemetryProps): Promise<void> {
		await safeTrack(this.client, 'setup', {
			type: props.type,
			env: props.env,
			auth: props.auth,
			write_mode:
				props.writeMode === undefined
					? undefined
					: props.writeMode
						? 'enabled'
						: 'disabled',
		});
	}

	async trackToolCall(props: ToolTelemetryProps): Promise<void> {
		await safeTrack(this.client, 'tool_call', {
			tool: props.tool,
			provider: props.provider,
			success: props.success ? 'true' : 'false',
		});
	}
}

function createNodeTracksClient(userId: string): TelemetryClient {
	const createTracks = loadNodeTracks();
	const tracks = createTracks(TELEMETRY_EVENT_PREFIX, {
		_ut: TELEMETRY_USER_TYPE,
		_ui: userId,
	});
	return createTracksTelemetryClient(tracks);
}

function createTracksTelemetryClient(
	tracks: NodeTracks,
	timeoutMs = TRACKS_EVENT_TIMEOUT_MS,
): TelemetryClient {
	return {
		async trackEvent(eventName, props = {}) {
			try {
				await withTimeout(
					tracks.trackEvent(eventName, toTracksParams(props), NOOP_TRACKS_LOGGER),
					timeoutMs,
				);
			} catch {
				// Defensive: keep telemetry failures isolated from callers.
			}
		},
	};
}

function loadNodeTracks(): NodeTracksFactory {
	const mod = require('@automattic/node-tracks') as unknown;
	if (typeof mod === 'function') return mod as NodeTracksFactory;
	if (
		mod &&
		typeof mod === 'object' &&
		typeof (mod as { default?: unknown }).default === 'function'
	) {
		return (mod as { default: NodeTracksFactory }).default;
	}
	throw new Error('Could not load @automattic/node-tracks.');
}

async function safeTrack(
	client: TelemetryClient,
	eventName: string,
	props: TelemetryProperties,
): Promise<void> {
	try {
		await client.trackEvent(eventName, props);
	} catch {
		// Telemetry must never affect the MCP command or tool result.
	}
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<void>((resolve) => {
		timeout = setTimeout(resolve, timeoutMs);
	});
	try {
		await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function toTracksParams(props: TelemetryProperties): ParsedUrlQueryInput {
	const out: ParsedUrlQueryInput = {};
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined) continue;
		out[key] = value;
	}
	return out;
}

function isMcpErrorResult(result: unknown): boolean {
	if (!result || typeof result !== 'object') return false;
	return (result as { isError?: unknown }).isError === true;
}

function trackToolCall(telemetry: Telemetry, props: ToolTelemetryProps): void {
	void telemetry.trackToolCall(props).catch(() => {});
}

async function loadTelemetryState(path: string): Promise<TelemetryState> {
	let raw: string;
	try {
		raw = await readFile(path, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
		return { disabled: true };
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return { disabled: true };
		const obj = parsed as Record<string, unknown>;
		return {
			userId: typeof obj.userId === 'string' ? obj.userId : undefined,
			disabled: typeof obj.disabled === 'boolean' ? obj.disabled : undefined,
		};
	} catch {
		return { disabled: true };
	}
}

async function saveTelemetryState(
	path: string,
	state: TelemetryState,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const payload = `${JSON.stringify(state, null, 2)}\n`;
	const tmpPath = `${path}.tmp-${process.pid}`;
	try {
		await writeFile(tmpPath, payload, { mode: 0o600 });
		await chmod(tmpPath, 0o600);
		await rename(tmpPath, path);
	} catch (err) {
		try {
			await unlink(tmpPath);
		} catch {
			// tmp file may not exist if writeFile itself failed
		}
		throw err;
	}
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}

const NOOP_TRACKS_LOGGER = {
	debug() {},
	warn() {},
};

export const _test = {
	createTracksTelemetryClient,
	loadTelemetryState,
	toTracksParams,
};
