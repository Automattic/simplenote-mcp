import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { _test } from '../src/providers/simperium-api.ts';

const { normalizeNote, normalizeTag, toBool, toIsoFromUnix } = _test;

describe('toBool', () => {
	it('handles boolean inputs', () => {
		assert.equal(toBool(true), true);
		assert.equal(toBool(false), false);
	});
	it('handles numeric inputs', () => {
		assert.equal(toBool(1), true);
		assert.equal(toBool(0), false);
	});
	it('handles string inputs', () => {
		assert.equal(toBool('1'), true);
		assert.equal(toBool('true'), true);
		assert.equal(toBool('TRUE'), true);
		assert.equal(toBool('0'), false);
		assert.equal(toBool('false'), false);
	});
	it('returns false for unknown / undefined / null', () => {
		assert.equal(toBool(undefined), false);
		assert.equal(toBool(null), false);
		assert.equal(toBool({}), false);
	});
});

describe('toIsoFromUnix', () => {
	it('converts a number to ISO', () => {
		assert.equal(toIsoFromUnix(0), '1970-01-01T00:00:00.000Z');
	});
	it('converts a numeric string', () => {
		assert.equal(toIsoFromUnix('1700000000'), new Date(1700000000_000).toISOString());
	});
	it('preserves fractional seconds', () => {
		assert.equal(toIsoFromUnix(1700000000.5), new Date(1700000000_500).toISOString());
	});
	it('returns null for non-finite / missing', () => {
		assert.equal(toIsoFromUnix(undefined), null);
		assert.equal(toIsoFromUnix('not a number'), null);
		assert.equal(toIsoFromUnix(NaN), null);
	});
});

describe('normalizeNote', () => {
	it('returns null when id is missing', () => {
		assert.equal(normalizeNote({ d: { content: 'x' } }), null);
	});

	it('returns null when data is missing', () => {
		assert.equal(normalizeNote({ id: 'abc' }), null);
	});

	it('builds a normalized note from a full payload', () => {
		const out = normalizeNote({
			id: 'abc-123',
			d: {
				content: 'Hello\nworld',
				tags: ['recipes', 'saved'],
				systemTags: ['pinned', 'markdown'],
				deleted: false,
				creationDate: 1700000000,
				modificationDate: 1700000100,
			},
		});
		assert.deepEqual(out, {
			id: 'abc-123',
			content: 'Hello\nworld',
			tags: ['recipes', 'saved'],
			pinned: true,
			markdown: true,
			deleted: false,
			created: new Date(1700000000_000).toISOString(),
			modified: new Date(1700000100_000).toISOString(),
		});
	});

	it('treats absent systemTags entries as false flags', () => {
		const out = normalizeNote({
			id: 'x',
			d: { content: '', systemTags: [] },
		});
		assert.equal(out?.pinned, false);
		assert.equal(out?.markdown, false);
	});

	it('filters non-string entries from tags / systemTags', () => {
		const out = normalizeNote({
			id: 'x',
			d: { tags: ['ok', 1, null, 'fine'], systemTags: ['pinned', 42] },
		});
		assert.deepEqual(out?.tags, ['ok', 'fine']);
		assert.equal(out?.pinned, true);
	});

	it('defaults content to empty string when missing', () => {
		const out = normalizeNote({ id: 'x', d: {} });
		assert.equal(out?.content, '');
		assert.equal(out?.created, null);
		assert.equal(out?.modified, null);
	});
});

describe('normalizeTag', () => {
	it('returns null when neither name nor id is usable', () => {
		assert.equal(normalizeTag({ d: {} }), null);
	});

	it('uses entry.id as a fallback when d.name is missing', () => {
		const out = normalizeTag({ id: 'recipes', d: { index: 5 } });
		assert.deepEqual(out, { name: 'recipes', index: 5 });
	});

	it('parses a numeric-string index', () => {
		const out = normalizeTag({ id: 'x', d: { name: 'work', index: '3' } });
		assert.deepEqual(out, { name: 'work', index: 3 });
	});

	it('defaults index to 0 when missing or unparseable', () => {
		assert.deepEqual(normalizeTag({ id: 'x', d: { name: 'a' } }), {
			name: 'a',
			index: 0,
		});
		assert.deepEqual(normalizeTag({ id: 'x', d: { name: 'a', index: 'nope' } }), {
			name: 'a',
			index: 0,
		});
	});
});
