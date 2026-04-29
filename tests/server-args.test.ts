import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseServerArgs } from '../src/server-args.ts';

describe('parseServerArgs', () => {
	it('returns empty options when no server args are present', () => {
		assert.deepEqual(parseServerArgs([]), {});
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

	it('rejects duplicate --path', () => {
		assert.throws(
			() => parseServerArgs(['--path=/first', '--path', '/second']),
			/--path specified more than once/,
		);
		assert.throws(
			() => parseServerArgs(['--path', '/first', '--path=/second']),
			/--path specified more than once/,
		);
	});

	it('rejects unknown flags', () => {
		assert.throws(
			() => parseServerArgs(['--verbose']),
			/Unknown flag: --verbose/,
		);
		assert.throws(
			() => parseServerArgs(['--paht', '/tmp/x.storedata']),
			/Unknown flag: --paht/,
		);
	});

	it('rejects unexpected positional arguments', () => {
		assert.throws(
			() => parseServerArgs(['somecmd']),
			/Unexpected argument: somecmd/,
		);
		assert.throws(
			() => parseServerArgs(['--path=/tmp/x', 'extra']),
			/Unexpected argument: extra/,
		);
	});

	it('returns mode "help" for --help and -h', () => {
		assert.deepEqual(parseServerArgs(['--help']), { mode: 'help' });
		assert.deepEqual(parseServerArgs(['-h']), { mode: 'help' });
	});

	it('returns mode "version" for --version and -V', () => {
		assert.deepEqual(parseServerArgs(['--version']), { mode: 'version' });
		assert.deepEqual(parseServerArgs(['-V']), { mode: 'version' });
	});

	it('treats --help as terminal — does not validate later args', () => {
		assert.deepEqual(parseServerArgs(['--help', '--unknown']), {
			mode: 'help',
		});
	});

	it('treats --version as terminal — does not validate later args', () => {
		assert.deepEqual(parseServerArgs(['--version', 'extra']), {
			mode: 'version',
		});
	});
});
