import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, loadConfig, saveConfig } from '../src/providers/config.ts';
import { useTmpDir } from './helpers.ts';

describe('loadConfig', () => {
	const tmp = useTmpDir('simplenote-mcp-config-test-');

	it('returns Config from valid JSON (source=api)', async () => {
		const configPath = tmp.path('config.json');
		await writeFile(
			configPath,
			JSON.stringify({ source: 'api', writeMode: true }),
		);
		const out = await loadConfig({ configPath });
		assert.deepEqual(out, { source: 'api', writeMode: true });
	});

	it('returns Config from valid JSON (source=local)', async () => {
		const configPath = tmp.path('config.json');
		await writeFile(
			configPath,
			JSON.stringify({ source: 'local', writeMode: false }),
		);
		const out = await loadConfig({ configPath });
		assert.deepEqual(out, { source: 'local', writeMode: false });
	});

	it("throws ConfigError('missing') when file is absent", async () => {
		await assert.rejects(
			() => loadConfig({ configPath: tmp.path('config.json') }),
			(err: unknown) => err instanceof ConfigError && err.code === 'missing',
		);
	});

	it("throws ConfigError('invalid') on malformed JSON", async () => {
		const configPath = tmp.path('config.json');
		await writeFile(configPath, 'not json');
		await assert.rejects(
			() => loadConfig({ configPath }),
			(err: unknown) => err instanceof ConfigError && err.code === 'invalid',
		);
	});

	it("throws ConfigError('invalid') on non-object JSON", async () => {
		const configPath = tmp.path('config.json');
		await writeFile(configPath, JSON.stringify('scalar'));
		await assert.rejects(
			() => loadConfig({ configPath }),
			(err: unknown) => err instanceof ConfigError && err.code === 'invalid',
		);
	});

	it("throws ConfigError('invalid') when writeMode is missing", async () => {
		const configPath = tmp.path('config.json');
		await writeFile(configPath, JSON.stringify({ source: 'api' }));
		await assert.rejects(
			() => loadConfig({ configPath }),
			(err: unknown) => err instanceof ConfigError && err.code === 'invalid',
		);
	});

	it("throws ConfigError('invalid') when writeMode is non-boolean", async () => {
		const configPath = tmp.path('config.json');
		await writeFile(
			configPath,
			JSON.stringify({ source: 'api', writeMode: 'yes' }),
		);
		await assert.rejects(
			() => loadConfig({ configPath }),
			(err: unknown) => err instanceof ConfigError && err.code === 'invalid',
		);
	});

	it("throws ConfigError('invalid') when source is missing", async () => {
		const configPath = tmp.path('config.json');
		await writeFile(configPath, JSON.stringify({ writeMode: false }));
		await assert.rejects(
			() => loadConfig({ configPath }),
			(err: unknown) => err instanceof ConfigError && err.code === 'invalid',
		);
	});

	it("throws ConfigError('invalid') when source is not 'local' or 'api'", async () => {
		const configPath = tmp.path('config.json');
		await writeFile(
			configPath,
			JSON.stringify({ source: 'other', writeMode: false }),
		);
		await assert.rejects(
			() => loadConfig({ configPath }),
			(err: unknown) => err instanceof ConfigError && err.code === 'invalid',
		);
	});
});

describe('saveConfig', () => {
	const tmp = useTmpDir('simplenote-mcp-config-test-');

	it('writes the config as JSON', async () => {
		const configPath = tmp.path('config.json');
		await saveConfig({ source: 'api', writeMode: true }, { configPath });
		const raw = await readFile(configPath, 'utf-8');
		assert.deepEqual(JSON.parse(raw), { source: 'api', writeMode: true });
	});

	it('persists source=local', async () => {
		const configPath = tmp.path('config.json');
		await saveConfig({ source: 'local', writeMode: false }, { configPath });
		const raw = await readFile(configPath, 'utf-8');
		assert.deepEqual(JSON.parse(raw), { source: 'local', writeMode: false });
	});

	it('creates the parent directory when missing', async () => {
		const nested = join(tmp.dir, 'a', 'b', 'c', 'config.json');
		await saveConfig(
			{ source: 'api', writeMode: false },
			{ configPath: nested },
		);
		const raw = await readFile(nested, 'utf-8');
		assert.deepEqual(JSON.parse(raw), { source: 'api', writeMode: false });
	});

	it('writes with mode 0644', async (t) => {
		if (process.platform === 'win32') {
			t.skip('POSIX permissions are not enforced on Windows');
			return;
		}
		const configPath = tmp.path('config.json');
		await saveConfig({ source: 'api', writeMode: true }, { configPath });
		const st = await stat(configPath);
		assert.equal(st.mode & 0o777, 0o644);
	});

	it('overwrites an existing file', async () => {
		const configPath = tmp.path('config.json');
		await saveConfig({ source: 'api', writeMode: true }, { configPath });
		await saveConfig({ source: 'api', writeMode: false }, { configPath });
		const out = await loadConfig({ configPath });
		assert.deepEqual(out, { source: 'api', writeMode: false });
	});

	it('tightens permissions on an existing loose file', async (t) => {
		if (process.platform === 'win32') {
			t.skip('POSIX permissions are not enforced on Windows');
			return;
		}
		const configPath = tmp.path('config.json');
		await saveConfig({ source: 'api', writeMode: true }, { configPath });
		await chmod(configPath, 0o666);
		await saveConfig({ source: 'api', writeMode: true }, { configPath });
		const st = await stat(configPath);
		assert.equal(st.mode & 0o777, 0o644);
	});
});
