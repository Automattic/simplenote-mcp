import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseServerArgs } from '../src/server-args.ts';

describe('parseServerArgs', () => {
	it('returns empty options when no server args are present', () => {
		assert.deepEqual(parseServerArgs([]), {});
		assert.deepEqual(parseServerArgs(['--verbose']), {});
	});

	it('parses --path=value', () => {
		assert.deepEqual(parseServerArgs(['--path=/tmp/Simplenote.storedata']), {
			explicitPath: '/tmp/Simplenote.storedata',
		});
	});

	it('parses --path value', () => {
		assert.deepEqual(parseServerArgs(['--path', '/tmp/Simplenote.storedata']), {
			explicitPath: '/tmp/Simplenote.storedata',
		});
	});

	it('returns the first explicit path', () => {
		assert.deepEqual(parseServerArgs(['--path=/first', '--path', '/second']), {
			explicitPath: '/first',
		});
	});

	it('rejects --path= without a value', () => {
		assert.throws(
			() => parseServerArgs(['--path=']),
			/--path= requires a value/,
		);
	});

	it('rejects --path without a following value', () => {
		assert.throws(
			() => parseServerArgs(['--path']),
			/--path requires a value/,
		);
		assert.throws(
			() => parseServerArgs(['--path', '--other']),
			/--path requires a value/,
		);
	});
});
