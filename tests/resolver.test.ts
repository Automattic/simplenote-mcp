import { afterEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { ConfigError, type Config } from '../src/providers/config.ts';
import type { Provider } from '../src/providers/normalize.ts';
import { resolveProvider, type ResolveDeps } from '../src/providers/resolver.ts';
import { captureConsole } from './helpers.ts';

afterEach(() => {
	mock.restoreAll();
});

// Stubs mirror the real Provider shape. The API stub includes write methods
// so tests can verify that writeMode=false strips them off the returned
// provider; the native stub has no write methods since the real one doesn't
// either.
const NATIVE: Provider = {
	name: 'native-macos',
	description: 'test-native',
	loadStore: async () => ({ notes: [], tags: [] }),
};
const API: Provider = {
	name: 'simperium-api',
	description: 'test-api',
	loadStore: async () => ({ notes: [], tags: [] }),
	createNote: async () => ({ id: 'stub-id', version: 1 }),
	updateNote: async () => ({ id: 'stub-id', version: 2 }),
	trashNote: async (id: string) => ({
		id,
		content: '',
		tags: [],
		pinned: false,
		markdown: false,
		deleted: true,
		created: null,
		modified: null,
	}),
	restoreNote: async (id: string) => ({
		id,
		content: '',
		tags: [],
		pinned: false,
		markdown: false,
		deleted: false,
		created: null,
		modified: null,
	}),
};

type Stubs = {
	nativeCalls: string[];
	apiCalls: number;
	tokenLoads: number;
	configLoads: number;
};

function makeDeps(
	overrides: {
		fileExists?: (path: string) => boolean;
		loadToken?: () => Promise<{ username: string | null; token: string } | null>;
		loadConfig?: () => Promise<Config>;
		nativeStorePath?: string;
	} = {},
): { deps: ResolveDeps; stubs: Stubs } {
	const stubs: Stubs = {
		nativeCalls: [],
		apiCalls: 0,
		tokenLoads: 0,
		configLoads: 0,
	};
	const baseLoadToken = overrides.loadToken ?? (async () => null);
	const baseLoadConfig =
		overrides.loadConfig ?? (async () => ({ source: 'api' as const, writeMode: false }));
	const deps: ResolveDeps = {
		fileExists: overrides.fileExists ?? (() => false),
		loadToken: async () => {
			stubs.tokenLoads++;
			return baseLoadToken();
		},
		loadConfig: async () => {
			stubs.configLoads++;
			return baseLoadConfig();
		},
		nativeStorePath: overrides.nativeStorePath ?? '/fake/native/store.storedata',
		makeNative: (path: string) => {
			stubs.nativeCalls.push(path);
			return NATIVE;
		},
		makeApi: () => {
			stubs.apiCalls++;
			return API;
		},
	};
	return { deps, stubs };
}

// ---------- A. Missing / invalid config ----------

describe('resolveProvider — missing / invalid config', () => {
	it('rejects with a setup hint when config is missing', async () => {
		const { deps } = makeDeps({
			loadConfig: async () => {
				throw new ConfigError('missing', 'not here');
			},
		});
		await assert.rejects(
			() => resolveProvider({}, deps),
			(err: unknown) =>
				err instanceof Error && /simplenote-mcp setup/.test(err.message),
		);
	});

	it('rejects with a "malformed" hint when config is invalid', async () => {
		const { deps } = makeDeps({
			loadConfig: async () => {
				throw new ConfigError('invalid', 'bad json');
			},
		});
		await assert.rejects(
			() => resolveProvider({}, deps),
			(err: unknown) =>
				err instanceof Error &&
				/malformed/.test(err.message) &&
				/simplenote-mcp setup/.test(err.message) &&
				!/delete/i.test(err.message),
		);
	});
});

// ---------- B. source=local ----------

describe('resolveProvider — source=local', () => {
	it('returns native when the default store exists', async () => {
		const nativePath = '/fake/native/store.storedata';
		const { deps, stubs } = makeDeps({
			fileExists: (p) => p === nativePath,
			loadConfig: async () => ({ source: 'local', writeMode: false }),
			nativeStorePath: nativePath,
		});
		const provider = await resolveProvider({}, deps);
		assert.equal(provider, NATIVE);
		assert.deepEqual(stubs.nativeCalls, [nativePath]);
		assert.equal(stubs.apiCalls, 0);
		// source=local is a user choice, not platform-driven — no token lookup.
		assert.equal(stubs.tokenLoads, 0);
	});

	it('rejects with a setup hint when the store is missing', async () => {
		const { deps } = makeDeps({
			fileExists: () => false,
			loadConfig: async () => ({ source: 'local', writeMode: false }),
		});
		await assert.rejects(
			() => resolveProvider({}, deps),
			(err: unknown) =>
				err instanceof Error &&
				/Local Simplenote database not found/.test(err.message) &&
				/simplenote-mcp setup/.test(err.message),
		);
	});
});

// ---------- C. source=api + writeMode=true ----------

describe('resolveProvider — source=api + writeMode=true', () => {
	it('returns the API provider with write methods when a token exists', async () => {
		const { deps, stubs } = makeDeps({
			// Even if a native store file happens to exist, source=api should
			// force the API provider.
			fileExists: () => true,
			loadConfig: async () => ({ source: 'api', writeMode: true }),
			loadToken: async () => ({ username: 'a@b.com', token: 'tok' }),
		});
		const provider = await resolveProvider({}, deps);
		assert.equal(provider.name, 'simperium-api');
		assert.equal(typeof provider.createNote, 'function');
		assert.equal(typeof provider.updateNote, 'function');
		assert.equal(typeof provider.trashNote, 'function');
		assert.equal(typeof provider.restoreNote, 'function');
		assert.equal(stubs.apiCalls, 1);
		assert.equal(stubs.nativeCalls.length, 0);
	});

	it('rejects with a setup hint when no token is present', async () => {
		const { deps } = makeDeps({
			loadConfig: async () => ({ source: 'api', writeMode: true }),
			loadToken: async () => null,
		});
		await assert.rejects(
			() => resolveProvider({}, deps),
			(err: unknown) =>
				err instanceof Error &&
				/write-mode is enabled/i.test(err.message) &&
				/simplenote-mcp setup/.test(err.message),
		);
	});
});

// ---------- D. source=api + writeMode=false ----------

describe('resolveProvider — source=api + writeMode=false', () => {
	it('returns the API provider when a token exists', async () => {
		const { deps, stubs } = makeDeps({
			// A native store file on disk should be ignored when source=api.
			fileExists: () => true,
			loadConfig: async () => ({ source: 'api', writeMode: false }),
			loadToken: async () => ({ username: 'a@b.com', token: 'tok' }),
		});
		const provider = await resolveProvider({}, deps);
		assert.equal(provider.name, 'simperium-api');
		assert.equal(stubs.apiCalls, 1);
		assert.equal(stubs.nativeCalls.length, 0);
	});

	it('strips createNote, updateNote, trashNote, and restoreNote from the provider (read-only)', async () => {
		const { deps } = makeDeps({
			loadConfig: async () => ({ source: 'api', writeMode: false }),
			loadToken: async () => ({ username: 'a@b.com', token: 'tok' }),
		});
		const provider = await resolveProvider({}, deps);
		assert.equal(
			provider.createNote,
			undefined,
			'createNote must not be exposed in read-only mode',
		);
		assert.equal(
			provider.updateNote,
			undefined,
			'updateNote must not be exposed in read-only mode',
		);
		assert.equal(
			provider.trashNote,
			undefined,
			'trashNote must not be exposed in read-only mode',
		);
		assert.equal(
			provider.restoreNote,
			undefined,
			'restoreNote must not be exposed in read-only mode',
		);
	});

	it('rejects with a setup hint when no token is present', async () => {
		const { deps } = makeDeps({
			loadConfig: async () => ({ source: 'api', writeMode: false }),
			loadToken: async () => null,
		});
		await assert.rejects(
			() => resolveProvider({}, deps),
			(err: unknown) =>
				err instanceof Error &&
				/No auth token/.test(err.message) &&
				/simplenote-mcp setup/.test(err.message),
		);
	});
});

// ---------- D. --path overrides ----------

describe('resolveProvider — --path overrides', () => {
	it('warns on stderr when --path coincides with source=api + writeMode=true', async () => {
		const { deps, stubs } = makeDeps({
			fileExists: () => true,
			loadConfig: async () => ({ source: 'api', writeMode: true }),
			loadToken: async () => {
				throw new Error('loadToken should not be called when --path is used');
			},
		});
		const { lines, restore } = captureConsole('error');
		let provider: Provider;
		try {
			provider = await resolveProvider({ explicitPath: '/some/store.storedata' }, deps);
		} finally {
			restore();
		}
		assert.equal(provider, NATIVE);
		assert.deepEqual(stubs.nativeCalls, ['/some/store.storedata']);
		assert.equal(stubs.apiCalls, 0);
		assert.equal(stubs.configLoads, 1);
		assert.ok(
			lines.some((l) => /--path overrides write-mode/i.test(l)),
			`expected stderr to mention "--path overrides write-mode"; got:\n${lines.join('\n')}`,
		);
	});

	it('does not warn on stderr when --path coincides with source=api + writeMode=false', async () => {
		const { deps } = makeDeps({
			fileExists: () => true,
			loadConfig: async () => ({ source: 'api', writeMode: false }),
		});
		const { lines, restore } = captureConsole('error');
		let provider: Provider;
		try {
			provider = await resolveProvider({ explicitPath: '/some/store.storedata' }, deps);
		} finally {
			restore();
		}
		assert.equal(provider, NATIVE);
		assert.equal(lines.length, 0);
	});

	it('does not rethrow when --path is present and loadConfig throws missing', async () => {
		const { deps, stubs } = makeDeps({
			fileExists: () => true,
			loadConfig: async () => {
				throw new ConfigError('missing', 'not here');
			},
		});
		const { lines, restore } = captureConsole('error');
		let provider: Provider;
		try {
			provider = await resolveProvider({ explicitPath: '/some/store.storedata' }, deps);
		} finally {
			restore();
		}
		assert.equal(provider, NATIVE);
		assert.deepEqual(stubs.nativeCalls, ['/some/store.storedata']);
		assert.equal(lines.length, 0);
	});

	it('still errors when --path points to a nonexistent file', async () => {
		const { deps } = makeDeps({
			fileExists: () => false,
			loadConfig: async () => ({ source: 'api', writeMode: true }),
		});
		await assert.rejects(
			() => resolveProvider({ explicitPath: '/missing/store.storedata' }, deps),
			(err: unknown) =>
				err instanceof Error && /Simplenote store not found/.test(err.message),
		);
	});
});
