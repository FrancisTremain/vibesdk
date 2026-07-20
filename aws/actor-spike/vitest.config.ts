import { defineConfig } from 'vitest/config';

// Standalone config, deliberately not extending the root repo's
// vitest.config.ts (which configures @cloudflare/vitest-pool-workers for
// the Cloudflare Worker codebase this spike has nothing to do with).
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
	},
});
