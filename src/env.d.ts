/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

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
