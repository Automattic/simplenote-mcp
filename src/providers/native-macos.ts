import { readFileSync, statSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import {
	safeJsonStringArray,
	type NormalizedNote,
	type NormalizedStore,
	type NormalizedTag,
	type Provider,
} from './normalize.js';

// Core Data uses seconds since 2001-01-01 UTC.
const CORE_DATA_EPOCH_OFFSET = 978_307_200;

type CoreDataAttr = {
	'@_name'?: string;
	'#text'?: string | number | boolean;
};

type CoreDataObject = {
	'@_type'?: string;
	attribute?: CoreDataAttr | CoreDataAttr[];
};

class NativeMacosProvider implements Provider {
	readonly name = 'native-macos' as const;
	readonly description: string;
	readonly storePath: string;
	private cache: { mtime: number; data: NormalizedStore } | null = null;

	constructor(storePath: string) {
		this.storePath = storePath;
		this.description = `native macOS Core Data store at ${storePath}`;
	}

	async loadStore(): Promise<NormalizedStore> {
		let currentMtime: number;
		try {
			currentMtime = statSync(this.storePath).mtimeMs;
		} catch {
			throw new Error(
				`Simplenote store not found at ${this.storePath}. Is Simplenote installed?`,
			);
		}

		if (this.cache && this.cache.mtime === currentMtime) {
			return this.cache.data;
		}

		let xml: string;
		try {
			xml = readFileSync(this.storePath, 'utf-8');
		} catch (err) {
			throw new Error(`Failed to read Simplenote store: ${(err as Error).message}`);
		}

		let db: { database?: { object?: CoreDataObject | CoreDataObject[] } };
		try {
			// parseTagValue: false keeps numeric-looking element text as strings so
			// flag comparisons (e.g. pinned === '1') and date parsing work reliably.
			const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
			db = parser.parse(xml) as typeof db;
		} catch (err) {
			throw new Error(`Failed to parse Simplenote data: ${(err as Error).message}`);
		}

		const objects = db.database?.object ?? [];
		const objectList: CoreDataObject[] = Array.isArray(objects) ? objects : [objects];

		const notes: NormalizedNote[] = [];
		const tags: NormalizedTag[] = [];
		for (const obj of objectList) {
			if (obj['@_type'] === 'NOTE') {
				const note = normalizeNote(obj);
				if (note) notes.push(note);
			} else if (obj['@_type'] === 'TAG') {
				const tag = normalizeTag(obj);
				if (tag) tags.push(tag);
			}
		}

		this.cache = { mtime: currentMtime, data: { notes, tags } };
		return this.cache.data;
	}
}

export function createNativeProvider(storePath: string): Provider {
	return new NativeMacosProvider(storePath);
}

function getAttr(obj: CoreDataObject, name: string): string | null {
	if (!obj.attribute) return null;
	const attrs = Array.isArray(obj.attribute) ? obj.attribute : [obj.attribute];
	const attr = attrs.find((a) => a?.['@_name'] === name);
	const text = attr?.['#text'];
	return text == null ? null : String(text);
}

function normalizeNote(obj: CoreDataObject): NormalizedNote | null {
	const id = getAttr(obj, 'simperiumkey');
	if (!id) return null;
	const rawContent = getAttr(obj, 'content');
	return {
		id,
		content: typeof rawContent === 'string' ? rawContent : '',
		tags: safeJsonStringArray(getAttr(obj, 'tags')),
		pinned: getAttr(obj, 'pinned') === '1',
		markdown: getAttr(obj, 'markdown') === '1',
		deleted: getAttr(obj, 'deleted') === '1',
		created: convertCoreDataDate(getAttr(obj, 'creationdate')),
		modified: convertCoreDataDate(getAttr(obj, 'modificationdate')),
	};
}

function normalizeTag(obj: CoreDataObject): NormalizedTag | null {
	const name = getAttr(obj, 'name');
	if (!name) return null;
	const indexStr = getAttr(obj, 'index');
	const parsed = indexStr ? Number.parseInt(indexStr, 10) : 0;
	return { name, index: Number.isFinite(parsed) ? parsed : 0 };
}

function convertCoreDataDate(value: string | null): string | null {
	if (!value) return null;
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed)) return null;
	return new Date((parsed + CORE_DATA_EPOCH_OFFSET) * 1000).toISOString();
}

export const _test = { getAttr, normalizeNote, normalizeTag, convertCoreDataDate };
