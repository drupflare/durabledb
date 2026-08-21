import {
	SLICE_STAT_FIRES,
	SLICE_STAT_MASK,
	configureMask,
	maskDepth,
	maskStats,
	resetMask
} from '@drupflare/cartridge/mask';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SiteDurableObject, bindable, toPositional, type SiteEnv } from '../src/do-sqlite.js';

/**
 * Ported from `scripts/test-do-sql.mjs` (31 hand-rolled assertions).
 *
 * `ctx.storage.sql` has no named parameters, so every Drupal query has to be rewritten to
 * positional form. A naive `String.replace` corrupts a `:` inside a string literal, a
 * quoted identifier or a comment -- and Drupal emits all three -- so those are the cases
 * that carry the weight, and the control below proves they are not vacuous.
 *
 * The last describe in this file arrived from `cartridge/tests/_needs-rewrite/`, where it was parked
 * because it needs the durabledb side AND cartridge's mask singleton at once and the
 * `@drupflare/cartridge` specifier did not resolve. It is folded in here rather than given its own
 * `do-sqlite-bridge.spec.ts`: `src/do-sqlite.ts` is one domain and gets one spec file. The
 * assertions are byte-identical to the parked copy; only the import specifier moved, from the root
 * entry to `@drupflare/cartridge/mask`.
 */

describe('toPositional: basics', () => {
	it('leaves a query with no params alone', () => {
		expect(toPositional('SELECT 1', [])).toEqual({ text: 'SELECT 1', values: [] });
	});

	it('passes an already-positional query through', () => {
		expect(toPositional('SELECT ?', [5])).toEqual({ text: 'SELECT ?', values: [5] });
	});

	it('rewrites a single named placeholder', () => {
		expect(toPositional('SELECT cid FROM cache WHERE cid = :cid', { ':cid': 'x' })).toEqual({
			text: 'SELECT cid FROM cache WHERE cid = ?',
			values: ['x']
		});
	});

	it('accepts a bare key with no leading colon', () => {
		expect(toPositional('SELECT cid FROM cache WHERE cid = :cid', { cid: 'y' })).toEqual({
			text: 'SELECT cid FROM cache WHERE cid = ?',
			values: ['y']
		});
	});

	it('preserves order across several placeholders', () => {
		expect(
			toPositional('SELECT * FROM n WHERE a = :a AND b = :b AND c = :c', {
				':a': 1,
				':b': 2,
				':c': 3
			})
		).toEqual({ text: 'SELECT * FROM n WHERE a = ? AND b = ? AND c = ?', values: [1, 2, 3] });
	});

	it('handles a Drupal-style expanded IN list', () => {
		expect(
			toPositional('SELECT * FROM n WHERE nid IN (:nids__0, :nids__1)', {
				':nids__0': 7,
				':nids__1': 8
			})
		).toEqual({ text: 'SELECT * FROM n WHERE nid IN (?, ?)', values: [7, 8] });
	});
});

describe('toPositional: the cases a naive replace breaks', () => {
	it('ignores a colon inside a single-quoted literal', () => {
		expect(toPositional("SELECT * FROM n WHERE t = 'a:b' AND x = :x", { ':x': 1 })).toEqual({
			text: "SELECT * FROM n WHERE t = 'a:b' AND x = ?",
			values: [1]
		});
	});

	it("handles an escaped '' inside a literal", () => {
		expect(
			toPositional("SELECT * FROM n WHERE t = 'it''s a:b' AND x = :x", { ':x': 1 })
		).toEqual({
			text: "SELECT * FROM n WHERE t = 'it''s a:b' AND x = ?",
			values: [1]
		});
	});

	it('ignores a colon inside a double-quoted identifier', () => {
		expect(toPositional('SELECT "we:ird" FROM n WHERE x = :x', { ':x': 2 })).toEqual({
			text: 'SELECT "we:ird" FROM n WHERE x = ?',
			values: [2]
		});
	});

	it('ignores a colon inside a line comment', () => {
		expect(toPositional('SELECT 1 -- note :notaparam\nWHERE x = :x', { ':x': 3 })).toEqual({
			text: 'SELECT 1 -- note :notaparam\nWHERE x = ?',
			values: [3]
		});
	});

	it('ignores a colon inside a block comment', () => {
		expect(toPositional('SELECT /* :nope */ 1 WHERE x = :x', { ':x': 4 })).toEqual({
			text: 'SELECT /* :nope */ 1 WHERE x = ?',
			values: [4]
		});
	});

	it('does not treat a :: cast as a placeholder', () => {
		expect(toPositional('SELECT x::text FROM n', {})).toEqual({
			text: 'SELECT x::text FROM n',
			values: []
		});
	});

	it('handles a placeholder at the very end of the string', () => {
		expect(toPositional('SELECT * FROM n WHERE x = :x', { ':x': 9 })).toEqual({
			text: 'SELECT * FROM n WHERE x = ?',
			values: [9]
		});
	});

	it('binds a repeated placeholder once per occurrence', () => {
		expect(toPositional('SELECT * FROM n WHERE a = :v OR b = :v', { ':v': 5 })).toEqual({
			text: 'SELECT * FROM n WHERE a = ? OR b = ?',
			values: [5, 5]
		});
	});

	it('keeps a null binding', () => {
		expect(toPositional('SELECT * FROM n WHERE x = :x', { ':x': null })).toEqual({
			text: 'SELECT * FROM n WHERE x = ?',
			values: [null]
		});
	});

	it('does not rescan a bound value that looks like a placeholder', () => {
		expect(toPositional('SELECT * FROM n WHERE x = :x', { ':x': ':y' })).toEqual({
			text: 'SELECT * FROM n WHERE x = ?',
			values: [':y']
		});
	});

	it('refuses a missing binding rather than emitting wrong SQL', () => {
		expect(() => toPositional('SELECT :missing', { ':other': 1 })).toThrow();
	});

	// the control: if a naive rewriter passed the literal case too, every literal-safety
	// assertion above would be proving nothing.
	it('a naive rewriter really does corrupt the literal case', () => {
		const naive = (sql: string, params: Record<string, unknown>) => {
			let text = sql;
			const values: unknown[] = [];
			for (const [k, v] of Object.entries(params)) {
				const key = k.startsWith(':') ? k : `:${k}`;
				if (text.includes(key)) {
					text = text.split(key).join('?');
					values.push(v);
				}
			}
			return { text, values };
		};
		const bad = naive("SELECT * FROM n WHERE t = 'a:b' AND x = :b", { ':b': 1 });
		expect(bad.text).not.toBe("SELECT * FROM n WHERE t = 'a:b' AND x = ?");
	});
});

/**
 * Two platform facts meet in `bindable()`. `ctx.storage.sql` refuses a BigInt outright
 * ("Cannot convert a BigInt value to a number"), AND its cursor returns INTEGER columns as
 * JS doubles, so anything above 2^53 reads back altered -- 9007199254740993 comes back as
 * ...992, measured. Converting a wide BigInt to a decimal string would store it perfectly
 * and read it back wrong with nothing raised, so it is refused at the WRITE instead.
 */
describe('bindable', () => {
	it.each([
		['a safe-range BigInt becomes a number', 1n, 1],
		['2^53-1 is the last accepted value', 9007199254740991n, 9007199254740991],
		['a negative safe-range BigInt keeps its sign', -42n, -42],
		['a plain number is untouched', 42, 42],
		['a float is untouched', 1.5, 1.5],
		// a long digit string is a legitimate TEXT value and cannot be told apart from a
		// wide integer, so it is deliberately passed through
		['a numeric string is untouched', '9007199254740993', '9007199254740993'],
		['null is untouched', null, null]
	])('%s', (_label, input, expected) => {
		const got = bindable(input);
		expect(got).toBe(expected);
		expect(typeof got).toBe(typeof expected);
	});

	it.each([
		['2^53+1', 9007199254740993n],
		['int64 max', 9223372036854775807n],
		['2^53 itself', 9007199254740992n],
		['a wide negative', -9007199254740993n]
	])('refuses %s with UnreadableIntegerError', (_label, input) => {
		expect(() => bindable(input)).toThrowError(
			expect.objectContaining({ name: 'UnreadableIntegerError' })
		);
	});

	// the control: the value really is unreadable, which is what justifies refusing it
	// rather than storing it
	it('2^53+1 does not survive a JS double, so refusing it is not superstition', () => {
		expect(Number(9007199254740993n)).toBe(9007199254740992);
	});

	it('passes a Uint8Array blob through by reference', () => {
		const blob = new Uint8Array([1, 2, 3]);
		expect(bindable(blob)).toBe(blob);
	});
});

// #region the fake VM, copied from cartridge's own tests/mask.spec.ts

type FakeVmState = {
	depth: number;
	fires: number;
	flaggedByTick: number;
	raises: number;
	refused: number;
	maskCalls: number[];
	statCalls: number;
};

type FakeVm = {
	state: FakeVmState;
	mask: (on: unknown) => number;
	stat: ((which: number) => number) | null;
	raise: (() => boolean) | null;
	tick: () => void;
};

function fakeVm(opts: { raise?: false | 'refuse' } = {}): FakeVm {
	const state: FakeVmState = {
		depth: 0,
		fires: 0,
		flaggedByTick: 0,
		raises: 0,
		refused: 0,
		maskCalls: [],
		statCalls: 0
	};
	return {
		state,
		mask(on) {
			state.maskCalls.push(on ? 1 : 0);
			state.depth += on ? 1 : -1;
			if (state.depth < 0) state.depth = 0;
			return state.depth;
		},
		stat(which) {
			state.statCalls++;
			if (which === SLICE_STAT_FIRES) return state.fires;
			if (which === SLICE_STAT_MASK) return state.depth;
			return 0;
		},
		raise:
			opts.raise === false
				? null
				: () => {
						// the C guard: a raise while masked sets nothing
						if (state.depth > 0 || opts.raise === 'refuse') {
							state.refused++;
							return false;
						}
						state.raises++;
						return true;
					},
		// zend_wasm_tick_fired(): counts and re-arms always, flags only when unmasked
		tick() {
			state.fires++;
			if (state.depth === 0) state.flaggedByTick++;
		}
	};
}

// #endregion

describe('the wiring: the SQL bridge in src/do-sqlite.ts', () => {
	/** installBridge() only reads this.execSql / this.execTxn */
	type BridgeStub = {
		execSql: (sql: string, params: unknown[]) => unknown;
		execTxn: (req: { statements: unknown[] }) => unknown;
	};
	type Bridge = {
		cfwSqlExec: (json: string) => string;
		cfwSqlTxn: (json: string) => string;
	};
	const installBridge = SiteDurableObject.prototype.installBridge as unknown as (
		this: BridgeStub,
		module: Record<string, unknown>
	) => Bridge;

	beforeEach(() => resetMask());
	afterEach(() => {
		configureMask({ vm: null, budgetExceeded: null });
		resetMask();
	});

	it('masks both host calls, unmasks between them, and unmasks on a failure', () => {
		const vm = fakeVm();
		configureMask({ vm, dev: true });

		const depths: number[] = [];
		// a stub keeps this hermetic: no ctx.storage.sql, no DO runtime
		const stub: BridgeStub = {
			execSql(sql, params) {
				depths.push(maskDepth());
				// a fire landing mid-query is the exact case the seam exists for
				vm.tick();
				return { rows: [[sql, params.length]], rowsRead: 1, rowsWritten: 0 };
			},
			execTxn(req) {
				depths.push(maskDepth());
				return { ok: true, results: req.statements.map(() => 1), readResult: null };
			}
		};
		const bridge = installBridge.call(stub, {});

		const exec = JSON.parse(bridge.cfwSqlExec(JSON.stringify({ sql: 'SELECT 1', params: [] })));
		expect(depths[0]).toBe(1);
		expect(maskDepth()).toBe(0);
		expect(exec.ok).toBe(true);
		expect(vm.state.raises).toBe(1);
		expect(vm.state.refused).toBe(0);

		const txn = JSON.parse(
			bridge.cfwSqlTxn(JSON.stringify({ statements: [{ sql: 'INSERT' }], commit: true }))
		);
		expect(depths[1]).toBe(1);
		expect(txn.ok).toBe(true);
		expect(maskDepth()).toBe(0);

		// the error path must unmask too, or one failed query wedges every later slice
		stub.execSql = () => {
			throw new Error('no such table: node');
		};
		const bad = JSON.parse(
			installBridge.call(stub, {}).cfwSqlExec(JSON.stringify({ sql: 'SELECT 1', params: [] }))
		);
		expect(bad.ok).toBe(false);
		expect(String(bad.error)).toContain('no such table');
		expect(maskDepth()).toBe(0);
		expect(vm.state.depth).toBe(0);

		const s = maskStats();
		expect(s.enters).toBe(3);
		expect(s.nested).toBe(0);
	});

	it('reports a failed REPLAY as an encoded refusal too, not as a thrown host call', () => {
		// the txn half has the same catch as the exec half and it was the untested one; a throw
		// escaping here crosses back into wasm, where PHP cannot catch it
		const stub: BridgeStub = {
			execSql: () => ({}),
			execTxn() {
				throw new Error('transaction storage failed');
			}
		};
		const bridge = installBridge.call(stub, {});
		const out = JSON.parse(bridge.cfwSqlTxn(JSON.stringify({ statements: [] })));
		expect(out.ok).toBe(false);
		expect(String(out.error)).toContain('transaction storage failed');
	});

	it('refuses malformed JSON from the bridge rather than throwing into wasm', () => {
		const stub: BridgeStub = { execSql: () => ({}), execTxn: () => ({}) };
		const bridge = installBridge.call(stub, {});
		expect(JSON.parse(bridge.cfwSqlTxn('{ not json')).ok).toBe(false);
	});
});

// #region the object itself, driven over a fake DurableObjectState

/**
 * A fake `ctx.storage.sql`, and the fake is the instrument.
 *
 * It understands only the statements this class issues -- the two SQLite counter queries, the
 * `node` table the `/__txn` probe writes, and `BEGIN`/`ROLLBACK`/`COMMIT`, which it refuses. That
 * refusal is the platform fact the `/__txn` route exists to record: DO SQLite answers "please use
 * the state.storage.transaction() ... APIs instead", so a fake that accepted `BEGIN` would let the
 * route report a rollback that the real runtime never performs.
 *
 * `transactionSync` snapshots and restores, because callback-scoped rollback is the mechanism the
 * whole replay is built on and a fake that ignored the throw would pass every abort assertion
 * below while the real one rolled back nothing.
 */
interface Executed {
	text: string;
	values: unknown[];
}

interface NodeRow {
	nid: number;
	title: string;
	created: number;
}

class FakeSql {
	executed: Executed[] = [];
	nodes = new Map<number, NodeRow>();
	databaseSize = 4096;
	/** any statement matching this throws, which is how a SQLite error is injected */
	failOn: RegExp | null = null;
	private lastRowid = 0;
	private lastChanges = 0;

	exec(text: string, ...values: unknown[]) {
		this.executed.push({ text, values });
		if (this.failOn !== null && this.failOn.test(text)) {
			throw new Error(`no such table: ${text.slice(0, 20)}`);
		}
		if (/^\s*(BEGIN|ROLLBACK|COMMIT|SAVEPOINT)/i.test(text)) {
			throw new Error(
				'To execute a transaction, please use the state.storage.transaction() or ' +
					'state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or ' +
					'SAVEPOINT statements.'
			);
		}
		if (/last_insert_rowid/.test(text)) return cursor([{ id: this.lastRowid }], 1, 0);
		if (/changes\(\)/.test(text)) return cursor([{ c: this.lastChanges }], 1, 0);
		if (/COUNT\(\*\) AS c FROM node/i.test(text)) {
			return cursor([{ c: this.nodes.size }], this.nodes.size, 0);
		}
		const insert =
			/INSERT INTO node \(nid, title, created\) VALUES \((\d+), '([^']*)', (\d+)\)/i;
		const match = insert.exec(text);
		if (match !== null) {
			const nid = Number(match[1]);
			this.nodes.set(nid, { nid, title: match[2]!, created: Number(match[3]) });
			this.lastRowid = nid;
			this.lastChanges = 1;
			return cursor([], 0, 1);
		}
		return cursor([], 1, 0);
	}

	snapshot(): Map<number, NodeRow> {
		return new Map(this.nodes);
	}

	restore(rows: Map<number, NodeRow>): void {
		this.nodes = rows;
	}
}

function cursor(rows: Record<string, unknown>[], rowsRead: number, rowsWritten: number) {
	return { toArray: () => rows, rowsRead, rowsWritten };
}

interface FakeCtx {
	sql: FakeSql;
	alarm: number | null;
	setAlarms: number[];
	storage: {
		sql: FakeSql;
		transactionSync: <T>(callback: () => T) => T;
		getAlarm: () => Promise<number | null>;
		setAlarm: (at: number) => Promise<void>;
	};
}

function fakeCtx(): FakeCtx {
	const sql = new FakeSql();
	const state: FakeCtx = {
		sql,
		alarm: null,
		setAlarms: [],
		storage: {
			sql,
			transactionSync<T>(callback: () => T): T {
				const before = sql.snapshot();
				try {
					return callback();
				} catch (error) {
					sql.restore(before);
					throw error;
				}
			},
			getAlarm: async () => state.alarm,
			setAlarm: async (at: number) => {
				state.alarm = at;
				state.setAlarms.push(at);
			}
		}
	};
	return state;
}

/** the object under test, plus the fake it was constructed with */
function siteObject(env: Partial<SiteEnv> = {}) {
	const ctx = fakeCtx();
	const site = new SiteDurableObject(ctx as unknown as DurableObjectState, {
		ASSETS: {} as Fetcher,
		...env
	});
	return { ctx, site };
}

const post = (path: string, body: unknown) =>
	new Request(`https://site.test${path}`, { method: 'POST', body: JSON.stringify(body) });

describe('execSql', () => {
	it('hands ctx.storage.sql positional bindings, never named ones', () => {
		// ctx.storage.sql has no named-parameter support at all, so the rewrite is not a
		// convenience -- an unrewritten query binds nothing and matches nothing
		const { ctx, site } = siteObject();
		site.execSql('SELECT * FROM cache WHERE cid = :cid', { ':cid': 'x' });
		expect(ctx.sql.executed[0]).toEqual({
			text: 'SELECT * FROM cache WHERE cid = ?',
			values: ['x']
		});
	});

	it('reports SQLite own counters rather than a JS-side guess', () => {
		const { site } = siteObject();
		const result = site.execSql("INSERT INTO node (nid, title, created) VALUES (7, 'a', 1)");
		expect(result.lastInsertRowid).toBe(7);
		expect(result.changes).toBe(1);
		expect(result.rowsWritten).toBe(1);
	});

	it('accumulates rows written across the object life, which is the billing meter', () => {
		// rows written is what binds the regeneration ceiling on the free plan, and nothing was
		// counting it
		const { site } = siteObject();
		site.execSql("INSERT INTO node (nid, title, created) VALUES (1, 'a', 1)");
		site.execSql("INSERT INTO node (nid, title, created) VALUES (2, 'b', 1)");
		expect(site.rowsWritten).toBe(2);
		expect(site.queryCount).toBe(2);
	});

	it('counts the statements it was ASKED to run, and not its own counter queries', () => {
		// `rowidOf()` and `changesOf()` reach ctx.storage.sql directly, so a statement costs three
		// round trips and the accumulators see one -- a platform figure would be off by 2n
		const { ctx, site } = siteObject();
		site.execSql('SELECT * FROM cache');
		expect(site.rowsRead).toBe(1);
		expect(ctx.sql.executed).toHaveLength(3);
	});

	it('answers 0 for the counters when the counter query itself fails', () => {
		// a SELECT that throws must not take the statement down with it: the row was still written
		const { ctx, site } = siteObject();
		ctx.sql.failOn = /last_insert_rowid|changes\(\)/;
		const result = site.execSql('SELECT 1');
		expect(result.lastInsertRowid).toBe(0);
		expect(result.changes).toBe(0);
	});

	it('refuses a bigint that would read back altered', () => {
		const { site } = siteObject();
		expect(() => site.execSql('SELECT :v', { ':v': 9007199254740993n })).toThrowError(
			expect.objectContaining({ name: 'UnreadableIntegerError' })
		);
	});
});

describe('execTxn', () => {
	it('replays every statement inside one transaction and returns a result each', () => {
		const { site } = siteObject();
		const out = site.execTxn({
			statements: [
				{ sql: "INSERT INTO node (nid, title, created) VALUES (1, 'a', 1)" },
				{ sql: "INSERT INTO node (nid, title, created) VALUES (2, 'b', 1)" }
			],
			commit: true
		});
		expect(out.ok).toBe(true);
		expect(out.ok && out.results).toHaveLength(2);
		expect(site.txnCount).toBe(1);
		expect(site.txnStatements).toBe(2);
	});

	it('runs the read so the caller sees its own uncommitted write, then aborts', () => {
		// the speculative path: a dirty read has to observe the buffered statements, and the throw
		// that rolls them back is deliberate rather than an error
		const { ctx, site } = siteObject();
		const out = site.execTxn({
			statements: [{ sql: "INSERT INTO node (nid, title, created) VALUES (5, 'x', 1)" }],
			read: { sql: 'SELECT COUNT(*) AS c FROM node' },
			commit: false
		});
		expect(out.ok).toBe(true);
		expect(out.ok && out.readResult?.rows[0]).toEqual({ c: 1 });
		// and the write is gone afterwards, which is what makes it speculative
		expect(ctx.sql.nodes.size).toBe(0);
		expect(site.txnSpeculative).toBe(1);
	});

	it('reports a real failure as ok:false, with everything rolled back', () => {
		const { ctx, site } = siteObject();
		ctx.sql.failOn = /DROP/;
		const out = site.execTxn({
			statements: [
				{ sql: "INSERT INTO node (nid, title, created) VALUES (9, 'kept?', 1)" },
				{ sql: 'DROP TABLE node' }
			]
		});
		expect(out.ok).toBe(false);
		expect(out.ok === false && out.error).toMatch(/no such table/);
		expect(ctx.sql.nodes.size).toBe(0);
	});

	it('tolerates a request carrying no statements at all', () => {
		const { site } = siteObject();
		const out = site.execTxn({} as never);
		expect(out.ok).toBe(true);
		expect(out.ok && out.results).toEqual([]);
		expect(site.txnStatements).toBe(0);
	});
});

describe('the keep-warm alarm', () => {
	it('arms an alarm when none exists and reports the interval', async () => {
		const { ctx, site } = siteObject();
		const out = await site.scheduleKeepWarm(1000);
		expect(out).toEqual({ scheduled: true, intervalMs: 1000 });
		expect(ctx.alarm).toBeGreaterThan(0);
	});

	it('leaves an existing alarm alone rather than pushing it out', async () => {
		// re-arming on every request would move the alarm forward forever and it would never fire
		const { ctx, site } = siteObject();
		ctx.alarm = 12345;
		const out = await site.scheduleKeepWarm();
		expect(out).toEqual({ scheduled: false, existingAlarm: 12345 });
		expect(ctx.setAlarms).toEqual([]);
	});

	it('touches the database and re-arms at four minutes', async () => {
		const { ctx, site } = siteObject();
		await site.alarm();
		expect(ctx.sql.executed.map((e) => e.text)).toContain('SELECT 1');
		expect(site.lastKeepWarm).toBeGreaterThan(0);
		expect(ctx.setAlarms[0]! - site.lastKeepWarm!).toBe(240000);
	});

	it('re-arms even when the touch throws, or one bad tick ends the chain', async () => {
		const { ctx, site } = siteObject();
		ctx.sql.failOn = /SELECT 1/;
		await site.alarm();
		expect(ctx.setAlarms).toHaveLength(1);
	});
});

describe('the diagnostic routes', () => {
	it('runs one statement and encodes the result', async () => {
		const { site } = siteObject();
		const response = await site.fetch(
			post('/__sql', { sql: 'SELECT * FROM cache WHERE cid = :cid', params: { ':cid': 'x' } })
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, rowsRead: 1 });
	});

	it('answers 400 with the SQLite message rather than a 500', async () => {
		const { ctx, site } = siteObject();
		ctx.sql.failOn = /SELECT nope/;
		const response = await site.fetch(post('/__sql', { sql: 'SELECT nope' }));
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false });
	});

	it('records that DO SQLite refuses a bare BEGIN', async () => {
		// the cross-request BEGIN/ROLLBACK experiment failed for a different reason, and this is
		// the one that is a platform fact rather than an event-boundary artefact
		const { site } = siteObject();
		const body = await (
			await site.fetch(post('/__txn', { mode: 'sql' }))
		).json<{
			threw: string | null;
			rolledBack: boolean;
		}>();
		expect(body.threw).toMatch(/transactionSync/);
		expect(body.rolledBack).toBe(true);
	});

	it('rolls back when the transactionSync callback throws', async () => {
		const { ctx, site } = siteObject();
		const body = await (
			await site.fetch(post('/__txn', { mode: 'transactionSync' }))
		).json<{
			threw: string | null;
			before: number;
			after: number;
			rolledBack: boolean;
		}>();
		expect(body.threw).toBe('deliberate abort');
		expect(body).toMatchObject({ before: 0, after: 0, rolledBack: true });
		expect(ctx.sql.nodes.size).toBe(0);
	});

	it('CONTROL: a transactionSync that does not throw keeps the row', async () => {
		// without this the rollback assertions above would pass on a fake that never writes
		const { ctx, site } = siteObject();
		const body = await (
			await site.fetch(post('/__txn', { mode: 'transactionSyncCommit' }))
		).json<{ before: number; after: number; rolledBack: boolean }>();
		expect(body).toMatchObject({ before: 0, after: 1, rolledBack: false });
		expect(ctx.sql.nodes.get(903)?.title).toBe('kept');
	});

	it('writes nothing at all when no mode is named', async () => {
		const { ctx, site } = siteObject();
		const body = await (await site.fetch(post('/__txn', {}))).json<{ threw: string | null }>();
		expect(body.threw).toBeNull();
		expect(ctx.sql.nodes.size).toBe(0);
	});

	it('replays a buffered transaction through the encoded route', async () => {
		const { ctx, site } = siteObject();
		const response = await site.fetch(
			post('/__txnreplay', {
				statements: [{ sql: "INSERT INTO node (nid, title, created) VALUES (4, 'r', 1)" }],
				commit: true
			})
		);
		expect(await response.json()).toMatchObject({ ok: true });
		expect(ctx.sql.nodes.has(4)).toBe(true);
	});

	it('arms the keep-warm alarm through its route', async () => {
		const { ctx, site } = siteObject();
		const response = await site.fetch(post('/__keepwarm', {}));
		expect(await response.json()).toMatchObject({ scheduled: true, intervalMs: 240000 });
		expect(ctx.alarm).toBeGreaterThan(0);
	});

	it('reports the counters an operator reads', async () => {
		const { site } = siteObject();
		site.execSql('SELECT 1');
		site.execTxn({ statements: [{ sql: 'SELECT 1' }], commit: true });
		const stats = await (
			await site.fetch(post('/__stats', {}))
		).json<{
			queryCount: number;
			txnCount: number;
			txnStatements: number;
			txnSpeculative: number;
			databaseSize: number;
			gate: { depth: number };
		}>();
		expect(stats).toMatchObject({
			queryCount: 2,
			txnCount: 1,
			txnStatements: 1,
			txnSpeculative: 0,
			databaseSize: 4096
		});
		expect(stats.gate).toBeTypeOf('object');
	});

	it('404s an unclaimed path instead of falling through to a route', async () => {
		const { site } = siteObject();
		const response = await site.fetch(post('/__nope', {}));
		expect(response.status).toBe(404);
	});
});

describe('the gate around fetch()', () => {
	it('serialises two overlapping requests, because PHP globals do not survive interleaving', async () => {
		// measured without the gate: 11 of 12 concurrent two-phase requests corrupted
		const order: string[] = [];
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});

		class SlowSite extends SiteDurableObject {
			override async handle(request: Request, url: URL): Promise<Response> {
				order.push(`enter ${url.pathname}`);
				if (url.pathname === '/__slow') await blocked;
				order.push(`leave ${url.pathname}`);
				return super.handle(request, url);
			}
		}

		const ctx = fakeCtx();
		const site = new SlowSite(ctx as unknown as DurableObjectState, { ASSETS: {} as Fetcher });
		const first = site.fetch(post('/__slow', {}));
		const second = site.fetch(post('/__stats', {}));

		// the second must not have entered while the first is parked
		await Promise.resolve();
		expect(order).toEqual(['enter /__slow']);
		release!();
		await Promise.all([first, second]);
		expect(order).toEqual([
			'enter /__slow',
			'leave /__slow',
			'enter /__stats',
			'leave /__stats'
		]);
	});
});

// #endregion
