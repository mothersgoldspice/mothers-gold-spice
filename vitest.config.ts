/**
 * Test runner: Vitest inside the real Workers runtime.
 *
 * The suite runs on `@cloudflare/vitest-pool-workers`, which boots workerd with
 * the bindings from `wrangler.jsonc` — so the integration tests talk to a REAL
 * local D1 with the real `migrations/*.sql` applied, not a SQLite lookalike.
 * That matters here because the inventory and order code leans on D1 specifics:
 * `batch()` atomicity, conditional UPDATEs reporting `meta.changes`, and
 * `RETURNING` on an UPDATE. A better-sqlite3 stand-in would happily pass tests
 * for code that could not work on the platform it ships to.
 *
 * Nothing here fetches the Worker over `SELF`: the tests drive services through
 * an `AppContext`, which is the same object src/middleware.ts hands the routes.
 *
 * Only `DB` and `TEST_MIGRATIONS` are taken from this config. The environment
 * the services see is built in tests/setup.ts instead, because wrangler.jsonc
 * carries the PRODUCTION vars and a developer's gitignored .dev.vars overrides
 * them — a suite that read either would pass on one machine and fail on a fresh
 * clone. The `Env` handed to `AppContext` is therefore written out in full.
 */

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// `node:path` would need @types/node, which this project deliberately does not
// carry — the runtime is workerd, not Node. A file URL relative to this config
// gives the same absolute path with no extra dependency.
const migrationsPath = decodeURIComponent(new URL('./migrations', import.meta.url).pathname);

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // Keeps one test file's writes out of the next one's database. It does
      // NOT roll back between individual tests, which is why every test file
      // starts from `freshDatabase()` in a `beforeEach` rather than trusting it.
      isolatedStorage: true,
      // One worker for the whole suite: files run through it in sequence, so
      // two of them can never be writing to the same D1 at the same moment.
      singleWorker: true,
      wrangler: { configPath: './wrangler.jsonc' },
      // Overrides wrangler.jsonc's `main`. See tests/worker.ts for why.
      main: './tests/worker.ts',
      miniflare: {
        // Read here, in Node, and handed over as a binding: the test isolate has
        // no filesystem of its own to read `migrations/` from.
        bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsPath) },
      },
    })),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Services log a JSON line per event. Keep the output for a failing test,
    // drop it for a passing one.
    silent: 'passed-only',
  },
});
