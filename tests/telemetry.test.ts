import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, stat, writeFile } from 'node:fs/promises';
import {
	TELEMETRY_USER_TYPE,
	_test,
	createTelemetry,
	disableTelemetry,
	ensureTelemetryUserId,
	isTelemetryDisabled,
	isTelemetryDisabledByEnv,
	makeTrackedToolHandler,
	telemetryEnv,
	type Telemetry,
} from '../src/telemetry.ts';
import { useTmpDir } from './helpers/general.ts';

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('telemetry identity', () => {
	const tmp = useTmpDir('simplenote-mcp-telemetry-');

	it('creates and reuses a persistent UUID', async () => {
		const telemetryPath = tmp.path('telemetry.json');
		const first = await ensureTelemetryUserId({ telemetryPath });
		const second = await ensureTelemetryUserId({ telemetryPath });

		assert.match(first, UUID_RE);
		assert.equal(second, first);

		const state = JSON.parse(await readFile(telemetryPath, 'utf-8'));
		assert.deepEqual(state, { userId: first });
	});

	it('writes the telemetry file with mode 0600', async (t) => {
		if (process.platform === 'win32') {
			t.skip('POSIX permissions are not enforced on Windows');
			return;
		}

		const telemetryPath = tmp.path('telemetry.json');
		await ensureTelemetryUserId({ telemetryPath });
		const st = await stat(telemetryPath);
		assert.equal(st.mode & 0o777, 0o600);
	});

	it('persists opt-out and preserves an existing UUID', async () => {
		const telemetryPath = tmp.path('telemetry.json');
		const userId = await ensureTelemetryUserId({ telemetryPath });
		const path = await disableTelemetry({ telemetryPath });

		assert.equal(path, telemetryPath);
		assert.equal(await isTelemetryDisabled({ telemetryPath }), true);
		const state = JSON.parse(await readFile(telemetryPath, 'utf-8'));
		assert.deepEqual(state, { userId, disabled: true });
	});

	it('treats invalid telemetry state as disabled', async () => {
		const telemetryPath = tmp.path('telemetry.json');
		await writeFile(telemetryPath, '{not json');

		assert.equal(await isTelemetryDisabled({ telemetryPath }), true);
	});
});

describe('createTelemetry', () => {
	const tmp = useTmpDir('simplenote-mcp-telemetry-');

	it('uses the Simplenote MCP Tracks user type', () => {
		assert.equal(TELEMETRY_USER_TYPE, 'simplenote:local_uuid');
	});

	it('maps setup calls to anonymous Tracks properties', async () => {
		const telemetryPath = tmp.path('telemetry.json');
		const events: {
			userId: string;
			eventName: string;
			props: Record<string, unknown> | undefined;
		}[] = [];

		const telemetry = await createTelemetry({
			telemetryPath,
			env: {},
			createClient: (userId) => ({
				async trackEvent(eventName, props) {
					events.push({ userId, eventName, props });
				},
			}),
		});

		await telemetry.trackSetup({
			type: 'api',
			env: 'windows',
			auth: 'new_login',
			writeMode: false,
		});

		assert.equal(events.length, 1);
		assert.match(events[0]!.userId, UUID_RE);
		assert.equal(events[0]!.eventName, 'setup_run');
		assert.deepEqual(events[0]!.props, {
			type: 'api',
			env: 'windows',
			auth: 'new_login',
			write_mode: 'disabled',
		});
	});

	it('maps tool calls without note data', async () => {
		const telemetryPath = tmp.path('telemetry.json');
		const events: { eventName: string; props: Record<string, unknown> | undefined }[] =
			[];

		const telemetry = await createTelemetry({
			telemetryPath,
			env: {},
			createClient: () => ({
				async trackEvent(eventName, props) {
					events.push({ eventName, props });
				},
			}),
		});

		await telemetry.trackToolCall({
			tool: 'create_note',
			provider: 'simperium-api',
			success: true,
		});

		assert.deepEqual(events, [
			{
				eventName: 'tool_call',
				props: {
					tool: 'create_note',
					provider: 'simperium-api',
					success: 'true',
				},
			},
		]);
	});

	it('waits for node-tracks event promises before resolving', async () => {
		let resolveSend: (() => void) | undefined;
		const sent: { eventName: string; props: unknown }[] = [];
		const client = _test.createTracksTelemetryClient(
			{
				async trackEvent(eventName, props) {
					sent.push({ eventName, props });
					await new Promise<void>((resolve) => {
						resolveSend = resolve;
					});
				},
			},
			100,
		);

		let resolved = false;
		const pending = client
			.trackEvent('setup', { type: 'api', ignored: undefined })
			.then(() => {
				resolved = true;
			});

		await Promise.resolve();
		assert.equal(resolved, false);
		assert.deepEqual(sent, [{ eventName: 'setup', props: { type: 'api' } }]);

		if (!resolveSend) throw new Error('Expected telemetry send to start');
		resolveSend();
		await pending;
		assert.equal(resolved, true);
	});

	it('stops waiting for node-tracks event promises after the timeout', async () => {
		const client = _test.createTracksTelemetryClient(
			{
				async trackEvent() {
					await new Promise<void>(() => {});
				},
			},
			1,
		);

		await client.trackEvent('setup');
	});

	it('returns a no-op telemetry object when disabled by env var', async () => {
		let clientCalls = 0;
		const telemetryPath = tmp.path('telemetry.json');
		const telemetry = await createTelemetry({
			telemetryPath,
			env: { SIMPLENOTE_MCP_DISABLE_TELEMETRY: '1' },
			createClient: () => {
				clientCalls++;
				throw new Error('createClient should not run');
			},
		});

		await telemetry.trackSetup({ type: 'local', env: 'mac' });
		assert.equal(clientCalls, 0);
		await assert.rejects(
			() => readFile(telemetryPath, 'utf-8'),
			(err: unknown) =>
				(err as NodeJS.ErrnoException).code === 'ENOENT',
		);
	});

	it('returns a no-op telemetry object when disabled in state', async () => {
		const telemetryPath = tmp.path('telemetry.json');
		await disableTelemetry({ telemetryPath });

		let clientCalls = 0;
		const telemetry = await createTelemetry({
			telemetryPath,
			createClient: () => {
				clientCalls++;
				throw new Error('createClient should not run');
			},
		});

		await telemetry.trackToolCall({
			tool: 'list_notes',
			provider: 'native-macos',
			success: true,
		});
		assert.equal(clientCalls, 0);
	});
});

describe('makeTrackedToolHandler', () => {
	it('tracks successful and MCP-error tool results', async () => {
		const calls: Parameters<Telemetry['trackToolCall']>[0][] = [];
		const telemetry: Telemetry = {
			async trackSetup() {},
			async trackToolCall(props) {
				calls.push(props);
			},
		};
		const trackTool = makeTrackedToolHandler(telemetry, () => 'native-macos');

		await trackTool('list_notes', async () => ({ content: [] }));
		await trackTool('get_note', async () => ({ content: [], isError: true }));

		assert.deepEqual(calls, [
			{ tool: 'list_notes', provider: 'native-macos', success: true },
			{ tool: 'get_note', provider: 'native-macos', success: false },
		]);
	});

	it('tracks thrown tool failures and rethrows', async () => {
		const calls: Parameters<Telemetry['trackToolCall']>[0][] = [];
		const telemetry: Telemetry = {
			async trackSetup() {},
			async trackToolCall(props) {
				calls.push(props);
			},
		};
		const trackTool = makeTrackedToolHandler(telemetry, () => 'simperium-api');

		await assert.rejects(
			() =>
				trackTool('search_notes', async () => {
					throw new Error('boom');
				}),
			/boom/,
		);

		assert.deepEqual(calls, [
			{ tool: 'search_notes', provider: 'simperium-api', success: false },
		]);
	});

	it('does not wait for tool telemetry before returning the tool result', async () => {
		let releaseTrack: (() => void) | undefined;
		let finishTrack: (() => void) | undefined;
		const telemetryFinished = new Promise<void>((resolve) => {
			finishTrack = resolve;
		});
		const telemetry: Telemetry = {
			async trackSetup() {},
			async trackToolCall() {
				await new Promise<void>((resolve) => {
					releaseTrack = resolve;
				});
				finishTrack?.();
			},
		};
		const trackTool = makeTrackedToolHandler(telemetry, () => 'native-macos');
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				trackTool('list_notes', async () => 'done'),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error('Tool handler waited for telemetry')),
						100,
					);
				}),
			]);

			assert.equal(result, 'done');
		} finally {
			if (timeout) clearTimeout(timeout);
		}

		if (!releaseTrack) throw new Error('Expected tool telemetry to start');
		releaseTrack();
		await telemetryFinished;
	});
});

describe('telemetry env helpers', () => {
	it('maps platforms to coarse environment values', () => {
		assert.equal(telemetryEnv('darwin'), 'mac');
		assert.equal(telemetryEnv('win32'), 'windows');
		assert.equal(telemetryEnv('linux'), 'linux');
		assert.equal(telemetryEnv('freebsd'), 'linux');
	});

	it('parses the disable env var', () => {
		assert.equal(isTelemetryDisabledByEnv({}), false);
		assert.equal(
			isTelemetryDisabledByEnv({ SIMPLENOTE_MCP_DISABLE_TELEMETRY: '1' }),
			true,
		);
		assert.equal(
			isTelemetryDisabledByEnv({ SIMPLENOTE_MCP_DISABLE_TELEMETRY: 'true' }),
			true,
		);
		assert.equal(
			isTelemetryDisabledByEnv({ SIMPLENOTE_MCP_DISABLE_TELEMETRY: '0' }),
			false,
		);
		assert.equal(
			isTelemetryDisabledByEnv({ SIMPLENOTE_MCP_DISABLE_TELEMETRY: 'false' }),
			false,
		);
	});
});
