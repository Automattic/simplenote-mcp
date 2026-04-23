import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getConfigPath } from './paths.js';

export type ConfigSource = 'local' | 'api';
export type Config = {
	source: ConfigSource;
	// Only meaningful when source === 'api'. Saved as false for source === 'local'.
	writeMode: boolean;
};

export type ConfigErrorCode = 'missing' | 'invalid';

export class ConfigError extends Error {
	readonly code: ConfigErrorCode;

	constructor(code: ConfigErrorCode, message: string) {
		super(message);
		this.name = 'ConfigError';
		this.code = code;
	}
}

export type LoadConfigOptions = { configPath?: string };

// Schema evolution: unknown fields are ignored, so new optional fields can be
// added in future versions without breaking existing configs. Only add a new
// *required* field if you also handle the loader's 'invalid' branch as a
// migration case for users upgrading from older versions.
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<Config> {
	const path = opts.configPath ?? getConfigPath();
	let raw: string;
	try {
		raw = await readFile(path, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new ConfigError('missing', `Config file not found at ${path}.`);
		}
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ConfigError('invalid', `Config file at ${path} is not valid JSON.`);
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new ConfigError('invalid', `Config file at ${path} is not a JSON object.`);
	}
	const obj = parsed as Record<string, unknown>;
	if (obj.source !== 'local' && obj.source !== 'api') {
		throw new ConfigError(
			'invalid',
			`Config file at ${path} is missing a "source" field of "local" or "api".`,
		);
	}
	if (typeof obj.writeMode !== 'boolean') {
		throw new ConfigError(
			'invalid',
			`Config file at ${path} is missing a boolean "writeMode" field.`,
		);
	}
	return { source: obj.source, writeMode: obj.writeMode };
}

export async function saveConfig(
	config: Config,
	opts: LoadConfigOptions = {},
): Promise<string> {
	const path = opts.configPath ?? getConfigPath();
	await mkdir(dirname(path), { recursive: true });
	const payload = `${JSON.stringify({ source: config.source, writeMode: config.writeMode }, null, 2)}\n`;
	// Write to a temp file, force mode 0644, then atomically rename.
	// writeFile({mode}) only applies on create, so an existing file with
	// looser perms would keep them — chmod guarantees 0644 every save.
	const tmpPath = `${path}.tmp-${process.pid}`;
	try {
		await writeFile(tmpPath, payload, { mode: 0o644 });
		await chmod(tmpPath, 0o644);
		await rename(tmpPath, path);
	} catch (err) {
		try {
			await unlink(tmpPath);
		} catch {
			// tmp file may not exist if writeFile itself failed
		}
		throw err;
	}
	return path;
}
