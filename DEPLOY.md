# Publishing mothersgoldspice.com

Your site is built with **Astro** and will be hosted free on **Cloudflare Pages**
(your domain is already on Cloudflare, so this is the smoothest path).

---

## 1. Preview locally

```bash
npm install --cache /tmp/npm-cache-mgs   # only needed once
npm run dev
```

Open http://localhost:4321 — you should see the site.

Edit any file under `src/` and the page reloads automatically.

> If you ever hit the npm permissions error again, run this one-time fix:
> `sudo chown -R 501:20 "$HOME/.npm"`

---

## 2. Push the code to GitHub

Cloudflare Pages deploys from a GitHub repo. One-time setup:

```bash
git init
git add .
git commit -m "Initial site"
```

Then create an empty repo at https://github.com/new (e.g. `mothers-gold-spice`),
and push:

```bash
git remote add origin https://github.com/<your-username>/mothers-gold-spice.git
git branch -M main
git push -u origin main
```

---

## 3. Connect Cloudflare Pages

1. Log in at https://dash.cloudflare.com with **raniketram@gmail.com**.
2. Left sidebar → **Workers & Pages** → **Create** → **Pages** tab → **Connect to Git**.
3. Authorize GitHub and pick the `mothers-gold-spice` repo.
4. On the build settings screen, use:
   - **Framework preset:** Astro
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
5. Click **Save and Deploy**. First build takes ~1 minute.

You'll get a temporary URL like `mothers-gold-spice.pages.dev` — open it to confirm
the deploy worked.

---

## 4. Point mothersgoldspice.com at it

Still in Cloudflare Pages:

1. Open your new Pages project → **Custom domains** tab → **Set up a custom domain**.
2. Type `mothersgoldspice.com` and click through. Cloudflare auto-creates the DNS
   records because your domain is on the same account.
3. Add `www.mothersgoldspice.com` the same way (so both versions work).

Wait 1–2 minutes. Visit https://mothersgoldspice.com — you're live.

---

## 5. Updating the site

After the first setup, the loop is:

```bash
# edit files in src/
git add .
git commit -m "describe the change"
git push
```

Every push to `main` auto-deploys in ~30 seconds.

---

## Where to make changes

| What to change                     | File                              |
|------------------------------------|-----------------------------------|
| Hero headline / tagline            | `src/components/Hero.astro`       |
| The story / about section          | `src/components/Story.astro`      |
| Product details (weight, price)    | `src/components/Product.astro`    |
| "Where to buy" + email signup      | `src/components/WhereToBuy.astro` |
| Footer, social links, contact      | `src/components/Footer.astro`     |
| Page title / SEO description       | `src/layouts/Layout.astro`        |
| Colors, fonts                      | `src/styles/global.css`           |

To add real product photos, drop them in `public/` (e.g. `public/jar.jpg`)
and replace the placeholder `<div>` in `Hero.astro` / `Product.astro` with
`<img src="/jar.jpg" alt="..." class="..." />`.

---

## What's next (when you're ready)

The Astro setup lets us grow into a real shop without rewriting:

- **Inventory & supplier admin** → add Cloudflare D1 (free SQLite) and a few
  admin pages under `src/pages/admin/`.
- **Email signups** → wire the form to Cloudflare Workers + a free MailerLite/Resend account.
- **Online checkout** → add Razorpay or Stripe via a small API route.

When you're ready for any of this, just ask.
