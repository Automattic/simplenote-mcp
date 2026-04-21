import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { _test } from '../src/providers/native-macos.ts';

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
