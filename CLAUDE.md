# durabledb

A host for **Cloudflare Durable Object SQLite** that encodes the platform's real limits, plus the
codec that makes values survive the round trip. Extracted from `drupflare/worker`, where it backs a
Drupal 11 database driver, but nothing here is Drupal-specific.

## Status

**Published** at `@drupflare/durabledb@0.1.3`, and **green**. `bun run typecheck` is clean and the
suite reports **124 assertions passing** at a measured **99.61% of statements**, 94.24% of branches.
The release sequence is maintainer-only.

**`release.yml` publishes to npm and to GitHub Packages, and the GitHub half used to fail silently.**
`setup-node` writes ONE host-scoped credential line, `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`,
and npm matches `_authToken` by registry host. So `npm publish --registry https://npm.pkg.github.com`
carried no credential no matter what `NODE_AUTH_TOKEN` was set to in that step's `env`, and the result
was swallowed by a `||` that reported every failure as "most likely already present" and exited 0.
There is now a second `setup-node` with `registry-url: https://npm.pkg.github.com` and
`scope: '@drupflare'`, an existence check symmetric with the npm one, and a bare `npm publish` that is
allowed to fail the job. **Never route a publish at another registry with `--registry` alone**; give
that host its own `setup-node`, and never wrap a publish in `||`. `drupflare/cartridge` carries the
same fix.

The old blocker is closed. `src/do-sqlite.ts:1-2` used to import a bare `cartridge` specifier that
resolved to nothing, which cost 2 `TS2307` errors and blocked the whole `do-sqlite` spec. It now
imports two SUBPATHS of the real package name:

```ts
import { Gate } from '@drupflare/cartridge/gate';
import { withMask } from '@drupflare/cartridge/mask';
```

**Only those two, never the root entry**, and the reason is a real constraint rather than taste: the
root pulls `lazy-fs.ts`, which imports `fflate`, and `fflate` is not a dependency here. `./gate`
(`serialize.ts`) and `./mask` (`mask.ts`) import nothing at all.

**The dependency comes from npm, and the path mappings that used to supply it are gone.**
`package.json` declares `"@drupflare/cartridge": "^0.2.0"` under `dependencies`; `tsconfig.json` has no
`paths` and `vitest.config.ts` has no `resolve.alias`. Two specs in `tests/exports.spec.ts` hold that
down -- one that the range is real, one that neither build config mentions `../cartridge` -- so this
does not need re-deriving from the files.

**Why it is pinned rather than left to convention: an alias silently wins over `node_modules`.** A
stale one leaves this repo typechecked and tested against whatever happens to be in a sibling
directory, and in CI, where the sibling does not exist, the mapping falls through and the two lanes
agree again -- which makes the divergence a property of the machine rather than of the code. The
version range plus renovate is the drift mechanism now: a cartridge release opens a bump PR and this
repo's gate runs against the new version before it merges.

`codec.ts` and `do-sqlite.ts` also still exist in `drupflare/worker`, with **no sync check between
the two copies**. In the parent project that exact shape of duplication went silently stale twice.
Decide the direction of truth before editing either side.

## The spec that arrived from cartridge

The last describe in `tests/do-sqlite.spec.ts` - "the wiring: the SQL bridge in src/do-sqlite.ts" -
was parked in `cartridge/tests/_needs-rewrite/` because it asserts on
`SiteDurableObject.prototype.installBridge` AND cartridge's mask singleton at once, and the specifier
did not resolve. It is folded into the existing spec rather than given its own
`do-sqlite-bridge.spec.ts`: one domain, one spec file. **Its assertions are unchanged from the parked
copy** - only the import specifier moved, from the root entry to `@drupflare/cartridge/mask`. Do not
weaken it; the original still runs in `worker/tests/unit/runtime/mask.spec.ts`.

## The limits, all measured, each one broke something real

| limit                          | value                |
| ------------------------------ | -------------------- |
| bound parameters per statement | **100**              |
| LIKE / GLOB pattern length     | **50 bytes**         |
| bytes per record               | **2,199,995**        |
| statement text                 | **100,000 chars**    |
| integer reads                  | **lossy above 2^53** |

These are not conservative guesses. The 100-parameter ceiling broke the cache write path. The 50-byte
LIKE ceiling binds **plain `LIKE`**, not just `GLOB`. Integers above 2^53 come back wrong rather than
erroring, which is the worst failure shape available and is why the codec exists at all.

**"There is no smaller unit than a row" is false.** Three 520 KB rows each overran the record cap and
looked indivisible; SQLite builds a value across statements with `col = col || ?`. That was this
project's own unverified claim, believed for a while.

## Rules

- **Never widen a limit because a test passes.** These came from a deployed object. If you think one
  is wrong, re-measure on a deployed worker and say so; do not relax a guard.
- The codec's encode/decode must round-trip. A codec that can decode a type it cannot encode is a bug
  to fix, not a test to skip.
- Fail with a **named** refusal rather than truncating. A silently truncated value is indistinguishable
  from correct output until much later.
- **`./codec` must keep importing nothing.** It is a subpath so a consumer can take the codec without
  installing cartridge; the first import added to `src/codec.ts` withdraws that promise silently, since
  nothing in this repo resolves the map. `tests/exports.spec.ts` pins the map, `files` and
  `sideEffects`; the import graph is checked against a real install as part of the release checks.

## Conventions

- `bunx`, never `npx`.
- Imports use a `.js` specifier even for `.ts` files. bun resolves this; `node` does not.
- One runtime dependency, once it can be declared: `@drupflare/cartridge`, and only its `/gate` and
  `/mask` subpaths. Never the root entry, which pulls `fflate` through `lazy-fs.ts`.
- Comments: lowercase, terse, one line, no trailing period, only where the WHY is non-obvious.

## Measurement discipline inherited from the parent project

An absolute CPU figure on Cloudflare comes only from `cpuTime` in `wrangler tail` on a **deployed**
worker. `Date.now()` inside the isolate returns 0 on the edge. `wrangler tail` silently omits
`durableObject` events unless asked, so an empty tail proves nothing.
