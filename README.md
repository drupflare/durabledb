# 🗄️ durabledb

> The real limits of Cloudflare Durable Object SQLite, encoded rather than documented

[![Build](https://github.com/drupflare/durabledb/actions/workflows/build.yml/badge.svg)](https://github.com/drupflare/durabledb/actions/workflows/build.yml)
[![Prettier](https://github.com/drupflare/durabledb/actions/workflows/prettier.yml/badge.svg)](https://github.com/drupflare/durabledb/actions/workflows/prettier.yml)
[![codecov](https://codecov.io/gh/drupflare/durabledb/branch/master/graph/badge.svg)](https://codecov.io/gh/drupflare/durabledb)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A `ctx.storage.sql` host and a value codec that encode what the platform actually does, not
what SQLite documents.** `ctx.storage.sql` caps a statement at 100 bound parameters where
local PDO allows 32,766, refuses a `LIKE` pattern over 50 bytes, has **no named parameters
at all**, and reads integers above **2^53** lossily. Every one of those is a measured refusal
from a deployed object, and every one has produced a defect that a local SQLite passed.

---

## 📋 Table of Contents

- [Why](#-why)
- [Install](#-install)
- [Limits](#-limits)
- [Codec](#-codec)
- [Bridge Contract](#-bridge-contract)
- [API](#-api)
- [Testing](#-testing)
- [Related Repositories](#-related-repositories)
- [License](#-license)

---

## 🎯 Why

A Durable Object's SQLite is a genuinely good home for a small database: strongly consistent,
in the same isolate as the code, and synchronous to read so blocking callers compose with it.
Then you write against it as though it were SQLite and it refuses things SQLite does not.

The refusals are not documented as a set, they are not tunable, and each one fails in a
different register — a thrown error for the parameter cap, a **silently wrong number** for a
wide integer. A value that comes back wrong rather than erroring cannot be told apart from correct
output until much later.

So the limits live in code, as named constants and named refusals, with a test per limit.

---

## 📥 Install

```sh
bun add @drupflare/durabledb
```

Three entry points, and the split is not cosmetic:

| Import                           | Gives you                                       | Needs `@drupflare/cartridge` |
| -------------------------------- | ----------------------------------------------- | ---------------------------- |
| `@drupflare/durabledb`           | everything below                                | **yes**                      |
| `@drupflare/durabledb/codec`     | `encode`, `decode`, `codecGuard`, `PHP_CODEC`   | no                           |
| `@drupflare/durabledb/do-sqlite` | `SiteDurableObject`, `toPositional`, `bindable` | **yes**                      |

`src/do-sqlite.ts` imports `@drupflare/cartridge/gate` and `/mask`; `src/codec.ts` imports nothing at
all, so a consumer that only needs the codec pays for no dependency. There is no deep import: the
`exports` map is the whole surface, and `@drupflare/durabledb/src/codec.ts` is refused by the
resolver.

---

## 🧱 Limits

Each one broke something real. None is a conservative guess.

| Limit                          | Value                | What it broke                                                           |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------- |
| bound parameters per statement | **100**              | the cache write path; a cold `cache_discovery` set needed 574           |
| `LIKE` / `GLOB` pattern length | **50 bytes**         | binds **plain `LIKE`**, not only `GLOB`, so it is invisible to a caller |
| bytes per record               | **2,199,995**        | a heap snapshot row                                                     |
| statement text                 | **100,000 chars**    | a chunked DDL replay                                                    |
| integer reads                  | **lossy above 2^53** | wrote `9007199254740993`, read back `9007199254740992`                  |
| named parameters               | **none exist**       | every Drupal query; `toPositional()` converts them                      |

Two carry a further consequence:

**Writing a wide integer is exact; reading one is not.** `ctx.storage.sql` hands INTEGER columns
back as JS doubles, so the precision is gone before any consumer can see it. `CAST(col AS TEXT)`
returns every digit, so the storage is fine — the loss is in the cursor. `UnreadableIntegerError`
exists to make that a refusal rather than a wrong answer.

**"There is no smaller unit than a row" is false**, and it was this project's own unverified
claim, believed for a while. Three 520 KB rows each overran the record cap and looked
indivisible; SQLite builds a value across statements with `col = col || ?`.

> [!WARNING]
> **Never widen a limit because a test passes.** These came from a deployed object, and a local
> SQLite will happily accept all of them. If you think one is wrong, re-measure on a deployed
> worker and say so. Do not relax a guard.

---

## 🔁 Codec

The consumer runtime is a **32-bit** PHP wasm build (`PHP_INT_SIZE` is 4), so any JS number at
or above 2^31 wraps silently on the way in. Measured: `Date.now()` arrived in PHP as
`-397708726` instead of ~1.78e12. Two instances were found separately, a timestamp and a node
id — and finding two separately means the class was still open.

The obvious fix, stringifying anything unsafe, **is lossy in the other direction.** PHP receives
`"1780000000000"` and cannot tell whether that was an integer too large to represent or a
genuine string; sending it back produces a string where a number belongs, and the corruption
reappears one hop later.

So values that cannot cross natively are wrapped in a tagged envelope instead of flattened, and
`decode()` is the exact inverse of `encode()`:

| Envelope                         | Carries                                |
| -------------------------------- | -------------------------------------- |
| `{__t: 'i', v: '1780000000000'}` | integer outside 32-bit range           |
| `{__t: 'n', v: '1.5e300'}`       | non-finite or precision-risky float    |
| `{__t: 'd', v: '1780000000000'}` | `Date`                                 |
| `{__t: 'b', v: '<base64>'}`      | bytes                                  |
| `{__t: 'u'}`                     | `undefined`, which PHP has no word for |

Anything representable on both sides crosses unwrapped, so the common path costs nothing.

---

## 🔗 Bridge Contract

Two entry points, and the second is the interesting one.

```ts
execSql(sql: string, params?: SqlBindings): ExecSqlResult
execTxn(req: TxnRequest): ExecTxnResult
```

`execTxn` runs a list of statements inside one `ctx.storage.transactionSync()`, optionally with
a trailing read. `commit: false` runs them, evaluates the read inside the same transaction, then
throws a private sentinel so the runtime rolls back — and **still returns the results**, which
is what makes a speculative row count and insert id possible.

`ExecTxnResult` is a discriminated union rather than one shape with optionals: a
failed replay has already been rolled back, so there are no results to read, and the
discriminant is what stops a caller reading them anyway.

---

## 🔧 API

| Export                                          | What it is                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `SiteDurableObject`                             | the Durable Object; `execSql`, `execTxn`, `installBridge`, `nowMs`   |
| `encode` / `decode`                             | the codec, exact inverses of each other                              |
| `codecGuard(host)`                              | wraps a host surface so every value crossing it is encoded           |
| `PHP_CODEC`                                     | the PHP half of the codec, as source, for hosts that evaluate it     |
| `toPositional(sql, params)`                     | rewrites named parameters, because the engine has none               |
| `bindable(value)`                               | the one value transform `sql.exec()` needs; a JS `BigInt` is refused |
| `UnreadableIntegerError`                        | a read above 2^53, refused rather than answered wrongly              |
| `ExecSqlResult`                                 | `{ rows, rowsRead, rowsWritten, lastInsertRowid, changes }`          |
| `TxnRequest` / `TxnStatement` / `ExecTxnResult` | the replay contract above                                            |
| `SqlBindings`                                   | `unknown[] \| Record<string, unknown> \| null`                       |

---

## 🧪 Testing

```sh
bun run typecheck
bun run test # 87 assertions across 3 specs
bun run test:coverage
```

**87 passing, 0 failed**, at a measured **61.68% statements** (`codec.ts` 82.29%, `do-sqlite.ts`
49.69% — the Durable Object routes and `alarm()` need a real `ctx.storage.sql`, so they are covered
in the consumer rather than here). The lane runs in **node**, not workerd, and coverage uses `provider: 'v8'`
rather than `istanbul`. The sibling repositories split on exactly that axis: a workerd lane must use
istanbul, because the v8 provider reads coverage off the Node inspector and attributes zero from
inside the isolate; a node lane uses v8.

Two rules the suite is built on:

- **The codec must round-trip.** A codec that can decode a type it cannot encode is a bug to fix,
  not a test to skip.
- **Fail with a named refusal rather than truncating.** A silently truncated value cannot be told
  apart from correct output until much later.

---

## 🔗 Related Repositories

| Repository                                                      | What it is                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`drupflare/worker`](https://github.com/drupflare/worker)       | the consumer: Drupal 11 on Cloudflare Workers                                |
| [`drupflare/rom`](https://github.com/drupflare/rom)             | `composer require drupflare/rom:0.*` — the Drupal 11 driver that sits on top |
| [`drupflare/cartridge`](https://github.com/drupflare/cartridge) | the reentrancy gate and interrupt mask this package imports                  |

---

## 📄 License

MIT (c) Gregory Mitchell 2026. See [LICENSE](LICENSE).
