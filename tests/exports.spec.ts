import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import * as codecModule from '../src/codec.js';
import * as doSqliteModule from '../src/do-sqlite.js';
import * as indexModule from '../src/index.js';
import tsconfigSource from '../tsconfig.json?raw';
import vitestSource from '../vitest.config.ts?raw';

/**
 * The subpath map, checked against the modules it names.
 *
 * A test and not a review item, because an `exports` map is the one part of a package that
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
		// true here because module scope is declarations only and PHP_CODEC is a String.raw
		// literal; cartridge needs an array instead, since dropping its shim deletes a patch
		expect(pkg.sideEffects).toBe(false);
	});

	it('ships src, the licence and the README, and nothing else', () => {
		expect(pkg.files).toEqual(['src', 'LICENSE', 'README.md']);
	});

	it('is in the 0.x beta window the rest of the project sits in', () => {
		expect(pkg.version).toMatch(/^0\./);
	});
});

describe('how @drupflare/cartridge resolves', () => {
	/**
	 * One resolution, in every environment; this spec exists because there were two.
	 *
	 * `tsconfig.json` carried a `paths` entry aimed at `../cartridge/src`, so `bun run typecheck`
	 * read the sibling working copy while `bun run test` read the installed tarball. Measured by
	 * renaming `Gate` in the sibling: the typecheck failed with TS2305 and all 122 tests passed.
	 * In CI the sibling does not exist, so the mapping fell through to node_modules and the two
	 * lanes agreed again -- which made the divergence a property of the machine rather than of
	 * the code.
	 *
	 * The version range plus renovate is the drift mechanism now: a cartridge release produces a
	 * bump PR and this repo's gate runs against the new version before it merges.
	 */
	it('is a real dependency with a range, not a path mapping', () => {
		expect((pkg.dependencies as Record<string, string>)['@drupflare/cartridge']).toMatch(
			/^\^?0\./
		);
	});

	it('is aliased by no build config, so every lane reads node_modules', () => {
		expect(tsconfigSource).not.toContain('"paths"');
		expect(tsconfigSource).not.toContain('../cartridge');
		// vitest resolves it the same way; an alias here would put the runtime lane back on a
		// different copy than the typecheck lane
		expect(vitestSource).not.toContain('../cartridge');
		expect(vitestSource).not.toContain('alias');
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
