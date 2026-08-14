import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** resolves a path inside the sibling cartridge working copy */
const sibling = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	test: {
		name: 'unit',
		environment: 'node',
		include: ['tests/**/*.spec.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: ['src/**'],
			exclude: ['tests/**', '**/*.d.ts']
		}
	}
});
