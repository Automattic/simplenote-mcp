// Release gate run by .github/workflows/release.yml (and locally by the
// release-pr skill). Confirms every version field in the repo agrees, and that
// the version is the next patch/minor/major after npm's `latest` unless the
// increment check is explicitly skipped. A version that is already on npm is
// accepted so a partially failed release can be re-run to completion.
//
// Usage: node --import tsx scripts/check-release-version.ts
// Env: SKIP_INCREMENT_CHECK=true, NPM_REGISTRY (default registry.npmjs.org),
//      GITHUB_SHA, GITHUB_OUTPUT (both set by GitHub Actions).

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Json = Record<string, unknown>;

export interface ReleaseFiles {
	packageJson: Json;
	packageLock: Json;
	serverJson: Json;
}

export interface RegistryState {
	latest?: string;
	versions: Record<string, { gitHead?: string }>;
}

export interface ReleasePlan {
	version: string;
	alreadyPublished: boolean;
	// Commit to tag/release: the commit npm recorded for an already-published
	// version, otherwise the commit this run is on.
	target: string;
}

export class ReleaseCheckError extends Error {
	constructor(readonly problems: string[]) {
		super(problems.join('\n'));
	}
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(version: string): [number, number, number] | null {
	const match = SEMVER.exec(version);
	if (!match) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function nextVersions(latest: string): string[] {
	const parsed = parseVersion(latest);
	if (!parsed) {
		throw new ReleaseCheckError([`npm latest "${latest}" is not a plain x.y.z version`]);
	}
	const [major, minor, patch] = parsed;
	return [`${major}.${minor}.${patch + 1}`, `${major}.${minor + 1}.0`, `${major + 1}.0.0`];
}

function isGreater(a: [number, number, number], b: [number, number, number]): boolean {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) {
			return a[i]! > b[i]!;
		}
	}
	return false;
}

function get(obj: unknown, path: (string | number)[]): unknown {
	let current = obj;
	for (const key of path) {
		if (current === null || typeof current !== 'object') {
			return undefined;
		}
		current = (current as Record<string | number, unknown>)[key];
	}
	return current;
}

export function collectVersions(files: ReleaseFiles): Record<string, unknown> {
	return {
		'package.json version': files.packageJson.version,
		'package-lock.json version': files.packageLock.version,
		'package-lock.json packages[""].version': get(files.packageLock, ['packages', '', 'version']),
		'server.json version': files.serverJson.version,
		'server.json packages[0].version': get(files.serverJson, ['packages', 0, 'version']),
	};
}

export function planRelease(options: {
	files: ReleaseFiles;
	registry: RegistryState;
	skipIncrementCheck: boolean;
	sha: string;
}): ReleasePlan {
	const fields = collectVersions(options.files);
	const values = new Set(Object.values(fields));
	const version = fields['package.json version'];
	if (values.size !== 1 || typeof version !== 'string') {
		throw new ReleaseCheckError([
			'Version fields do not match:',
			...Object.entries(fields).map(([field, value]) => `  ${field}: ${JSON.stringify(value)}`),
		]);
	}
	const parsed = parseVersion(version);
	if (!parsed) {
		throw new ReleaseCheckError([`Version "${version}" is not a plain x.y.z version (prereleases are not supported)`]);
	}

	const published = options.registry.versions[version];
	if (published) {
		return { version, alreadyPublished: true, target: published.gitHead || options.sha };
	}

	const { latest } = options.registry;
	if (latest) {
		if (!options.skipIncrementCheck) {
			const allowed = nextVersions(latest);
			if (!allowed.includes(version)) {
				throw new ReleaseCheckError([
					`Version ${version} is not the next release after npm latest ${latest}.`,
					`Expected one of: ${allowed.join(', ')}.`,
					'Re-run with skip_increment_check if this jump is intentional.',
				]);
			}
		} else {
			const latestParsed = parseVersion(latest);
			if (latestParsed && !isGreater(parsed, latestParsed)) {
				throw new ReleaseCheckError([
					`Version ${version} is not greater than npm latest ${latest}; publishing it would move the latest tag backwards.`,
				]);
			}
		}
	}

	return { version, alreadyPublished: false, target: options.sha };
}

export async function fetchRegistryState(
	name: string,
	registry = 'https://registry.npmjs.org',
): Promise<RegistryState> {
	const url = `${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}`;
	const response = await fetch(url, { headers: { accept: 'application/json' } });
	if (response.status === 404) {
		return { versions: {} };
	}
	if (!response.ok) {
		throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
	}
	const body = (await response.json()) as {
		'dist-tags'?: { latest?: string };
		versions?: Record<string, { gitHead?: string }>;
	};
	return { latest: body['dist-tags']?.latest, versions: body.versions ?? {} };
}

export async function readReleaseFiles(dir: string): Promise<ReleaseFiles> {
	const read = async (name: string): Promise<Json> =>
		JSON.parse(await readFile(join(dir, name), 'utf8')) as Json;
	return {
		packageJson: await read('package.json'),
		packageLock: await read('package-lock.json'),
		serverJson: await read('server.json'),
	};
}

export async function main(env: NodeJS.ProcessEnv = process.env, dir = process.cwd()): Promise<ReleasePlan> {
	const files = await readReleaseFiles(dir);
	const name = files.packageJson.name;
	if (typeof name !== 'string') {
		throw new ReleaseCheckError(['package.json has no name']);
	}
	const registry = await fetchRegistryState(name, env.NPM_REGISTRY);
	const plan = planRelease({
		files,
		registry,
		skipIncrementCheck: env.SKIP_INCREMENT_CHECK === 'true',
		sha: env.GITHUB_SHA ?? 'HEAD',
	});

	console.log(
		plan.alreadyPublished
			? `${name}@${plan.version} is already on npm; remaining release steps will run for ${plan.target}.`
			: `${name}@${plan.version} is ready to publish (npm latest: ${registry.latest ?? 'none'}).`,
	);
	if (env.GITHUB_OUTPUT) {
		await appendFile(
			env.GITHUB_OUTPUT,
			`version=${plan.version}\npublished=${plan.alreadyPublished}\ntarget=${plan.target}\n`,
		);
	}
	return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
