import { afterEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { ConfigError, type Config } from '../src/providers/config.ts';
import type { Provider } from '../src/providers/normalize.ts';
import { resolveProvider, type ResolveDeps } from '../src/providers/resolver.ts';

afterEach(() => {
	mock.restoreAll();
});

// A distinct tag on each stub provider lets tests assert *which* provider was
// returned without caring about its internals.
const NATIVE = { kind: 'native-stub' } as unknown as Provider;
const API = { kind: 'api-stub' } as unknown as Provider;

type Stubs = {
	nativeCalls: string[];
	apiCalls: number;
	tokenLoads: number;
	configLoads: number;
};

function makeDeps(
	overrides: {
		platform?: NodeJS.Platform;
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
	const baseLoadConfig = overrides.loadConfig ?? (async () => ({ writeMode: false }));
	const deps: ResolveDeps = {
		platform: () => overrides.platform ?? 'linux',
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
			(err: unknown) => err instanceof Error && /malformed/.test(err.message),
		);
	});
});

// ---------- B. writeMode=true ----------

describe('resolveProvider — writeMode=true', () => {
	it('returns the API provider when a token exists', async () => {
		const { deps, stubs } = makeDeps({
			platform: 'darwin',
			// Even if a native store file happens to exist, writeMode=true should
			// force the API provider.
			fileExists: () => true,
			loadConfig: async () => ({ writeMode: true }),
			loadToken: async () => ({ username: 'a@b.com', token: 'tok' }),
		});
		const provider = await resolveProvider({}, deps);
		assert.equal(provider, API);
		assert.equal(stubs.apiCalls, 1);
		assert.equal(stubs.nativeCalls.length, 0);
	});

	it('rejects with a setup hint when no token is present', async () => {
		const { deps } = makeDeps({
			loadConfig: async () => ({ writeMode: true }),
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

// ---------- C. writeMode=false + platform fallback ----------

describe('resolveProvider — writeMode=false fallbacks', () => {
	it('returns native on darwin when the default store exists', async () => {
		const nativePath = '/fake/native/store.storedata';
		const { deps, stubs } = makeDeps({
			platform: 'darwin',
			fileExists: (p) => p === nativePath,
			loadConfig: async () => ({ writeMode: false }),
			nativeStorePath: nativePath,
		});
		const provider = await resolveProvider({}, deps);
		assert.equal(provider, NATIVE);
		assert.deepEqual(stubs.nativeCalls, [nativePath]);
		assert.equal(stubs.apiCalls, 0);
	});

	it('falls back to API on linux with no native store when a token exists', async () => {
		const { deps, stubs } = makeDeps({
			platform: 'linux',
			fileExists: () => false,
			loadConfig: async () => ({ writeMode: false }),
			loadToken: async () => ({ username: 'a@b.com', token: 'tok' }),
		});
		const provider = await resolveProvider({}, deps);
		assert.equal(provider, API);
		assert.equal(stubs.apiCalls, 1);
	});

	it('rejects with a setup hint on linux with no store and no token', async () => {
		const { deps } = makeDeps({
			platform: 'linux',
			fileExists: () => false,
			loadConfig: async () => ({ writeMode: false }),
			loadToken: async () => null,
		});
		await assert.rejects(
			() => resolveProvider({}, deps),
			(err: unknown) =>
				err instanceof Error &&
				/No data source available/.test(err.message) &&
				/simplenote-mcp setup/.test(err.message),
		);
	});

	it('falls back to API on darwin with no native store but a token present', async () => {
		// Covers the "Mac user without the desktop app" case: writeMode=false,
		// native store missing, token in place → API (read-only).
		const { deps, stubs } = makeDeps({
			platform: 'darwin',
			fileExists: () => false,
			loadConfig: async () => ({ writeMode: false }),
			loadToken: async () => ({ username: 'a@b.com', token: 'tok' }),
		});
		const provider = await resolveProvider({}, deps);
		assert.equal(provider, API);
		assert.equal(stubs.apiCalls, 1);
	});
});

// ---------- D. --path overrides ----------

function captureStderr(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const restore = mock.method(console, 'error', (msg: unknown) => {
		lines.push(String(msg));
	});
	return { lines, restore: () => restore.mock.restore() };
}

describe('resolveProvider — --path overrides', () => {
	it('warns on stderr when --path coincides with writeMode=true', async () => {
		const { deps, stubs } = makeDeps({
			fileExists: () => true,
			loadConfig: async () => ({ writeMode: true }),
			loadToken: async () => {
				throw new Error('loadToken should not be called when --path is used');
			},
		});
		const { lines, restore } = captureStderr();
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

	it('does not warn on stderr when --path coincides with writeMode=false', async () => {
		const { deps } = makeDeps({
			fileExists: () => true,
			loadConfig: async () => ({ writeMode: false }),
		});
		const { lines, restore } = captureStderr();
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
		const { lines, restore } = captureStderr();
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
			loadConfig: async () => ({ writeMode: true }),
		});
		await assert.rejects(
			() => resolveProvider({ explicitPath: '/missing/store.storedata' }, deps),
			(err: unknown) =>
				err instanceof Error && /Simplenote store not found/.test(err.message),
		);
	});
});
