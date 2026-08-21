/**
 * Vite's `?raw` suffix, for a spec that reads a config file as text.
 *
 * `tsconfig.json` sets `types: ["@cloudflare/workers-types"]` and there is no `@types/node`, so
 * `import { readFileSync } from 'node:fs'` in this directory is a TS2307. `?raw` is resolved at
 * transform time instead, which is how `tests/exports.spec.ts` asserts that no build config
 * aliases `@drupflare/cartridge`.
 */
declare module '*?raw' {
	const src: string;
	export default src;
}
