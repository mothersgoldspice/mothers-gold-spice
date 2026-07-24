import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";

// Output stays "static" so every existing marketing page keeps building to a plain
// HTML file on Cloudflare's CDN. The shop / account / admin / api routes opt into
// on-demand rendering individually with `export const prerender = false`, which is
// what the Cloudflare adapter turns into the Worker. Nothing about the brochure
// site changed shape when the order system landed.
export default defineConfig({
  site: "https://mothersgoldspice.com",
  security: {
    // Astro's own origin check is turned OFF because this app already has one,
    // in src/middleware.ts, and running two is worse than running the better one.
    //
    // Astro's version applies to any POST whose content type is form-shaped and
    // has NO exemption mechanism. Provider webhooks arrive with no Origin header
    // at all, so the day a courier or gateway posts form-encoded instead of JSON,
    // every callback would be rejected before reaching the signature check — a
    // silent, total fulfilment outage with no error on our side.
    //
    // The middleware's check is strictly stronger: it verifies Origin/Referer AND
    // a signed double-submit token, on every method and content type, with an
    // explicit exemption list for /api/webhooks/ and /api/cron/ whose
    // authenticity comes from a provider signature or a bearer secret instead.
    checkOrigin: false,
  },
  adapter: cloudflare({
    // Gives `Astro.locals.runtime.env` (D1, KV, secrets) during `astro dev` by
    // booting a local miniflare instance from wrangler.jsonc.
    platformProxy: { enabled: true },
    imageService: "passthrough",
  }),
  vite: {
    plugins: [tailwindcss()],
  },
});
