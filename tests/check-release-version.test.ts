import { afterEach, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import {
	fetchRegistryState,
	main,
	highestVersion,
	nextVersions,
	planRelease,
	ReleaseCheckError,
	type RegistryState,
	type ReleaseFiles,
} from '../scripts/check-release-version.ts';
import { mockFetch, useTmpDir } from './helpers/general.ts';

function filesAt(version: string, overrides: Partial<Record<'lockRoot' | 'server' | 'serverPackage', string>> = {}): ReleaseFiles {
	return {
		packageJson: { name: '@automattic/simplenote-mcp', version },
		packageLock: { version, packages: { '': { version: overrides.lockRoot ?? version } } },
		serverJson: {
			version: overrides.server ?? version,
			packages: [{ version: overrides.serverPackage ?? version }],
		},
	};
}

const REGISTRY: RegistryState = {
	latest: '2.0.1',
	versions: { '2.0.0': { gitHead: 'aaa' }, '2.0.1': { gitHead: 'bbb' } },
	taken: ['2.0.0', '2.0.1'],
};

function plan(version: string, options: { registry?: RegistryState; files?: ReleaseFiles } = {}) {
	return planRelease({
		files: options.files ?? filesAt(version),
		registry: options.registry ?? REGISTRY,
		sha: 'cafe',
	});
}

describe('nextVersions', () => {
	it('returns the next patch, minor, and major', () => {
		assert.deepEqual(nextVersions('2.0.1'), ['2.0.2', '2.1.0', '3.0.0']);
	});
});

describe('highestVersion', () => {
	it('compares numerically and ignores prereleases', () => {
		assert.equal(highestVersion(['2.0.9', '2.0.10', '3.0.0-beta.1', '1.9.9']), '2.0.10');
	});
});

describe('planRelease', () => {
	for (const version of ['2.0.2', '2.1.0', '3.0.0']) {
		it(`accepts ${version} after 2.0.1`, () => {
			assert.deepEqual(plan(version), { version, alreadyPublished: false, target: 'cafe' });
		});
	}

	for (const version of ['2.0.3', '2.0.10', '2.2.0', '4.0.0', '1.9.9']) {
		it(`rejects ${version} after 2.0.1`, () => {
			assert.throws(() => plan(version), ReleaseCheckError);
		});
	}

	it('rejects prerelease versions', () => {
		assert.throws(() => plan('2.0.2-beta.1'), /prereleases are not supported/);
	});

	it('reports every mismatched version field', () => {
		assert.throws(
			() => plan('2.0.2', { files: filesAt('2.0.2', { lockRoot: '2.0.1', serverPackage: '2.0.1' }) }),
			(error: unknown) => {
				assert.ok(error instanceof ReleaseCheckError);
				assert.match(error.message, /package-lock\.json packages\[""\]\.version: "2\.0\.1"/);
				assert.match(error.message, /server\.json packages\[0\]\.version: "2\.0\.1"/);
				return true;
			},
		);
	});

	it('treats an already-published version as a re-run targeting its npm gitHead', () => {
		assert.deepEqual(plan('2.0.1'), { version: '2.0.1', alreadyPublished: true, target: 'bbb' });
	});

	it('rejects older-major fixes, which are not supported yet', () => {
		const registry: RegistryState = {
			latest: '3.0.0',
			versions: { '2.1.0': {}, '3.0.0': {} },
			taken: ['2.1.0', '3.0.0'],
		};
		assert.throws(() => plan('2.1.1', { registry }), /older major version is not supported/);
	});

	it('rejects reusing an unpublished version', () => {
		const registry: RegistryState = { ...REGISTRY, taken: [...REGISTRY.taken, '2.0.2'] };
		assert.throws(() => plan('2.0.2', { registry }), /unpublished; npm does not allow reusing it/);
	});

	it('counts unpublished versions when finding the next release', () => {
		const registry: RegistryState = { ...REGISTRY, taken: [...REGISTRY.taken, '2.0.2'] };
		assert.equal(plan('2.0.3', { registry }).version, '2.0.3');
	});

	it('accepts any version for a package that has never been published', () => {
		assert.equal(plan('5.0.0', { registry: { versions: {}, taken: [] } }).alreadyPublished, false);
	});
});

describe('fetchRegistryState', () => {
	afterEach(() => mock.restoreAll());

	it('reads latest, versions, and unpublished versions from the packument, encoding the name', async () => {
		let requested = '';
		mockFetch((url) => {
			requested = url;
			return Response.json({
				'dist-tags': { latest: '2.0.1' },
				versions: { '2.0.1': { gitHead: 'bbb' } },
				time: { created: 't', modified: 't', '2.0.0': 't', '2.0.1': 't' },
			});
		});
		const state = await fetchRegistryState('@automattic/simplenote-mcp', 'https://registry.example/');
		assert.equal(requested, 'https://registry.example/%40automattic%2Fsimplenote-mcp');
		assert.deepEqual(state, {
			latest: '2.0.1',
			versions: { '2.0.1': { gitHead: 'bbb' } },
			taken: ['2.0.1', '2.0.0'],
		});
	});

	it('encodes every URL-significant character in the name, not just the first slash', async () => {
		let requested = '';
		mockFetch((url) => {
			requested = url;
			return Response.json({});
		});
		await fetchRegistryState('a/b/c?d#e', 'https://registry.example');
		assert.equal(requested, 'https://registry.example/a%2Fb%2Fc%3Fd%23e');
	});

	it('treats 404 as never published', async () => {
		mockFetch(() => new Response('not found', { status: 404 }));
		assert.deepEqual(await fetchRegistryState('@automattic/simplenote-mcp'), { versions: {}, taken: [] });
	});

	it('surfaces other registry failures', async () => {
		mockFetch(() => new Response('boom', { status: 503 }));
		await assert.rejects(fetchRegistryState('@automattic/simplenote-mcp'), /503/);
	});
});

describe('main', () => {
	const tmp = useTmpDir();
	afterEach(() => mock.restoreAll());

	it('writes GitHub Actions outputs', async () => {
		const files = filesAt('2.0.2');
		await writeFile(tmp.path('package.json'), JSON.stringify(files.packageJson));
		await writeFile(tmp.path('package-lock.json'), JSON.stringify(files.packageLock));
		await writeFile(tmp.path('server.json'), JSON.stringify(files.serverJson));
		await writeFile(tmp.path('output'), '');
		mockFetch(() => Response.json({ 'dist-tags': { latest: '2.0.1' }, versions: {} }));
		mock.method(console, 'log', () => {});

		await main({ GITHUB_OUTPUT: tmp.path('output'), GITHUB_SHA: 'cafe' }, tmp.dir);

		assert.equal(await readFile(tmp.path('output'), 'utf8'), 'version=2.0.2\npublished=false\ntarget=cafe\n');
	});
});
