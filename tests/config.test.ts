import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig, saveConfig } from '../src/providers/config.ts';

describe('loadConfig', () => {
	let dir: string;
	let configPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'simplenote-mcp-config-test-'));
		configPath = join(dir, 'config.json');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('returns Config from valid JSON', async () => {
		await writeFile(configPath, JSON.stringify({ writeMode: true }));
		const out = await loadConfig({ configPath });
		assert.deepEqual(out, { writeMode: true });
	});

	it("throws ConfigError('missing') when file is absent", async () => {
		await assert.rejects(
			() => loadConfig({ configPath }),
			(err: unknown) => err instanceof ConfigError && err.code === 'missing',
		);
	});

	it("throws ConfigError('invalid') on malformed JSON", async () => {
		await writeFile(configPath, 'not json');
		await assert.rejects(
			() => loadConfig({ configPath }),
			(err: unknown) => err instanceof ConfigError && err.code === 'invalid',
		);
	});

	it("throws ConfigError('invalid') on non-object JSON", async () => {
		await writeFile(configPath, JSON.stringify('scalar'));
		await assert.rejects(
			() => loadConfig({ configPath }),
			(err: unknown) => err instanceof ConfigError && err.code === 'invalid',
		);
	});

	it("throws ConfigError('invalid') when writeMode is missing", async () => {
		await writeFile(configPath, JSON.stringify({}));
		await assert.rejects(
			() => loadConfig({ configPath }),
			(err: unknown) => err instanceof ConfigError && err.code === 'invalid',
		);
	});

	it("throws ConfigError('invalid') when writeMode is non-boolean", async () => {
		await writeFile(configPath, JSON.stringify({ writeMode: 'yes' }));
		await assert.rejects(
			() => loadConfig({ configPath }),
			(err: unknown) => err instanceof ConfigError && err.code === 'invalid',
		);
	});
});

describe('saveConfig', () => {
	let dir: string;
	let configPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'simplenote-mcp-config-test-'));
		configPath = join(dir, 'config.json');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('writes the config as JSON', async () => {
		await saveConfig({ writeMode: true }, { configPath });
		const raw = await readFile(configPath, 'utf-8');
		assert.deepEqual(JSON.parse(raw), { writeMode: true });
	});

	it('creates the parent directory when missing', async () => {
		const nested = join(dir, 'a', 'b', 'c', 'config.json');
		await saveConfig({ writeMode: false }, { configPath: nested });
		const raw = await readFile(nested, 'utf-8');
		assert.deepEqual(JSON.parse(raw), { writeMode: false });
	});

	it('writes with mode 0644', async (t) => {
		if (process.platform === 'win32') {
			t.skip('POSIX permissions are not enforced on Windows');
			return;
		}
		await saveConfig({ writeMode: true }, { configPath });
		const st = await stat(configPath);
		assert.equal(st.mode & 0o777, 0o644);
	});

	it('overwrites an existing file', async () => {
		await saveConfig({ writeMode: true }, { configPath });
		await saveConfig({ writeMode: false }, { configPath });
		const out = await loadConfig({ configPath });
		assert.deepEqual(out, { writeMode: false });
	});

	it('tightens permissions on an existing loose file', async (t) => {
		if (process.platform === 'win32') {
			t.skip('POSIX permissions are not enforced on Windows');
			return;
		}
		await saveConfig({ writeMode: true }, { configPath });
		await chmod(configPath, 0o666);
		await saveConfig({ writeMode: true }, { configPath });
		const st = await stat(configPath);
		assert.equal(st.mode & 0o777, 0o644);
	});
});
