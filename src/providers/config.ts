import { readFile } from 'node:fs/promises';
import { getConfigPath } from './paths.js';

export type Config = { writeMode: boolean };

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
	if (typeof obj.writeMode !== 'boolean') {
		throw new ConfigError(
			'invalid',
			`Config file at ${path} is missing a boolean "writeMode" field.`,
		);
	}
	return { writeMode: obj.writeMode };
}
