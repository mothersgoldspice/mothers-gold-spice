# Setup & Infrastructure

Everything that powers https://mothersgoldspice.com. Last updated: 2026-05-11.

---

## At a glance

| What | Where | Details |
|------|-------|---------|
| Domain registrar | Cloudflare Registrar | `mothersgoldspice.com` owned by `raniketram@gmail.com` |
| DNS + CDN + SSL | Cloudflare | Same account as registrar |
| Site hosting | Cloudflare Workers (Static Assets) | Worker name: `mothers-gold-spice` |
| Source code | GitHub | https://github.com/mothersgoldspice/mothers-gold-spice (public) |
| Deploy trigger | Auto on `git push` to `main` | Build runs on Cloudflare |
| Production URLs | https://mothersgoldspice.com and https://www.mothersgoldspice.com | |

---

## How it fits together

```
git push to main
   │
   ▼
GitHub repo (mothersgoldspice/mothers-gold-spice)
   │   "Cloudflare Workers and Pages" GitHub App webhook fires
   ▼
Cloudflare Workers Build
   │   npm install
   │   npm run build         → produces dist/
   │   npx wrangler deploy   → uploads dist/ as static assets
   ▼
Cloudflare Worker mothers-gold-spice
   │   serves from edge (cached globally)
   ▼
mothersgoldspice.com  ←→  www.mothersgoldspice.com
```

---

## Initial setup steps (already done)

### 1. Domain
Purchased `mothersgoldspice.com` via Cloudflare Registrar. DNS is automatically managed on Cloudflare — no third-party nameservers.

### 2. GitHub account + repo
- Created GitHub account `mothersgoldspice` using `mothersgoldspice@gmail.com`.
- Created repo `mothers-gold-spice` (public).

### 3. Local Git CLI auth
The local machine's `gh` CLI is logged into two GitHub accounts:
- `illustraflow` (used for the user's other projects)
- `mothersgoldspice` (active account for this repo)

Useful commands:
```bash
gh auth status                          # show both accounts
gh auth switch -u mothersgoldspice      # make brand account active
gh auth setup-git                       # configure git credential helper to use gh
```

The auth was added via the device-code flow:
```bash
gh auth login --hostname github.com --git-protocol https --web
```

### 4. Connecting GitHub to Cloudflare
Cloudflare needs the **Cloudflare Workers and Pages** GitHub App installed on the `mothersgoldspice` account before it can deploy from there.

- App page: https://github.com/apps/cloudflare-workers-and-pages
- Install URL: https://github.com/apps/cloudflare-workers-and-pages/installations/new
- Manage current install: https://github.com/settings/installations

Common pitfall: "Add account" on Cloudflare opens GitHub's "Continue as …" page. Clicking that alone is **not enough** — you must then click the green **Install** button on the following page (which asks for repo access scope). If you skip that step, the install never completes and Cloudflare's account dropdown stays empty.

### 5. Cloudflare Worker (created via Git connection)
1. Cloudflare dashboard → **Workers & Pages** → **Create**.
2. Selected the **Pages** tab → **Connect to Git**.
3. GitHub account: `mothersgoldspice`, repo: `mothers-gold-spice`.
4. Build settings:
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy`
5. Hit **Deploy**.

This puts us on the **modern unified Workers + Static Assets flow** (NOT legacy Cloudflare Pages). The site is technically a Worker that serves static assets — but functionally it's the same as a static site.

### 6. wrangler.jsonc (repo root)
The Worker's source-controlled config:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "mothers-gold-spice",
  "compatibility_date": "2025-01-01",
  "workers_dev": false,        // disables mothers-gold-spice.raniketram.workers.dev
  "preview_urls": false,       // disables wildcard preview URLs
  "assets": {
    "directory": "./dist",     // Astro build output
    "not_found_handling": "404-page"
  }
}
```

`workers_dev` and `preview_urls` are both `false` so the only public surface is the two custom domains.

### 7. Custom domains
Added via Cloudflare → **Workers & Pages** → `mothers-gold-spice` → **Settings** → **Domains & Routes** → **Add** → **Custom domain**:

- `mothersgoldspice.com`
- `www.mothersgoldspice.com`

Because the domain lives in the same Cloudflare account, DNS records and SSL certificates were created automatically — no manual A/CNAME entries.

---

## Day-to-day workflow

### Make a change to the site
```bash
# edit any file under src/
git add .
git commit -m "describe what changed"
git push
```

Push triggers a build (~30–60 seconds). Watch it at:
**Cloudflare dashboard → Workers & Pages → mothers-gold-spice → Deployments**

### Preview locally
```bash
npm run dev      # opens http://localhost:4321
```

### Manual deploy (only if needed)
```bash
npm run build
npx wrangler deploy
```
First-time CLI deploys need `npx wrangler login` once.

### Roll back
Cloudflare dashboard → Deployments → pick a previous deployment → **Rollback**.

---

## What lives where in the code

| To change… | Edit… |
|-----------|-------|
| Hero headline / tagline | `src/components/Hero.astro` |
| About / story copy | `src/components/Story.astro` |
| Product details, size, price | `src/components/Product.astro` |
| "Where to buy" + email signup | `src/components/WhereToBuy.astro` |
| Footer, social links, contact email | `src/components/Footer.astro` |
| Page title + SEO meta | `src/layouts/Layout.astro` |
| Colors, fonts, base styles | `src/styles/global.css` |
| Deploy / Worker config | `wrangler.jsonc` |
| Static files (images, PDFs) | `public/` |

---

## Key URLs (bookmark these)

- **Site:** https://mothersgoldspice.com
- **Source repo:** https://github.com/mothersgoldspice/mothers-gold-spice
- **Cloudflare Worker dashboard:** https://dash.cloudflare.com/58dac41d0d6f735def18b86d5e024879/workers/services/view/mothers-gold-spice/production
- **GitHub App installation:** https://github.com/settings/installations

---

## Cost

Everything below currently runs on free tiers:
- **Cloudflare Workers:** 100,000 requests/day free
- **Cloudflare Static Assets:** unlimited reads, included with Workers
- **Cloudflare DNS + SSL:** free with the domain
- **GitHub public repo:** free
- **Cloudflare Registrar:** ~$10/year for the domain (no markup)

Realistically, the only recurring cost right now is the domain renewal (~$10/year).

---

## Troubleshooting

**"Cloudflare's GitHub account dropdown only shows my other account."**
The Cloudflare GitHub App isn't installed on the missing account yet. Open https://github.com/apps/cloudflare-workers-and-pages/installations/new, pick the account, and click the green **Install** button (not just "Continue as …").

**"Build fails with `wrangler: command not found`"**
Make sure `wrangler` is in `package.json` dependencies (it's installed transitively via `npx`). If you bumped Node versions, run `rm -rf node_modules && npm install`.

**"Site shows old content after a push"**
Cloudflare caches aggressively. Open the page with `?nocache=<random>` appended to bypass, or purge cache: Cloudflare dashboard → the `mothersgoldspice.com` zone → **Caching** → **Configuration** → **Purge Everything**.

**"I want to revert the last commit but it's already deployed"**
Use the Deployments → Rollback flow in Cloudflare (instant). Then fix the issue in code and push again — the rollback is automatically reset on the next deploy.
