/// <reference types="astro/client" />

/*
 * There is deliberately no `/// <reference types="@cloudflare/workers-types" />`
 * here.
 *
 * That reference is global, and this project serves browsers as well as running
 * on workerd. Its HTMLRewriter `Element` interface merges with the DOM's, and
 * because a directly declared member beats an inherited one, its
 * `append`/`prepend` — which take `string | Response | ReadableStream` — shadow
 * `ParentNode`'s. Every client `<script>` that composes a node then fails to
 * typecheck against a signature that has nothing to do with the DOM.
 *
 * The handful of places that genuinely need D1Database, Fetcher and friends
 * import them by name instead: src/lib/env.ts, src/lib/db/client.ts,
 * tests/setup.ts, tests/worker.ts.
 */

type Runtime = import('@astrojs/cloudflare').Runtime<import('./lib/env').Env>;

declare namespace App {
  interface Locals extends Runtime {
    /** Per-request container built by src/middleware.ts. Absent while prerendering. */
    ctx: import('./lib/context').AppContext;
    /** Convenience mirrors so `.astro` templates stay terse. */
    user: import('./lib/context').SessionUser | null;
    csrfToken: string;
  }
}
