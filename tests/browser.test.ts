import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { canOpenBrowser, openBrowser } from '../src/browser.ts';

const URL_WITH_QUERY = 'https://app.simplenote.com/login/?source=mcp&x=1';

type SpawnCall = { command: string; args: readonly string[] };

// Fake spawn that records the call and emits `event` on the returned child.
function fakeSpawn(event: 'spawn' | 'error' | 'throw'): {
	spawn: typeof spawn;
	calls: SpawnCall[];
	unrefs: () => number;
} {
	const calls: SpawnCall[] = [];
	let unrefs = 0;
	const impl = (command: string, args: readonly string[]) => {
		calls.push({ command, args });
		if (event === 'throw') throw new Error('EACCES');
		const child = Object.assign(new EventEmitter(), {
			unref: () => {
				unrefs++;
			},
		});
		queueMicrotask(() => {
			if (event === 'error') child.emit('error', new Error('ENOENT'));
			else child.emit('spawn');
		});
		return child;
	};
	return { spawn: impl as unknown as typeof spawn, calls, unrefs: () => unrefs };
}

describe('canOpenBrowser', () => {
	it('allows macOS and Windows desktops', () => {
		assert.equal(canOpenBrowser('darwin', {}), true);
		assert.equal(canOpenBrowser('win32', {}), true);
	});

	it('requires a display on Linux', () => {
		assert.equal(canOpenBrowser('linux', {}), false);
		assert.equal(canOpenBrowser('linux', { DISPLAY: ':0' }), true);
		assert.equal(canOpenBrowser('linux', { WAYLAND_DISPLAY: 'wayland-0' }), true);
	});

	it('refuses over SSH', () => {
		for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
			assert.equal(canOpenBrowser('darwin', { [key]: 'x' }), false, key);
			assert.equal(canOpenBrowser('linux', { DISPLAY: ':0', [key]: 'x' }), false, key);
		}
	});
});

describe('openBrowser', () => {
	it('uses `open` on macOS and unrefs the child', async () => {
		const fake = fakeSpawn('spawn');
		const ok = await openBrowser(URL_WITH_QUERY, {
			platform: () => 'darwin',
			env: {},
			spawn: fake.spawn,
		});
		assert.equal(ok, true);
		assert.deepEqual(fake.calls, [{ command: 'open', args: [URL_WITH_QUERY] }]);
		assert.equal(fake.unrefs(), 1);
	});

	it('uses rundll32 on Windows so `&` in the URL survives', async () => {
		const fake = fakeSpawn('spawn');
		await openBrowser(URL_WITH_QUERY, {
			platform: () => 'win32',
			env: {},
			spawn: fake.spawn,
		});
		assert.deepEqual(fake.calls, [
			{ command: 'rundll32', args: ['url.dll,FileProtocolHandler', URL_WITH_QUERY] },
		]);
	});

	it('uses xdg-open on Linux with a display', async () => {
		const fake = fakeSpawn('spawn');
		await openBrowser(URL_WITH_QUERY, {
			platform: () => 'linux',
			env: { DISPLAY: ':0' },
			spawn: fake.spawn,
		});
		assert.deepEqual(fake.calls, [{ command: 'xdg-open', args: [URL_WITH_QUERY] }]);
	});

	it('does not spawn when headless', async () => {
		const fake = fakeSpawn('spawn');
		const ok = await openBrowser(URL_WITH_QUERY, {
			platform: () => 'darwin',
			env: { SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22' },
			spawn: fake.spawn,
		});
		assert.equal(ok, false);
		assert.equal(fake.calls.length, 0);
	});

	it('returns false when the opener is missing', async () => {
		const ok = await openBrowser(URL_WITH_QUERY, {
			platform: () => 'linux',
			env: { DISPLAY: ':0' },
			spawn: fakeSpawn('error').spawn,
		});
		assert.equal(ok, false);
	});

	it('returns false when spawn throws synchronously', async () => {
		const ok = await openBrowser(URL_WITH_QUERY, {
			platform: () => 'darwin',
			env: {},
			spawn: fakeSpawn('throw').spawn,
		});
		assert.equal(ok, false);
	});
});
