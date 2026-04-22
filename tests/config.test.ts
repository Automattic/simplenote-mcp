import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../src/providers/config.ts';

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
