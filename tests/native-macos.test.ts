import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { _test, createNativeProvider } from '../src/providers/native-macos.ts';
import { useTmpDir } from './helpers/general.ts';

const { getAttr, normalizeNote, normalizeTag, convertCoreDataDate } = _test;

describe('convertCoreDataDate', () => {
	it('converts the Core Data epoch (0) to 2001-01-01', () => {
		assert.equal(convertCoreDataDate('0'), '2001-01-01T00:00:00.000Z');
	});

	it('returns null for null / non-numeric', () => {
		assert.equal(convertCoreDataDate(null), null);
		assert.equal(convertCoreDataDate('not a number'), null);
	});

	it('handles fractional seconds', () => {
		const out = convertCoreDataDate('1.5');
		assert.equal(out, '2001-01-01T00:00:01.500Z');
	});
});

describe('getAttr', () => {
	it('returns the value of a single attribute', () => {
		const obj = { attribute: { '@_name': 'foo', '#text': 'bar' } };
		assert.equal(getAttr(obj, 'foo'), 'bar');
	});

	it('returns the matching attribute from an array', () => {
		const obj = {
			attribute: [
				{ '@_name': 'a', '#text': '1' },
				{ '@_name': 'b', '#text': '2' },
			],
		};
		assert.equal(getAttr(obj, 'b'), '2');
	});

	it('returns null when attribute is missing', () => {
		assert.equal(getAttr({}, 'x'), null);
		assert.equal(getAttr({ attribute: { '@_name': 'a', '#text': '1' } }, 'b'), null);
	});
});

describe('normalizeNote (Core Data)', () => {
	it('parses a full note', () => {
		const obj = {
			'@_type': 'NOTE',
			attribute: [
				{ '@_name': 'simperiumkey', '#text': 'k1' },
				{ '@_name': 'content', '#text': 'hello' },
				{ '@_name': 'tags', '#text': '["a","b"]' },
				{ '@_name': 'pinned', '#text': '1' },
				{ '@_name': 'markdown', '#text': '1' },
				{ '@_name': 'deleted', '#text': '0' },
				{ '@_name': 'creationdate', '#text': '0' },
				{ '@_name': 'modificationdate', '#text': '0' },
			],
		};
		assert.deepEqual(normalizeNote(obj), {
			id: 'k1',
			content: 'hello',
			tags: ['a', 'b'],
			pinned: true,
			markdown: true,
			deleted: false,
			created: '2001-01-01T00:00:00.000Z',
			modified: '2001-01-01T00:00:00.000Z',
		});
	});

	it('returns null when simperiumkey is missing', () => {
		const obj = { attribute: [{ '@_name': 'content', '#text': 'x' }] };
		assert.equal(normalizeNote(obj), null);
	});

	it('treats non-"1" attribute values as false flags', () => {
		const obj = {
			attribute: [
				{ '@_name': 'simperiumkey', '#text': 'k' },
				{ '@_name': 'pinned', '#text': '0' },
				{ '@_name': 'markdown', '#text': 'true' },
				{ '@_name': 'deleted', '#text': '' },
			],
		};
		const out = normalizeNote(obj);
		assert.equal(out?.pinned, false);
		assert.equal(out?.markdown, false);
		assert.equal(out?.deleted, false);
	});
});

describe('normalizeTag (Core Data)', () => {
	it('parses a full tag', () => {
		const obj = {
			attribute: [
				{ '@_name': 'name', '#text': 'recipes' },
				{ '@_name': 'index', '#text': '7' },
			],
		};
		assert.deepEqual(normalizeTag(obj), { name: 'recipes', index: 7 });
	});

	it('defaults index to 0 when missing', () => {
		const obj = { attribute: [{ '@_name': 'name', '#text': 'work' }] };
		assert.deepEqual(normalizeTag(obj), { name: 'work', index: 0 });
	});

	it('returns null when name is missing', () => {
		assert.equal(normalizeTag({ attribute: [{ '@_name': 'index', '#text': '0' }] }), null);
	});
});

// These tests round-trip through fast-xml-parser to catch regressions in
// parser configuration. fast-xml-parser's default parseTagValue=true coerces
// numeric-looking element text into numbers, which would silently break flag
// comparisons, content typing, and date parsing.
describe('createNativeProvider.loadStore (XML round-trip)', () => {
	const tmp = useTmpDir('simplenote-mcp-native-macos-test-');

	async function writeStore(body: string): Promise<string> {
		const storePath = tmp.path('store.xml');
		await writeFile(
			storePath,
			`<?xml version="1.0" encoding="UTF-8"?>\n<database>${body}</database>`,
		);
		return storePath;
	}

	it('coerces numeric-looking flag text to true ("1") and false ("0")', async () => {
		const storePath = await writeStore(`
			<object type="NOTE">
				<attribute name="simperiumkey">k1</attribute>
				<attribute name="content">hello</attribute>
				<attribute name="pinned">1</attribute>
				<attribute name="markdown">1</attribute>
				<attribute name="deleted">0</attribute>
				<attribute name="creationdate">0</attribute>
				<attribute name="modificationdate">0</attribute>
			</object>
			<object type="NOTE">
				<attribute name="simperiumkey">k2</attribute>
				<attribute name="content">x</attribute>
				<attribute name="pinned">0</attribute>
				<attribute name="markdown">0</attribute>
				<attribute name="deleted">1</attribute>
				<attribute name="creationdate">0</attribute>
				<attribute name="modificationdate">0</attribute>
			</object>
		`);
		const store = await createNativeProvider(storePath).loadStore();
		const k1 = store.notes.find((n) => n.id === 'k1');
		const k2 = store.notes.find((n) => n.id === 'k2');
		assert.equal(k1?.pinned, true);
		assert.equal(k1?.markdown, true);
		assert.equal(k1?.deleted, false);
		assert.equal(k2?.pinned, false);
		assert.equal(k2?.markdown, false);
		assert.equal(k2?.deleted, true);
	});

	it('preserves purely numeric note content as a string', async () => {
		const storePath = await writeStore(`
			<object type="NOTE">
				<attribute name="simperiumkey">num</attribute>
				<attribute name="content">42</attribute>
				<attribute name="creationdate">0</attribute>
				<attribute name="modificationdate">0</attribute>
			</object>
		`);
		const store = await createNativeProvider(storePath).loadStore();
		const note = store.notes.find((n) => n.id === 'num');
		assert.equal(note?.content, '42');
	});

	it('parses creationdate=0 as the Core Data epoch', async () => {
		const storePath = await writeStore(`
			<object type="NOTE">
				<attribute name="simperiumkey">epoch</attribute>
				<attribute name="content">x</attribute>
				<attribute name="creationdate">0</attribute>
				<attribute name="modificationdate">0</attribute>
			</object>
		`);
		const store = await createNativeProvider(storePath).loadStore();
		const note = store.notes.find((n) => n.id === 'epoch');
		assert.equal(note?.created, '2001-01-01T00:00:00.000Z');
		assert.equal(note?.modified, '2001-01-01T00:00:00.000Z');
	});

	it('parses tag index as a number, defaulting to 0 when absent', async () => {
		const storePath = await writeStore(`
			<object type="TAG">
				<attribute name="name">recipes</attribute>
				<attribute name="index">7</attribute>
			</object>
			<object type="TAG">
				<attribute name="name">work</attribute>
			</object>
		`);
		const store = await createNativeProvider(storePath).loadStore();
		const recipes = store.tags.find((t) => t.name === 'recipes');
		const work = store.tags.find((t) => t.name === 'work');
		assert.equal(recipes?.index, 7);
		assert.equal(work?.index, 0);
	});
});
