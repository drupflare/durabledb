import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import * as codecModule from '../src/codec.js';
import * as doSqliteModule from '../src/do-sqlite.js';
import * as indexModule from '../src/index.js';

/**
 * The subpath map, checked against the modules it names.
 *
 * WHY THIS IS A TEST AND NOT A REVIEW ITEM. An `exports` map is the one part of a package that
 * nothing else in the repository reads: `tsc` resolves relative specifiers, vitest resolves
 * relative specifiers, and the map is only exercised the first time a CONSUMER installs the
 * package. So a typo in it is invisible until publication, which is the worst possible moment.
 *
 * The targets are checked by IMPORTING each one rather than by stat'ing the file, and that is a
 * measured constraint rather than a preference: `tsconfig.json` sets `types: ["@cloudflare/workers-types"]`
 * and there is no `@types/node`, so `import { readFileSync } from 'node:fs'` in this directory is a
 * TS2307 -- verified, not assumed. Importing proves the same thing anyway, because a target naming a
 * file that does not exist would fail this file's own imports.
 */

/** each public subpath, its declared target, and a symbol that must be reachable through it */
const SUBPATHS: Array<[string, string, Record<string, unknown>, string]> = [
	['.', './src/index.ts', indexModule, 'encode'],
	['./codec', './src/codec.ts', codecModule, 'encode'],
	['./do-sqlite', './src/do-sqlite.ts', doSqliteModule, 'SiteDurableObject']
];

describe('the package exports map', () => {
	it.each(SUBPATHS)('%s resolves to %s and exposes %s', (subpath, target, module, symbol) => {
		expect((pkg.exports as Record<string, string>)[subpath]).toBe(target);
		expect(module[symbol]).toBeDefined();
	});

	it('declares every source module, so nothing public is unreachable by subpath', () => {
		const targets = Object.values(pkg.exports as Record<string, string>);
		expect(targets).toContain('./package.json');
		// there are exactly three modules under src/, and all three are named above. A fourth one
		// arriving without an entry is reachable only through the barrel, which is the state this
		// asserts against
		expect(targets.filter((t) => t.startsWith('./src/'))).toHaveLength(3);
	});

	it('splits ./codec out from the root ON PURPOSE, because the root needs a dependency', () => {
		// do-sqlite.ts imports @drupflare/cartridge/gate and /mask; codec.ts imports NOTHING. So the
		// root entry and ./do-sqlite need cartridge installed and ./codec does not, which is the same
		// shape as cartridge exposing ./gate and ./mask so that this repo can skip fflate
		expect((pkg.exports as Record<string, string>)['./codec']).toBe('./src/codec.ts');
		expect((pkg.exports as Record<string, string>)['./do-sqlite']).toBe('./src/do-sqlite.ts');
	});

	it('keeps main and types pointing at the root entry', () => {
		expect(pkg.main).toBe('./src/index.ts');
		expect(pkg.types).toBe('./src/index.ts');
		expect((pkg.exports as Record<string, string>)['.']).toBe(pkg.main);
	});

	it('declares NO side effect, which is a claim about every module and not a default', () => {
		// `false` says a bundler may drop any of these modules whole when nothing imports from it.
		// That is true here: module scope is class, function and const declarations only, and
		// PHP_CODEC is a String.raw literal. It is NOT the answer everywhere -- cartridge has to
		// write an ARRAY naming its worker shim, because dropping that module deletes a globalThis
		// patch. Re-check this if anything in src/ ever runs at import time
		expect(pkg.sideEffects).toBe(false);
	});

	it('ships src, the licence and the README, and nothing else', () => {
		expect(pkg.files).toEqual(['src', 'LICENSE', 'README.md']);
	});

	it('is in the 0.x beta window the rest of the project sits in', () => {
		expect(pkg.version).toMatch(/^0\./);
	});

	it('declares no runtime dependency yet, which is the PRE-PUBLICATION state', () => {
		// @drupflare/cartridge is imported by do-sqlite.ts and deliberately NOT declared here: it is
		// unpublished, and declaring it makes `bun install --frozen-lockfile` fail with a registry
		// 404 on every CI run. The cost is real -- the root entry and ./do-sqlite are unresolvable
		// for a consumer until it is declared -- so `bun add @drupflare/cartridge` is a publish-time
		// step and this assertion is the tripwire that says so; the release sequence covers it
		expect((pkg as Record<string, unknown>).dependencies).toBeUndefined();
	});
});

describe('the root entry', () => {
	it('re-exports every public module', () => {
		for (const [, , module] of SUBPATHS) {
			for (const name of Object.keys(module)) {
				if (name === 'default') continue;
				expect(indexModule).toHaveProperty(name);
			}
		}
	});

	it('resolves encode/decode to one pair despite two star re-exports', () => {
		// index.ts is two `export *` lines; two DECLARATIONS sharing a name would make it ambiguous
		// and silently drop the name from the root entry rather than erroring
		expect(indexModule.encode).toBe(codecModule.encode);
		expect(indexModule.decode).toBe(codecModule.decode);
		expect(indexModule.SiteDurableObject).toBe(doSqliteModule.SiteDurableObject);
	});
});
