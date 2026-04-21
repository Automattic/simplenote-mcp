import { readFileSync, statSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';
import { safeJsonParse, unixSecondsToIso } from './normalize.js';

// Core Data encodes timestamps as seconds since 2001-01-01 UTC.
const CORE_DATA_EPOCH_OFFSET = 978307200;

function getAttr(obj, name) {
	if (!obj?.attribute) {
		return null;
	}
	const attrs = Array.isArray(obj.attribute) ? obj.attribute : [obj.attribute];
	const attr = attrs.find((a) => a?.['@_name'] === name);
	return attr?.['#text'] ?? null;
}

function coreDataToIso(timestamp) {
	if (timestamp === null || timestamp === undefined || timestamp === '') {
		return null;
	}
	const parsed = parseFloat(timestamp);
	if (Number.isNaN(parsed)) {
		return null;
	}
	return unixSecondsToIso(parsed + CORE_DATA_EPOCH_OFFSET);
}

function normalizeNote(obj) {
	const rawContent = getAttr(obj, 'content');
	return {
		id: getAttr(obj, 'simperiumkey'),
		content: typeof rawContent === 'string' ? rawContent : '',
		tags: safeJsonParse(getAttr(obj, 'tags')),
		pinned: getAttr(obj, 'pinned') === '1',
		markdown: getAttr(obj, 'markdown') === '1',
		deleted: getAttr(obj, 'deleted') === '1',
		created: coreDataToIso(getAttr(obj, 'creationdate')),
		modified: coreDataToIso(getAttr(obj, 'modificationdate')),
	};
}

function normalizeTag(obj) {
	return {
		name: getAttr(obj, 'name'),
		index: parseInt(getAttr(obj, 'index') || '0', 10),
	};
}

/**
 * Create a native macOS provider that reads the Simplenote Core Data XML
 * store. Caches parsed output keyed by file mtime — a fresh parse only
 * happens when the underlying file changes.
 *
 * @param {{ storePath: string }} options
 * @returns {import('./normalize.js').Provider}
 */
export function createNativeProvider({ storePath }) {
	let cache = { mtime: null, data: null };

	async function loadStore() {
		let currentMtime;
		try {
			currentMtime = statSync(storePath).mtimeMs;
		} catch {
			throw new Error(
				`Simplenote store not found at ${storePath}. Is Simplenote installed?`
			);
		}

		if (cache.mtime === currentMtime && cache.data) {
			return cache.data;
		}

		let xml;
		try {
			xml = readFileSync(storePath, 'utf-8');
		} catch (err) {
			throw new Error(`Failed to read Simplenote store: ${err.message}`);
		}

		let db;
		try {
			db = new XMLParser({ ignoreAttributes: false }).parse(xml);
		} catch (err) {
			throw new Error(`Failed to parse Simplenote data: ${err.message}`);
		}

		const objects = db.database?.object || [];
		const objectList = Array.isArray(objects) ? objects : [objects];

		const notes = objectList
			.filter((obj) => obj['@_type'] === 'NOTE')
			.map(normalizeNote);
		const tags = objectList
			.filter((obj) => obj['@_type'] === 'TAG')
			.map(normalizeTag)
			.filter((t) => t.name);

		cache = { mtime: currentMtime, data: { notes, tags } };
		return cache.data;
	}

	return { loadStore };
}
