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
