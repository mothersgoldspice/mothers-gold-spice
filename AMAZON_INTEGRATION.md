# Amazon Order Sync — Implementation Plan

> Status: **planning only — no code written yet.**
> Goal: when a sale happens on Amazon, automatically record it in our own database and decrement inventory, so we have one source of truth for stock across Amazon and any future channel (D2C, WhatsApp, Flipkart, etc.).

---

## Reality check

Amazon does **not** send classic HTTPS webhooks to your URL like Stripe or GitHub. The three real options:

| Option | Latency | Setup effort | Cost | Best for |
|--------|---------|--------------|------|----------|
| **1. Poll SP-API on a cron** | 5–15 min lag | Low — one Worker file | Free | Starting out |
| **2. SP-API Notifications via AWS SQS** | Near-instant | High — AWS Lambda + IAM | ~$0–5/month at low volume | Once volume grows |
| **3. Glue service (Zapier / Make.com)** | Near-instant | None — UI clicks | $20+/month after free tier | Don't want to code |

**Recommendation:** start with **Option 1**. Polling every 15 minutes is more than enough until we're doing dozens of orders a day, the code is small, and we never have to leave the Cloudflare ecosystem.

---

## Prerequisites (before any code)

1. **FSSAI license** — legally required to sell food in India.
2. **Amazon India seller account, Professional plan** — Individual plan cannot use SP-API. Pro plan is ~₹3,996/month flat.
3. **Brand registry** on Amazon (optional but helps with listing protection).
4. **Amazon developer registration** — https://developer.amazon.com → SP-API → create an SP-API app → get LWA (Login with Amazon) credentials.
5. **Self-authorize the dev app** for our seller account to get a refresh token.

Three secrets will need to live in Cloudflare:
- `AMZN_LWA_CLIENT_ID`
- `AMZN_LWA_CLIENT_SECRET`
- `AMZN_LWA_REFRESH_TOKEN`

Stored via either:
- Cloudflare dashboard → Worker → **Settings** → **Variables and Secrets** → Add (mark as secret)
- Or CLI: `npx wrangler secret put AMZN_LWA_CLIENT_ID`

---

## Architecture (Option 1)

```
Cloudflare Cron Trigger (every 15 min)
   │
   ▼
mothers-gold-spice Worker (scheduled handler)
   │
   ├─ Exchange refresh token  → access token (LWA)
   ├─ Call SP-API getOrders(CreatedAfter = last_poll_time)
   ├─ For each new order:
   │     • INSERT into D1 `orders` table
   │     • For each item: UPDATE D1 `inventory` (stock -= qty)
   │     • INSERT into D1 `inventory_events` (audit log)
   └─ UPDATE D1 `poll_state.last_poll_time = now()`
```

Everything lives inside the same Cloudflare Worker we already deployed. We're just adding a `scheduled` handler alongside the static-asset handler.

---

## Database schema (Cloudflare D1)

D1 is Cloudflare's free SQLite-compatible serverless DB. Create with `npx wrangler d1 create mothers-gold-spice`, then run this schema:

```sql
-- products we sell
CREATE TABLE products (
  sku TEXT PRIMARY KEY,             -- matches Amazon "Seller SKU"
  name TEXT NOT NULL,
  size_g INTEGER NOT NULL,
  unit_cost_paise INTEGER,          -- store money in paise to avoid floats
  retail_price_paise INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- current stock state per SKU
CREATE TABLE inventory (
  sku TEXT PRIMARY KEY REFERENCES products(sku),
  stock_on_hand INTEGER NOT NULL DEFAULT 0,
  reorder_threshold INTEGER NOT NULL DEFAULT 10,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- every order from any channel
CREATE TABLE orders (
  id TEXT PRIMARY KEY,              -- Amazon AmazonOrderId, or other channel's ID
  channel TEXT NOT NULL,            -- 'amazon' | 'd2c' | 'whatsapp' | ...
  status TEXT NOT NULL,             -- 'pending' | 'shipped' | 'cancelled' | 'refunded'
  buyer_name TEXT,
  total_paise INTEGER,
  raw_json TEXT NOT NULL,           -- full API response for debugging
  purchased_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE order_items (
  order_id TEXT REFERENCES orders(id),
  sku TEXT REFERENCES products(sku),
  qty INTEGER NOT NULL,
  unit_price_paise INTEGER,
  PRIMARY KEY (order_id, sku)
);

-- audit log of every inventory change (sales, restocks, corrections)
CREATE TABLE inventory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT REFERENCES products(sku),
  delta INTEGER NOT NULL,           -- negative for sales, positive for restocks
  reason TEXT NOT NULL,             -- 'amazon_order:123-456' | 'manual_restock' | ...
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- where we are in the polling loop
CREATE TABLE poll_state (
  key TEXT PRIMARY KEY,             -- e.g. 'amazon_orders'
  value TEXT NOT NULL               -- ISO timestamp of last successful poll
);
```

---

## Code outline

### wrangler.jsonc additions

```jsonc
{
  // ... existing config (name, assets, etc.) ...
  "triggers": {
    "crons": ["*/15 * * * *"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "mothers-gold-spice",
      "database_id": "<filled in after wrangler d1 create>"
    }
  ]
}
```

### Worker scheduled handler (pseudocode)

```ts
// src/worker.ts (Astro + Workers integration adapter, TBD)
export default {
  async scheduled(event, env, ctx) {
    const lastPoll = await getLastPoll(env.DB);
    const accessToken = await exchangeRefreshToken(env);
    const orders = await fetchSpApiOrders(accessToken, { since: lastPoll });

    for (const o of orders) {
      await saveOrder(env.DB, o);
      for (const item of o.items) {
        await decrementStock(env.DB, item.sku, item.qty, `amazon_order:${o.id}`);
      }
    }
    await setLastPoll(env.DB, new Date());
  }
};
```

### Admin pages (later)

`src/pages/admin/orders.astro` and `src/pages/admin/inventory.astro`:
- Protected by **Cloudflare Access** (free for up to 50 users, magic-link or Google login).
- Read from D1, render a table of recent orders + a stock view with red rows when `stock_on_hand <= reorder_threshold`.

---

## Milestones

1. ⬜ Amazon seller account live + first listing approved (no code yet).
2. ⬜ `wrangler d1 create mothers-gold-spice` + apply schema above.
3. ⬜ Wire scheduled handler with fake hardcoded data — confirm cron fires and writes to D1.
4. ⬜ Plug in real SP-API call, read-only — just log orders.
5. ⬜ Add inventory decrement logic + audit log writes.
6. ⬜ Build admin pages behind Cloudflare Access.
7. ⬜ Decide whether to migrate to Option 2 (push notifications) — only if 15-min lag causes problems.

---

## When to upgrade to Option 2

Move from polling to push (SP-API Notifications via SQS) only if:
- 15-minute lag is causing oversells (last jar sold on Amazon AND on D2C in the same window).
- Hitting SP-API rate limits because of how often we poll.
- We need order-level events not in `getOrders` (returns, A-to-Z claims, etc.).

---

## Open questions

- Will we list on Flipkart / Meesho too? The `orders.channel` column is already designed for this — just add another scheduled handler per channel.
- Self-fulfilled vs **Fulfilled by Amazon (FBA)**? Affects which SP-API endpoints we hit (`getOrders` vs FBA-specific inventory APIs).
- Low-stock alerts: email/WhatsApp/Slack — or just colored rows in the admin page?
- Do we want per-batch tracking (which jar came from which day's cooking) for FSSAI traceability?
