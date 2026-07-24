/**
 * Scheduled maintenance trigger.
 *
 * This is a second, deliberately tiny Worker whose only job is to call
 * `POST /api/cron/maintenance` on the storefront every few minutes.
 *
 * It exists because Cloudflare Cron Triggers invoke a Worker's `scheduled()`
 * export, and the Astro Cloudflare adapter generates the storefront's entry
 * point itself — there is no supported hook to add a second export to it. Rather
 * than fork the adapter's output (which would silently break on its next
 * upgrade), the trigger lives here and the work stays in the storefront where
 * the database binding and the providers already are.
 *
 * Deploy separately:
 *   cd workers/cron
 *   npx wrangler secret put CRON_SECRET     # same value as the storefront's
 *   npx wrangler deploy
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMaintenance(env));
  },

  /**
   * Also reachable over HTTP so an operator can force a run — and so the
   * deployment can be checked without waiting for the next tick. Guarded by the
   * same secret as the endpoint it calls.
   */
  async fetch(request, env) {
    const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!env.CRON_SECRET || presented !== env.CRON_SECRET) {
      return new Response('Not authorised.', { status: 401 });
    }
    const result = await runMaintenance(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: result.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

async function runMaintenance(env) {
  const target = `${(env.SITE_URL ?? '').replace(/\/$/, '')}/api/cron/maintenance`;

  try {
    const request = new Request(target, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    // Go through the service binding rather than the public URL. Cloudflare
    // refuses a Worker-to-Worker request on the same zone — a plain fetch to the
    // storefront's workers.dev address fails with error 1042 — and a binding is
    // faster anyway: it dispatches in-process with no DNS, TLS or network hop.
    const res = env.STOREFRONT ? await env.STOREFRONT.fetch(request) : await fetch(request);
    const body = await res.text();

    // One line per run, so `wrangler tail` on this worker is a maintenance log.
    console.log(
      JSON.stringify({
        level: res.ok ? 'info' : 'error',
        message: 'cron.maintenance',
        status: res.status,
        target,
        body: body.slice(0, 500),
      }),
    );
    return { ok: res.ok, status: res.status, body: body.slice(0, 2000) };
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'cron.maintenance_unreachable',
        target,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
