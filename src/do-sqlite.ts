import { Gate } from '@drupflare/cartridge/gate';
import { withMask } from '@drupflare/cartridge/mask';
import { decode, encode } from './codec';

/**
 * Everything a site object may be constructed with: two bindings, and the vars that tune it.
 */
export interface SiteEnv {
	SITE?: DurableObjectNamespace;
	/** not optional: every mount reads its pack through this, so an object without it cannot boot */
	ASSETS: Fetcher;
	MODULE_PACK?: R2Bucket;

	PW_DIAGNOSTICS?: string;
	PLAN?: string;
	LAZY_MOUNT?: string;
	LAZY_FS_BUDGET_BYTES?: string | number;
	SITE_DB_PREFIX?: string;
	SQL_CHUNK_PREFIX?: string;
	MIGRATE_ENGINE?: string;
	MIGRATE_SELF_DRIVE?: string;
	MIGRATE_CHUNKS_PER_INVOCATION?: string | number;

	RENDER_BUDGET_MS?: string | number;
	GEN_BUCKET_MS?: string | number;
	GC_INTERVAL_MS?: string | number;
	KEEP_WARM_MS?: string | number;

	FILL_BATCH_SIZE?: string | number;
	FILL_BATCH_WALL_MS?: string | number;
	PREFILL_ON_SAVE?: string;
	PREFILL_ON_SAVE_LIMIT?: string | number;

	HTTP_DRAIN_ON_ALARM?: string;
	HTTP_DRAIN_LIMIT?: string | number;
	CFW_EMAIL_BINDING?: string;

	WINDOW_SITES?: string;
	WINDOW_MAX_FILLS?: string | number;
	WINDOW_WALL_MS?: string | number;

	CRON_QUEUE_BATCH_SIZE?: string | number;
	CACHE_DATA_MAX_ROWS?: string | number;
	WATCHDOG_ROW_LIMIT?: string | number;

	UPDB_FLUSH_SPLIT?: string;
	UPDB_ALLOW_UNBOUNDED?: string;
	UPDB_SNAPSHOT_MAX_ROWS?: string | number;
	UPDB_RETRY_POLICY?: string;
	UPDB_ON_ABORT?: string;
	UPDB_MAX_ATTEMPTS?: string | number;
	UPDB_MAX_PASSES?: string | number;
	UPDB_MAX_COLD_WAITS?: string | number;
	UPDB_MAX_BEATS?: string | number;
	UPDB_CHECK_REQUIREMENTS?: string;
}

/** One statement's result, in the shape a PDO statement yields. */
export interface ExecSqlResult {
	rows: Record<string, SqlStorageValue>[];
	rowsRead: number;
	rowsWritten: number;
	lastInsertRowid: number;
	changes: number;
}

/** One statement as a buffered Drupal transaction hands it over. */
export interface TxnStatement {
	sql: string;
	params?: SqlBindings;
}

/** A buffered transaction to replay; `commit: false` is the speculative read path. */
export interface TxnRequest {
	statements: TxnStatement[];
	commit?: boolean;
	read?: TxnStatement;
}

/**
 * The replay's verdict.
 *
 * A union rather than one shape with optionals: a failed replay has already been rolled back,
 * so there are no results to read, and the discriminant is what stops a caller reading them.
 */
export type ExecTxnResult =
	| { ok: false; error: string }
	| { ok: true; results: ExecSqlResult[]; readResult: ExecSqlResult | null };

/** A named-parameter map, or an already-positional list. */
export type SqlBindings = unknown[] | Record<string, unknown> | null;

/**
 * Durable Object that owns one site: the PHP interpreter and the database.
 *
 * WHY THIS IS THE BLOCKER: until now the database lived in MEMFS. MEMFS is
 * isolate-local and ephemeral, so every write -- a new node, a user, a cache
 * entry, a config change -- is lost when the isolate dies. That is not a
 * performance characteristic, it is "the site does not persist".
 * `ctx.storage.sql` is the only durable, synchronously-readable store in
 * Workers, and it is only synchronous from INSIDE the DO. Which is why PHP runs
 * here rather than in a Worker isolate holding a stub.
 *
 * There is no in-memory Map standing in for storage anywhere in this file. The
 * previous `/page` route had one, and it was masking exactly the decision this
 * class makes.
 *
 * Every entry point goes through the gate: `ctx.storage.sql.exec()` is
 * synchronous, but a request that awaits anything at all (an outbound fetch, a
 * future JSPI suspension) parks inside the interpreter, and a second request
 * entering there corrupts PHP globals. Measured without the gate: 11 of 12
 * concurrent two-phase requests corrupted.
 */
export class SiteDurableObject {
	ctx: DurableObjectState;
	env: SiteEnv;
	sql: SqlStorage;
	gate: Gate;
	queryCount: number;
	/** accumulated across the object's life; `undefined` until the first statement */
	rowsWritten?: number;
	rowsRead?: number;
	txnCount?: number;
	txnStatements?: number;
	txnSpeculative?: number;
	lastKeepWarm?: number;

	constructor(ctx: DurableObjectState, env: SiteEnv) {
		this.ctx = ctx;
		this.env = env;
		this.sql = ctx.storage.sql;
		/**
		 * The PHP lane: FIFO only, deliberately NOT wrapped in
		 * `ctx.blockConcurrencyWhile()`.
		 *
		 * The strong form is strictly worse here and it took a lane split to see why.
		 * `blockConcurrencyWhile` stops the runtime DELIVERING events, so while a
		 * render holds it, a cache HIT that needs no PHP at all cannot even arrive --
		 * every HIT queues behind the render and the single-threaded object becomes
		 * the throughput ceiling for traffic that was never going to touch the
		 * interpreter. A sliced render would hold it for the whole sliced lifetime and
		 * make that permanent.
		 *
		 * The FIFO chain is what the PHP invariant actually requires: at most one
		 * callback in the interpreter at a time. Everything that made
		 * `blockConcurrencyWhile` look necessary is covered by it, including the
		 * alarm-vs-fetch direction, because `alarm()` enters the same gate. And the
		 * storage lane is safe alongside a render for a reason that is measurable
		 * rather than hopeful: `php._run()` is one synchronous wasm call, so PHP is
		 * quiescent at every await where another event could be delivered.
		 *
		 * `doGate()` stays exported and tested for callers that do want event-delivery
		 * suppression; this class is not one of them.
		 */
		this.gate = new Gate();
		this.queryCount = 0;
	}

	/**
	 * Runs one SQL statement and returns rows as plain arrays.
	 *
	 * Shape deliberately matches what a PDO statement yields, so Drupal's own
	 * sqlite driver sits on top with its SQL generation, Schema and query
	 * builders unchanged. Replacing the driver layer rather than reimplementing
	 * Drupal's SQL is the whole reason this is tractable.
	 *
	 * Named parameters are converted to positional because `ctx.storage.sql`
	 * takes only positional bindings.
	 */
	execSql(sql: string, params?: SqlBindings): ExecSqlResult {
		this.queryCount++;
		const { text, values } = toPositional(sql, params);
		const cursor = this.sql.exec(text, ...values.map(bindable));
		// toArray() must be called before another exec() on the same statement;
		// the cursor is a live iterator, not a snapshot
		const rows = cursor.toArray();
		// Accumulated because rows-written is the free plan's BINDING meter, not CPU:
		// 100k/day against ~18 rows per fill caps a site at roughly 5,555 fills a day,
		// and every setAlarm() spends one more. Nothing was counting it.
		this.rowsWritten = (this.rowsWritten ?? 0) + cursor.rowsWritten;
		this.rowsRead = (this.rowsRead ?? 0) + cursor.rowsRead;
		return {
			rows,
			rowsRead: cursor.rowsRead,
			rowsWritten: cursor.rowsWritten,
			// SQLite's own counters, not a JS-side guess
			lastInsertRowid: rowidOf(this.sql),
			changes: changesOf(this.sql)
		};
	}

	/**
	 * Atomic replay of a buffered Drupal transaction.
	 *
	 * Drupal's Connection::beginTransaction()/commit()/rollBack() is a BEGIN-COMMIT
	 * api; ctx.storage.transactionSync() is callback-scoped. They do not compose,
	 * and issuing BEGIN as SQL throws outright ("please use the
	 * state.storage.transaction() ... APIs instead"). So the PHP driver withholds
	 * writes and hands the whole list here to be replayed inside one
	 * transactionSync.
	 *
	 * `commit: false` is the speculative path: replay, run one read so the caller
	 * can see its own uncommitted write, then abort. Throwing from inside the
	 * callback is what makes transactionSync roll back, so the throw is deliberate
	 * and its message is not an error.
	 */
	execTxn(req: TxnRequest): ExecTxnResult {
		const statements = Array.isArray(req?.statements) ? req.statements : [];
		const results: ExecSqlResult[] = [];
		let readResult: ExecSqlResult | null = null;
		const ABORT = '__cfw_speculative_abort__';

		// counted because the replay is the one place cost can go quadratic: each dirty
		// read replays the whole buffer, so statements-per-transaction is the signal
		// that would show it happening
		this.txnCount = (this.txnCount ?? 0) + 1;
		this.txnStatements = (this.txnStatements ?? 0) + statements.length;
		if (req?.commit === false) {
			this.txnSpeculative = (this.txnSpeculative ?? 0) + 1;
		}

		try {
			this.ctx.storage.transactionSync(() => {
				for (const st of statements) {
					results.push(this.execSql(st.sql, st.params ?? []));
				}
				if (req?.read) {
					readResult = this.execSql(req.read.sql, req.read.params ?? []);
				}
				if (req?.commit === false) {
					throw new Error(ABORT);
				}
			});
		} catch (e: any) {
			const msg = String(e?.message ?? e);
			if (msg !== ABORT) {
				// a real failure: transactionSync has already rolled everything back
				return { ok: false, error: msg };
			}
		}

		return { ok: true, results, readResult };
	}

	/**
	 * Installs the synchronous SQL entry point on the PHP Module so vrzno can
	 * reach it, wrapped in the codec.
	 *
	 * The codec matters here specifically: node IDs, file sizes and timestamps
	 * all cross this boundary, PHP is 32-bit, and a SQLite INTEGER can exceed
	 * 2^31. Handing back a raw JS number silently wraps it -- that is the bug
	 * class the codec closes, and a database driver is where it would bite
	 * hardest.
	 *
	 * Both entry points run inside `withMask()`: they are JS frames under the PHP
	 * stack, and a slice interrupt that fires there cannot suspend (see src/mask.js).
	 * The decode/encode codec calls sit inside the same window, so the codec needs no
	 * mask of its own.
	 */
	installBridge(module: Record<string, unknown>): Record<string, unknown> {
		module.cfwSqlTxn = (reqJson: string) =>
			withMask(() => {
				try {
					return JSON.stringify(
						encode(this.execTxn(decode(JSON.parse(reqJson)) as TxnRequest))
					);
				} catch (e: any) {
					return JSON.stringify(encode({ ok: false, error: String(e?.message ?? e) }));
				}
			});
		module.cfwSqlExec = (sqlJson: string) =>
			withMask(() => {
				const { sql, params } = decode(JSON.parse(sqlJson)) as {
					sql: string;
					params?: SqlBindings;
				};
				try {
					return JSON.stringify(encode({ ok: true, ...this.execSql(sql, params ?? []) }));
				} catch (e: any) {
					// surface the SQLite message; Drupal maps it to a DatabaseException
					return JSON.stringify(encode({ ok: false, error: String(e?.message ?? e) }));
				}
			});
		return module;
	}

	/**
	 * Keeps the interpreter warm.
	 *
	 * Boot is per-DO-lifetime, not per-request: 3,754 ms of CPU on the edge, of
	 * which roughly 1 s of the residual has no identified lever. So the strategy
	 * cannot be "make boot fast", it has to be "boot rarely". An alarm is the only
	 * way a DO wakes itself, so it is the cold-start strategy rather than an
	 * optimisation.
	 *
	 * The interval is a floor, not a guarantee: Cloudflare may still evict, and
	 * alarms are best-effort. It reduces cold starts, it does not remove them.
	 */
	async scheduleKeepWarm(intervalMs = 240000) {
		const at = await this.ctx.storage.getAlarm();
		if (at === null) {
			await this.ctx.storage.setAlarm(this.nowMs() + intervalMs);
			return { scheduled: true, intervalMs };
		}
		return { scheduled: false, existingAlarm: at };
	}

	/**
	 * Alarm handler. Touches the database so the isolate stays resident and the
	 * page cache stays populated, then re-arms.
	 *
	 * Deliberately cheap: a keep-warm that renders a page would burn CPU on every
	 * tick for no user.
	 */
	async alarm() {
		this.lastKeepWarm = this.nowMs();
		try {
			this.sql.exec('SELECT 1');
		} catch {
			/* a failed touch must not stop re-arming */
		}
		await this.ctx.storage.setAlarm(this.nowMs() + 240000);
	}

	/**
	 * Date.now() is not available at DO global scope in some contexts and the
	 * value must also survive the 32-bit PHP boundary, so it is read here and
	 * encoded by the codec on the way out rather than passed raw.
	 */
	nowMs(): number {
		return Date.now();
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		return this.gate.run(() => this.handle(request, url));
	}

	/**
	 * Routing, deliberately OUTSIDE the gate.
	 *
	 * A subclass has to be able to fall through to these routes from inside its own
	 * gated handler. Calling a gated fetch() from within gate.run() self-deadlocks:
	 * the inner run() awaits the release of the outer link, which only resolves
	 * once the outer callback returns. ctx.blockConcurrencyWhile() forbids nesting
	 * outright for the same reason. So fetch() gates once and every route body
	 * lives here.
	 */
	async handle(request: Request, url: URL): Promise<Response> {
		{
			switch (url.pathname) {
				case '/__sql': {
					const body = await request.json<{ sql: string; params?: SqlBindings }>();
					try {
						return Response.json(
							encode({
								ok: true,
								...this.execSql(body.sql, body.params ?? [])
							})
						);
					} catch (e: any) {
						return Response.json(
							{ ok: false, error: String(e?.message ?? e) },
							{ status: 400 }
						);
					}
				}
				// Same-event transaction, and the DO-native mechanism.
				//
				// The cross-request BEGIN/ROLLBACK test failed, and the reason matters:
				// DO SQLite commits its implicit transaction at the END OF EACH EVENT,
				// so a BEGIN in one fetch() is already committed before the ROLLBACK
				// arrives in the next. Drupal's transactions all live inside one
				// request, which -- because PHP runs inside the DO -- is one event, so
				// this is the shape that actually needs to work.
				case '/__txn': {
					const body = await request.json<{ mode?: string }>();
					const before = this.sql
						.exec<{ c: number }>('SELECT COUNT(*) AS c FROM node')
						.toArray()[0]?.c;
					let mode = body.mode;
					let threw: string | null = null;
					if (mode === 'sql') {
						// explicit SQL transaction control, all within this one event
						try {
							this.sql.exec('BEGIN');
							this.sql.exec(
								"INSERT INTO node (nid, title, created) VALUES (901, 'doomed-sql', 1)"
							);
							this.sql.exec('ROLLBACK');
						} catch (e: any) {
							threw = String(e?.message ?? e).slice(0, 120);
						}
					} else if (mode === 'transactionSync') {
						// the documented DO mechanism: throwing inside rolls back
						try {
							this.ctx.storage.transactionSync(() => {
								this.sql.exec(
									"INSERT INTO node (nid, title, created) VALUES (902, 'doomed-sync', 1)"
								);
								throw new Error('deliberate abort');
							});
						} catch (e: any) {
							threw = String(e?.message ?? e).slice(0, 120);
						}
					} else if (mode === 'transactionSyncCommit') {
						this.ctx.storage.transactionSync(() => {
							this.sql.exec(
								"INSERT INTO node (nid, title, created) VALUES (903, 'kept', 1)"
							);
						});
					}
					const after = this.sql
						.exec<{ c: number }>('SELECT COUNT(*) AS c FROM node')
						.toArray()[0]?.c;
					return Response.json({
						mode,
						before: Number(before),
						after: Number(after),
						threw,
						rolledBack: Number(before) === Number(after)
					});
				}

				case '/__txnreplay': {
					const body = await request.json();
					return Response.json(encode(this.execTxn(decode(body) as TxnRequest)));
				}

				case '/__keepwarm': {
					return Response.json(await this.scheduleKeepWarm());
				}

				case '/__stats':
					return Response.json({
						queryCount: this.queryCount,
						txnCount: this.txnCount ?? 0,
						txnStatements: this.txnStatements ?? 0,
						txnSpeculative: this.txnSpeculative ?? 0,
						databaseSize: this.sql.databaseSize,
						gate: this.gate.stats()
					});
				default:
					return new Response('not found\n', { status: 404 });
			}
		}
	}
}

/**
 * Rewrites `:name` placeholders to positional `?`, because `ctx.storage.sql`
 * has no named-parameter support.
 *
 * String literals and comments are skipped, so a `:` inside `'a:b'` or a
 * `-- :note` is left alone. Naive `str_replace`-style substitution corrupts
 * those, and Drupal emits both.
 */
export function toPositional(
	sql: string,
	params?: SqlBindings
): { text: string; values: unknown[] } {
	if (!params || (Array.isArray(params) && params.length === 0)) {
		return { text: sql, values: [] };
	}

	// already positional
	if (Array.isArray(params)) return { text: sql, values: params };

	const values: unknown[] = [];
	let out = '';
	let i = 0;

	while (i < sql.length) {
		const c = sql[i];

		// single-quoted literal, with '' escape
		if (c === "'") {
			const start = i++;
			while (i < sql.length) {
				if (sql[i] === "'" && sql[i + 1] === "'") {
					i += 2;
					continue;
				}
				if (sql[i] === "'") {
					i++;
					break;
				}
				i++;
			}
			out += sql.slice(start, i);
			continue;
		}

		// double-quoted identifier
		if (c === '"') {
			const start = i++;
			while (i < sql.length && sql[i] !== '"') i++;
			i++;
			out += sql.slice(start, i);
			continue;
		}

		// line comment
		if (c === '-' && sql[i + 1] === '-') {
			const start = i;
			while (i < sql.length && sql[i] !== '\n') i++;
			out += sql.slice(start, i);
			continue;
		}

		// block comment
		if (c === '/' && sql[i + 1] === '*') {
			const start = i;
			i += 2;
			while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
			i += 2;
			out += sql.slice(start, Math.min(i, sql.length));
			continue;
		}

		// ::cast -- consume BOTH colons, or the scanner reads the second one as the
		// start of a placeholder and "x::text" binds a phantom :text
		if (c === ':' && sql[i + 1] === ':') {
			out += '::';
			i += 2;
			continue;
		}

		// :placeholder
		if (c === ':') {
			let j = i + 1;
			// the `j < sql.length` guard on the same line is what makes the index defined
			while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j] as string)) j++;
			if (j > i + 1) {
				const name = sql.slice(i, j);
				const bare = name.slice(1);
				const has = Object.prototype.hasOwnProperty.call(params, name)
					? name
					: Object.prototype.hasOwnProperty.call(params, bare)
						? bare
						: null;
				if (has === null) {
					throw new Error(`missing binding for ${name}`);
				}
				values.push(params[has]);
				out += '?';
				i = j;
				continue;
			}
		}

		out += c;
		i++;
	}

	return { text: out, values };
}

/**
 * Thrown when a value would be stored exactly and read back wrong.
 */
export class UnreadableIntegerError extends Error {
	value: string;

	constructor(value: bigint) {
		super(
			`Refusing to store ${value}: ctx.storage.sql returns INTEGER columns as JS doubles, so any magnitude above 2^53-1 (9007199254740991) reads back altered -- 9007199254740993 comes back as 9007199254740992. The write would succeed and the read would silently lie. Store it as TEXT, or split it, or read it back only via CAST(col AS TEXT).`
		);
		this.name = 'UnreadableIntegerError';
		this.value = String(value);
	}
}

/**
 * Makes one parameter acceptable to `ctx.storage.sql.exec()`, or refuses it.
 *
 * Two separate platform facts meet here, and the second is why this rejects
 * rather than converts:
 *
 * 1. WRITE. `ctx.storage.sql.exec()` refuses a BigInt outright -- measured,
 *    "Cannot convert a BigInt value to a number" -- and the codec produces one for
 *    every integer beyond Number.MAX_SAFE_INTEGER. A decimal string does survive,
 *    and lands as an INTEGER because SQLite applies the column's affinity:
 *    `typeof(col)` returns "integer" and `WHERE col = '<digits>'` matches.
 * 2. READ. But the cursor hands INTEGER columns back as JS doubles, so a value
 *    above 2^53 is already wrong before this file or the codec can see it:
 *    9007199254740993 reads back as ...992, while `CAST(col AS TEXT)` is exact.
 *
 * So converting a wide BigInt to a string would store it perfectly and read it
 * back altered, with nothing raised -- the silent-wrongness failure mode this
 * project has now hit eight times. Refusing turns it into one loud error at the
 * write, for the narrow case that would ever hit it (Drupal core never stores
 * integers that wide; 64-bit ids in contrib do). Fixing the read side instead
 * would mean rewriting every SELECT's column list as CAST(col AS TEXT) using
 * PRAGMA table_info schema knowledge the driver does not have at query time.
 *
 * NOT covered, deliberately, because it cannot be told apart from a legitimate
 * TEXT value: a wide integer bound as a decimal STRING by PHP. Core's
 * expandArguments() rejects codec envelopes, so that is how wide integers travel
 * into a query today (see DRIVER-NOTES.md "Integer safety"). That path still
 * stores exactly and reads back altered. Rejecting all long numeric strings would
 * break every TEXT column holding digits.
 */
export function bindable(value: unknown): unknown {
	if (typeof value !== 'bigint') return value;
	if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new UnreadableIntegerError(value);
	}
	// inside the safe range it round-trips exactly, so a plain number is honest
	return Number(value);
}

function rowidOf(sql: SqlStorage): number {
	try {
		return sql.exec<{ id: number }>('SELECT last_insert_rowid() AS id').toArray()[0]?.id ?? 0;
	} catch {
		return 0;
	}
}

function changesOf(sql: SqlStorage): number {
	try {
		return sql.exec<{ c: number }>('SELECT changes() AS c').toArray()[0]?.c ?? 0;
	} catch {
		return 0;
	}
}
