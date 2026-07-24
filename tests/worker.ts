/**
 * The Worker entrypoint the test pool loads alongside the tests.
 *
 * It exists only to keep the pool from loading the one named in wrangler.jsonc,
 * `dist/_worker.js/index.js` — the built Astro bundle, which pulls in a WASM
 * module that workerd refuses to compile inside the test isolate ("Wasm code
 * generation disallowed by embedder") and reports as an unhandled rejection on
 * every run.
 *
 * Nothing in the suite fetches it: the tests drive services through an
 * `AppContext`, exactly as src/middleware.ts does for a real request. Hitting
 * this handler means a test tried to go over HTTP, which is a mistake worth
 * making loud rather than silently answering 200.
 */

/*
 * Deliberately untyped by `ExportedHandler`.
 *
 * That type describes its `Response` as the workers-types one, while the
 * `Response` this file constructs is the ambient DOM/undici class the project
 * otherwise uses — structurally different (`webSocket`), so `satisfies` fails.
 * Importing workers-types globally to reconcile them is what env.d.ts explains
 * we must not do: it also merges HTMLRewriter's `Element` with the DOM's and
 * breaks every client script that builds a node. A stub with one method is not
 * worth either compromise.
 */
export default {
  fetch(): Response {
    return new Response('Tests drive services directly through AppContext, not over HTTP.', { status: 501 });
  },
};
