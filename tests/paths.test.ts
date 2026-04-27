import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
	getConfigDir,
	getConfigPath,
	getTelemetryPath,
	getTokenPath,
} from '../src/providers/paths.ts';

describe('getConfigDir', () => {
	it('uses Library/Application Support on darwin', () => {
		const dir = getConfigDir({
			platform: 'darwin',
			homedir: '/Users/alice',
			env: {},
		});
		assert.equal(dir, '/Users/alice/Library/Application Support/simplenote-mcp');
	});

	it('honors XDG_CONFIG_HOME on linux', () => {
		const dir = getConfigDir({
			platform: 'linux',
			homedir: '/home/alice',
			env: { XDG_CONFIG_HOME: '/custom/xdg' },
		});
		assert.equal(dir, '/custom/xdg/simplenote-mcp');
	});

	it('falls back to ~/.config on linux without XDG_CONFIG_HOME', () => {
		const dir = getConfigDir({
			platform: 'linux',
			homedir: '/home/alice',
			env: {},
		});
		assert.equal(dir, '/home/alice/.config/simplenote-mcp');
	});

	it('treats whitespace-only XDG_CONFIG_HOME as unset', () => {
		const dir = getConfigDir({
			platform: 'linux',
			homedir: '/home/alice',
			env: { XDG_CONFIG_HOME: '   ' },
		});
		assert.equal(dir, '/home/alice/.config/simplenote-mcp');
	});

	it('honors APPDATA on win32', () => {
		const dir = getConfigDir({
			platform: 'win32',
			homedir: 'C:\\Users\\alice',
			env: { APPDATA: 'C:\\AppData' },
		});
		assert.ok(dir.endsWith('simplenote-mcp'));
		assert.ok(dir.includes('AppData'));
	});

	it('falls back to homedir/AppData/Roaming on win32 without APPDATA', () => {
		const dir = getConfigDir({
			platform: 'win32',
			homedir: 'C:\\Users\\alice',
			env: {},
		});
		assert.ok(dir.includes('AppData'));
		assert.ok(dir.includes('Roaming'));
		assert.ok(dir.endsWith('simplenote-mcp'));
	});
});

describe('getTokenPath', () => {
	it('appends auth.json to the config dir', () => {
		const path = getTokenPath({
			platform: 'darwin',
			homedir: '/Users/alice',
			env: {},
		});
		assert.equal(
			path,
			'/Users/alice/Library/Application Support/simplenote-mcp/auth.json',
		);
	});
});

describe('getConfigPath', () => {
	it('returns the Application Support path on darwin', () => {
		const path = getConfigPath({
			platform: 'darwin',
			homedir: '/Users/alice',
			env: {},
		});
		assert.equal(
			path,
			'/Users/alice/Library/Application Support/simplenote-mcp/config.json',
		);
	});

	it('honors XDG_CONFIG_HOME on linux', () => {
		const path = getConfigPath({
			platform: 'linux',
			homedir: '/home/alice',
			env: { XDG_CONFIG_HOME: '/custom/xdg' },
		});
		assert.equal(path, '/custom/xdg/simplenote-mcp/config.json');
	});

	it('falls back to ~/.config on linux without XDG_CONFIG_HOME', () => {
		const path = getConfigPath({
			platform: 'linux',
			homedir: '/home/alice',
			env: {},
		});
		assert.equal(path, '/home/alice/.config/simplenote-mcp/config.json');
	});

	it('honors APPDATA on win32', () => {
		const path = getConfigPath({
			platform: 'win32',
			homedir: 'C:\\Users\\alice',
			env: { APPDATA: 'C:\\AppData' },
		});
		assert.ok(path.endsWith('simplenote-mcp/config.json') || path.endsWith('simplenote-mcp\\config.json'));
		assert.ok(path.includes('AppData'));
	});

	it('falls back to homedir/AppData/Roaming on win32 without APPDATA', () => {
		const path = getConfigPath({
			platform: 'win32',
			homedir: 'C:\\Users\\alice',
			env: {},
		});
		assert.ok(path.includes('AppData'));
		assert.ok(path.includes('Roaming'));
		assert.ok(path.endsWith('simplenote-mcp/config.json') || path.endsWith('simplenote-mcp\\config.json'));
	});
});

describe('getTelemetryPath', () => {
	it('appends telemetry.json to the config dir', () => {
		const path = getTelemetryPath({
			platform: 'darwin',
			homedir: '/Users/alice',
			env: {},
		});
		assert.equal(
			path,
			'/Users/alice/Library/Application Support/simplenote-mcp/telemetry.json',
		);
	});
});
