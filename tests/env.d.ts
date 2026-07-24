/**
 * `cloudflare:test` is a virtual module the pool injects at runtime; its types
 * ship in the package but are not picked up by the project's tsconfig on their
 * own. This reference is what makes `npx tsc --noEmit -p tsconfig.json` — which
 * covers tests/ along with everything else — resolve them.
 */
/// <reference types="@cloudflare/vitest-pool-workers/types" />
