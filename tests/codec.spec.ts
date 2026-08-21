import { describe, expect, it } from 'vitest';
import { codecGuard, decode, encode } from '../src/codec.js';

/**
 * Ported from `scripts/test-codec.mjs` (43 hand-rolled assertions).
 *
 * The codec exists because PHP in this build is 32-bit (`PHP_INT_SIZE` 4) while every
 * interesting number crossing the bridge is not: a SQLite INTEGER is 64-bit, node ids
 * exceed 2^31, and `Date.now()` is ~1.78e12. Two holes were found in production paths and
 * both have a case here -- `Date.now()` wrapping to -397708726, and node ids above 2^31.
 *
 * `toEqual` does the structural comparison the original hand-wrote, and it handles
 * `Uint8Array`, `Date`, `NaN` and nesting correctly, so the custom `eq()` is not carried
 * over. The one thing it does NOT do is distinguish `12345` from `'12345'`, so the
 * string-stays-string cases assert on `typeof` explicitly -- that is the case the old
 * `marshal()` could not express and the reason the codec was written.
 */

/** round-trips a value and asserts it comes back structurally identical */
const trip = <T>(value: T): unknown => decode(encode(value));

describe('codec: values that cross natively', () => {
	it.each([
		['zero', 0],
		['small int', 42],
		['negative int', -42],
		['int32 max', 2 ** 31 - 1],
		['int32 min', -(2 ** 31)],
		['float', 1.5],
		['negative float', -0.25],
		['true', true],
		['false', false],
		['string', 'hello'],
		['empty string', ''],
		['null', null],
		['unicode string', 'héllo 世界 🌍']
	])('round-trips %s', (_label, value) => {
		expect(trip(value)).toEqual(value);
	});
});

describe('codec: the 32-bit regressions', () => {
	// these two are the holes that were found separately in real paths
	it('round-trips a Date.now() magnitude, which used to wrap to -397708726', () => {
		expect(trip(1780000000000)).toEqual(1780000000000);
	});

	it.each([
		['node id at 2^31', 2 ** 31],
		['node id well above 2^31', 4294967296],
		['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
		['MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER]
	])('round-trips %s', (_label, value) => {
		expect(trip(value)).toEqual(value);
	});

	it.each([
		['bigint', 12345678901234567890n],
		['negative bigint', -12345678901234567890n]
	])('round-trips a %s', (_label, value) => {
		expect(trip(value)).toEqual(value);
	});

	// the control: the old lossy behaviour stringified large integers, so asserting the output
	// is genuinely a number is what stops a regression to a string passing here
	it('a large int does NOT decode to a string, which was the old lossy behaviour', () => {
		const got = trip(1780000000000);
		expect(got).not.toBe(String(1780000000000));
		expect(typeof got).toBe('number');
	});
});

describe('codec: a digit string stays a string', () => {
	// if these re-tagged as integers, pw_encode would corrupt them on the way back
	it.each([
		['digit string', '12345'],
		['wide digit string', '1780000000000'],
		['leading-zero digit string', '007']
	])('%s survives as a string', (_label, value) => {
		const got = trip(value);
		expect(got).toBe(value);
		expect(typeof got).toBe('string');
	});
});

describe('codec: special numerics', () => {
	it('round-trips NaN', () => expect(Number.isNaN(trip(NaN) as number)).toBe(true));
	it('round-trips Infinity', () => expect(trip(Infinity)).toBe(Infinity));
	it('round-trips -Infinity', () => expect(trip(-Infinity)).toBe(-Infinity));
});

describe('codec: structured values', () => {
	it.each([
		['array', [1, 2, 3]],
		['nested array', [1, [2, [3, [4]]]]],
		['object', { a: 1, b: 'two' }],
		['nested object', { a: { b: { c: 1780000000000 } } }],
		['empty array', []],
		['empty object', {}],
		['array with undefined', [1, undefined, 3]]
	])('round-trips a %s', (_label, value) => {
		expect(trip(value)).toEqual(value);
	});

	it('round-trips a mixed payload of every wide-number shape', () => {
		const value = { ids: [2 ** 31, 2 ** 31 + 1], when: 1780000000000, name: 'x' };
		expect(trip(value)).toEqual(value);
	});

	it('round-trips undefined', () => {
		expect(trip(undefined)).toEqual(undefined);
	});
});

describe('codec: binary and dates', () => {
	it('round-trips bytes, including NUL and high bytes', () => {
		const value = new Uint8Array([0, 1, 255, 128]);
		expect(trip(value)).toEqual(value);
	});

	it('round-trips empty bytes', () => {
		expect(trip(new Uint8Array([]))).toEqual(new Uint8Array([]));
	});

	it('round-trips a Date', () => {
		expect(trip(new Date(1780000000000))).toEqual(new Date(1780000000000));
	});
});

describe('codec: refusals', () => {
	it('refuses the reserved key __t, which would be indistinguishable from a tag', () => {
		expect(() => encode({ __t: 'i' })).toThrow();
	});

	it('refuses a function', () => {
		expect(() => encode(() => 1)).toThrow();
	});

	it('refuses a cycle rather than recursing forever', () => {
		const a: Record<string, unknown> = {};
		a.self = a;
		expect(() => encode(a)).toThrow();
	});

	it('refuses an unknown tag on the way in', () => {
		expect(() => decode({ __t: 'zzz', v: 1 })).toThrow();
	});
});

describe('codec: the depth guard, which is the cycle answer in both directions', () => {
	/** builds `{a:{a:{...}}}` nested `depth` times */
	const deep = (depth: number): unknown => {
		let value: unknown = 1;
		for (let i = 0; i < depth; i++) value = { a: value };
		return value;
	};

	it('refuses to encode past 32 levels rather than recursing forever on a cycle', () => {
		expect(() => encode(deep(40))).toThrow(RangeError);
	});

	it('refuses to DECODE past 32 levels too, which is the untrusted direction', () => {
		// encode() is called on values this process built; decode() is called on whatever the
		// interpreter sent, so this is the side an attacker reaches
		expect(() => decode(deep(40))).toThrow(RangeError);
	});

	it('CONTROL: a structure inside the limit round-trips', () => {
		expect(trip(deep(8))).toEqual(deep(8));
	});
});

describe('codec: a plain float tag', () => {
	it('decodes an ordinary decimal payload, not just the three special names', () => {
		expect(decode({ __t: 'n', v: '1.5' })).toBe(1.5);
	});
});

describe('codecGuard', () => {
	/** the two host shapes a guarded surface has to carry: callables and plain values */
	const guarded = () =>
		codecGuard({
			echo: (value: unknown) => value,
			widen: (n: unknown) => (n as number) + 1,
			later: async (value: unknown) => value,
			version: 3,
			banner: 'cfw'
		});

	it('decodes an argument on the way in and encodes the result on the way out', () => {
		// the whole reason it is applied at the BOUNDARY: opt-in guarding is precisely how the
		// first two 32-bit holes were missed
		const host = guarded();
		const call = host.echo as (...args: unknown[]) => unknown;
		expect(call({ __t: 'i', v: '9007199254740993' })).toEqual({
			__t: 'i',
			v: '9007199254740993'
		});
	});

	it('hands the callee a real value rather than an envelope', () => {
		const host = guarded();
		const call = host.widen as (...args: unknown[]) => unknown;
		expect(call({ __t: 'n', v: '1.5' })).toBe(2.5);
	});

	it('awaits a promise-returning member and encodes what it resolves to', async () => {
		// the argument arrives as an envelope because that is what the interpreter sends; the
		// callee sees a real Date, and what comes back out is an envelope again
		const host = guarded();
		const call = host.later as (...args: unknown[]) => PromiseLike<unknown>;
		const out = await call({ __t: 'd', v: '1780000000000' });
		expect(out).toEqual({ __t: 'd', v: '1780000000000' });
	});

	it('encodes a non-callable member in place rather than dropping it', () => {
		const host = guarded();
		expect(host.version).toBe(3);
		expect(host.banner).toBe('cfw');
	});

	it('carries every member across, so a guarded surface is not a narrower one', () => {
		expect(Object.keys(guarded()).sort()).toEqual([
			'banner',
			'echo',
			'later',
			'version',
			'widen'
		]);
	});
});
