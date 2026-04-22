import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { AuthError } from '../src/providers/auth.ts';
import { _test } from '../src/cli.ts';

const { reportAuthError, parseWriteModeResponse } = _test;

function captureStderr(run: () => void): string[] {
	const calls: string[] = [];
	const restore = mock.method(console, 'error', (msg: unknown) => {
		calls.push(String(msg));
	});
	try {
		run();
	} finally {
		restore.mock.restore();
	}
	return calls;
}

describe('reportAuthError', () => {
	it('formats AuthError with the provided prefix', () => {
		const calls = captureStderr(() => {
			const code = reportAuthError(
				new AuthError('invalid_code', 'Auth code rejected.'),
				'Login failed.',
			);
			assert.equal(code, 1);
		});
		assert.ok(calls.some((c) => c.includes('Login failed. Auth code rejected.')));
	});

	it('adds the network-connection hint for network_error', () => {
		const calls = captureStderr(() => {
			reportAuthError(
				new AuthError('network_error', 'connection refused'),
				'Login failed.',
			);
		});
		assert.ok(calls.some((c) => c.includes('network connection')));
	});

	it('handles plain Error instances', () => {
		const calls = captureStderr(() => {
			const code = reportAuthError(new Error('boom'), 'Oops.');
			assert.equal(code, 1);
		});
		assert.ok(calls.some((c) => c.includes('Oops. boom')));
	});

	it('handles non-Error thrown values without leaking undefined', () => {
		// Throwing a raw string / plain object is legal in JS. The old
		// `(err as Error).message` would print "undefined" (or throw on null).
		const calls = captureStderr(() => {
			reportAuthError('raw string value', 'Prefix:');
		});
		assert.ok(calls.some((c) => c.includes('raw string value')));
		assert.ok(!calls.some((c) => c.includes('undefined')));
	});

	it('coerces null without crashing', () => {
		const calls = captureStderr(() => {
			const code = reportAuthError(null, 'Prefix:');
			assert.equal(code, 1);
		});
		assert.ok(calls.length > 0);
	});
});

describe('parseWriteModeResponse', () => {
	it('returns true for y/yes in any case', () => {
		assert.equal(parseWriteModeResponse('y'), true);
		assert.equal(parseWriteModeResponse('Y'), true);
		assert.equal(parseWriteModeResponse('yes'), true);
		assert.equal(parseWriteModeResponse('YES'), true);
		assert.equal(parseWriteModeResponse('Yes'), true);
		assert.equal(parseWriteModeResponse('  yes  '), true);
	});

	it('returns false for empty or whitespace-only input', () => {
		assert.equal(parseWriteModeResponse(''), false);
		assert.equal(parseWriteModeResponse('   '), false);
		assert.equal(parseWriteModeResponse('\t'), false);
		assert.equal(parseWriteModeResponse('\n'), false);
	});

	it('returns false for anything other than y/yes', () => {
		assert.equal(parseWriteModeResponse('n'), false);
		assert.equal(parseWriteModeResponse('no'), false);
		assert.equal(parseWriteModeResponse('N'), false);
		assert.equal(parseWriteModeResponse('NO'), false);
		assert.equal(parseWriteModeResponse('maybe'), false);
		assert.equal(parseWriteModeResponse('1'), false);
		assert.equal(parseWriteModeResponse('yep'), false);
		assert.equal(parseWriteModeResponse('yeah'), false);
	});
});
