/**
 * Typed codec for the PHP <-> JS boundary.
 */

/** One tagged envelope. The tag set is closed; `decode()` refuses anything else. */
export type Envelope =
	| { __t: 'u' }
	| { __t: 'i'; v: string; approx?: true }
	| { __t: 'n'; v: string }
	| { __t: 'd'; v: string }
	| { __t: 'b'; v: string };

/** What `encode()` produces: JSON-safe, with every unrepresentable value inside an `Envelope`. */
export type Encoded =
	null | boolean | string | number | Envelope | Encoded[] | { [key: string]: Encoded };

/** A host surface handed to `codecGuard()`: callable members, plain values, or both. */
export type HostSurface = Record<string, unknown>;

/** The same surface with the codec applied at every entry and exit. */
export type GuardedSurface = Record<
	string,
	Encoded | ((...args: unknown[]) => Encoded | PromiseLike<Encoded>)
>;

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/** Largest integer a double represents exactly; beyond this, digits are lost. */
const SAFE_INT = Number.MAX_SAFE_INTEGER;

const isSafeForPhpInt = (n: number) => Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX;

/** arrays included, because both walkers reach them through their own branch first */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
	isRecord(v) && typeof v.then === 'function';

function bytesToBase64(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

/**
 * Wraps a value so it survives the 32-bit boundary without losing its type.
 *
 * @param depth Recursion guard; cyclic structures are not supported.
 */
export function encode(value: unknown, depth = 0): Encoded {
	if (depth > 32) {
		throw new RangeError('codec: structure too deep (cycle?)');
	}

	if (value === undefined) return { __t: 'u' };
	if (value === null) return null;

	const t = typeof value;

	if (typeof value === 'boolean' || typeof value === 'string') return value;

	if (typeof value === 'bigint') return { __t: 'i', v: value.toString() };

	if (typeof value === 'number') {
		if (Number.isInteger(value)) {
			if (isSafeForPhpInt(value)) return value;
			// beyond MAX_SAFE_INTEGER the decimal form is already approximate, so
			// flag it rather than pretending the digits are exact
			return {
				__t: 'i',
				v: value.toString(),
				approx: Math.abs(value) > SAFE_INT || undefined
			};
		}
		// NaN/Infinity have no JSON form and no portable PHP literal
		if (!Number.isFinite(value)) return { __t: 'n', v: String(value) };
		return value;
	}

	if (value instanceof Date) return { __t: 'd', v: String(value.getTime()) };
	if (value instanceof Uint8Array) return { __t: 'b', v: bytesToBase64(value) };
	if (value instanceof ArrayBuffer) return { __t: 'b', v: bytesToBase64(new Uint8Array(value)) };

	if (Array.isArray(value)) return value.map((v: unknown) => encode(v, depth + 1));

	if (isRecord(value)) {
		const out: Record<string, Encoded> = {};
		for (const [k, v] of Object.entries(value)) {
			// a caller-supplied key colliding with the tag would be indistinguishable
			// from an envelope, so refuse rather than silently mangle it
			if (k === '__t') {
				throw new TypeError('codec: "__t" is reserved and cannot be an object key');
			}
			out[k] = encode(v, depth + 1);
		}
		return out;
	}

	// functions/symbols cannot cross
	throw new TypeError(`codec: cannot encode ${t}`);
}

/**
 * Exact inverse of encode().
 */
export function decode(value: unknown, depth = 0): unknown {
	if (depth > 32) {
		throw new RangeError('codec: structure too deep (cycle?)');
	}
	if (!isRecord(value)) return value;

	if (Array.isArray(value)) return value.map((v: unknown) => decode(v, depth + 1));

	const tag = value.__t;
	if (typeof tag === 'string') {
		switch (tag) {
			case 'u':
				return undefined;
			case 'i': {
				// the payload is untrusted, and a `v` that is not a decimal string throws here
				// exactly as it did before
				const big = BigInt(value.v as string);
				// hand back a Number when it round-trips exactly, so ordinary
				// arithmetic keeps working; BigInt only when it must
				return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(SAFE_INT)
					? Number(big)
					: big;
			}
			case 'n': {
				if (value.v === 'NaN') return NaN;
				if (value.v === 'Infinity') return Infinity;
				if (value.v === '-Infinity') return -Infinity;
				return Number(value.v);
			}
			case 'd':
				return new Date(Number(value.v));
			case 'b':
				return base64ToBytes(value.v as string);
			default:
				throw new TypeError(`codec: unknown tag ${JSON.stringify(tag)}`);
		}
	}

	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = decode(v, depth + 1);
	return out;
}

/**
 * Wraps a host object so every argument is decoded on the way in and every
 * return value encoded on the way out.
 *
 * Applied at the boundary rather than per call site, because opt-in guarding is
 * precisely how the first two holes were missed.
 */
export function codecGuard(host: HostSurface): GuardedSurface {
	const wrapped: GuardedSurface = {};
	for (const [name, fn] of Object.entries(host)) {
		if (typeof fn !== 'function') {
			wrapped[name] = encode(fn);
			continue;
		}
		const call = fn as (...args: unknown[]) => unknown;
		wrapped[name] = (...args: unknown[]) => {
			const decoded = args.map((a) => decode(a));
			const r = call(...decoded);
			return isThenable(r) ? r.then((v) => encode(v)) : encode(r);
		};
	}
	return wrapped;
}

/**
 * PHP half of the codec. Kept in this file, next to the JS half, because the two
 * only work if they agree; splitting them across files is how they drift.
 */
export const PHP_CODEC = String.raw`
if (!function_exists('pw_decode')) {
	/**
	 * Inverse of the JS encode().
	 *
	 * An integer outside PHP's 32-bit range cannot be represented here, so it
	 * comes back as an explicit ['__phpint' => '<digits>'] marker rather than a
	 * bare string. That is deliberate: flattening it to a string forced
	 * pw_encode() to guess from the digits whether a value had originally been a
	 * number, and guessing turned the genuine string "007" into 7 and
	 * "1780000000000" into a number. A type cannot be recovered from digits, so
	 * it is carried explicitly. Both cases were caught by the boundary test.
	 */
	function pw_decode($v, $depth = 0) {
		if ($depth > 32) { return $v; }
		if (!is_array($v)) { return $v; }
		if (isset($v['__t']) && is_string($v['__t'])) {
			switch ($v['__t']) {
				case 'u': return null;
				case 'i':
					$s = (string) $v['v'];
					$n = (int) $s;
					return ((string) $n === $s) ? $n : ['__phpint' => $s];
				case 'n':
					if ($v['v'] === 'NaN') { return NAN; }
					if ($v['v'] === 'Infinity') { return INF; }
					if ($v['v'] === '-Infinity') { return -INF; }
					return (float) $v['v'];
				case 'd': return ['__phpdate' => (string) $v['v']];
				case 'b': return base64_decode((string) $v['v']);
				default: return $v;
			}
		}
		$out = [];
		foreach ($v as $k => $vv) { $out[$k] = pw_decode($vv, $depth + 1); }
		return $out;
	}

	/**
	 * Re-wraps only what was explicitly marked. Strings are never inspected.
	 */
	function pw_encode($v, $depth = 0) {
		if ($depth > 32) { return $v; }
		if (is_string($v)) { return $v; }
		if (is_float($v)) {
			if (is_nan($v)) { return ['__t' => 'n', 'v' => 'NaN']; }
			if (is_infinite($v)) { return ['__t' => 'n', 'v' => $v > 0 ? 'Infinity' : '-Infinity']; }
			return $v;
		}
		if (is_array($v)) {
			if (isset($v['__phpdate'])) { return ['__t' => 'd', 'v' => (string) $v['__phpdate']]; }
			if (isset($v['__phpint'])) { return ['__t' => 'i', 'v' => (string) $v['__phpint']]; }
			$out = [];
			foreach ($v as $k => $vv) { $out[$k] = pw_encode($vv, $depth + 1); }
			return $out;
		}
		return $v;
	}
}
`;
