import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractTitle, safeJsonStringArray } from '../src/providers/normalize.ts';

describe('extractTitle', () => {
	it('returns (empty) for null/undefined/empty/non-string', () => {
		assert.equal(extractTitle(null), '(empty)');
		assert.equal(extractTitle(undefined), '(empty)');
		assert.equal(extractTitle(''), '(empty)');
	});

	it('returns the first line, trimmed', () => {
		assert.equal(extractTitle('  Hello  \nworld'), 'Hello');
	});

	it('falls back to (empty) when first line is whitespace-only', () => {
		assert.equal(extractTitle('   \nactual content'), '(empty)');
	});

	it('truncates to 100 chars', () => {
		const long = 'x'.repeat(150);
		assert.equal(extractTitle(long).length, 100);
	});

	it('preserves exactly 100 chars', () => {
		const exact = 'y'.repeat(100);
		assert.equal(extractTitle(exact), exact);
	});
});

describe('safeJsonStringArray', () => {
	it('parses a valid JSON string array', () => {
		assert.deepEqual(safeJsonStringArray('["a","b","c"]'), ['a', 'b', 'c']);
	});

	it('returns [] for empty / non-string / invalid JSON', () => {
		assert.deepEqual(safeJsonStringArray(''), []);
		assert.deepEqual(safeJsonStringArray(null), []);
		assert.deepEqual(safeJsonStringArray(42), []);
		assert.deepEqual(safeJsonStringArray('not json'), []);
	});

	it('returns [] when JSON parses to a non-array', () => {
		assert.deepEqual(safeJsonStringArray('{"a":1}'), []);
		assert.deepEqual(safeJsonStringArray('"plain string"'), []);
	});

	it('filters out non-string elements', () => {
		assert.deepEqual(safeJsonStringArray('["a", 1, null, "b", true]'), ['a', 'b']);
	});
});
