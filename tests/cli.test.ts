import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { AuthError } from '../src/providers/auth.ts';
import { _test } from '../src/cli.ts';

const { reportAuthError } = _test;

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
