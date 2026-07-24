# Order management system

The shop that sits behind mothersgoldspice.com — accounts, cart, checkout,
payments, fulfilment, tracking and transactional email.

It was deliberately built so that **no credential is required to run or test
it**. Every external dependency sits behind an interface with a working mock
adapter, and switching to the real thing is a config change plus one file. That
is what the rest of this document is about.

---

## 1. What it runs on

| Layer | Choice | Why |
|---|---|---|
| Framework | Astro 5, `output: 'static'` | The eleven existing marketing pages keep building to plain HTML on the CDN. Only routes that opt in with `export const prerender = false` become dynamic. |
| Runtime | Cloudflare Workers (`@astrojs/cloudflare`) | The site was already deployed there. No new infrastructure, no cold starts, no server to patch. |
| Database | Cloudflare D1 (SQLite) | Same account, same deploy, zero operational surface. Sufficient by three orders of magnitude for a kitchen that makes pickle in batches. |
| Styling | Tailwind v4 with the existing brand tokens | The shop had to look like the brand, not like a plugin bolted onto it. |

Money is **integer paise** everywhere — in the database, in every function
argument, and over the wire. Rupees exist only at the display edge. Timestamps
are epoch milliseconds. Neither is ever a float.

---

## 2. The three swappable seams

This was the core requirement, and it is enforced structurally rather than by
convention: **nothing outside `src/lib/providers/` may import a vendor SDK or
mention a vendor's field names.**

```
src/lib/providers/
├── email/
│   ├── types.ts        EmailProvider          ← the contract
│   ├── mock.ts         MockEmailProvider      ← works today
│   ├── resend.ts       ResendEmailProvider    ← works with a key
│   └── factory.ts      resolves from EMAIL_PROVIDER
├── payment/
│   ├── types.ts        PaymentProvider
│   ├── mock.ts         MockPaymentProvider    ← a real fake gateway, see §4
│   ├── paddle.ts       PaddlePaymentProvider
│   ├── razorpay.ts     RazorpayPaymentProvider
│   └── factory.ts      resolves from PAYMENT_PROVIDER
└── shipping/
    ├── types.ts        ShipmentProvider
    ├── mock.ts         MockShipmentProvider
    ├── shiprocket.ts   ShiprocketProvider
    └── factory.ts      resolves from SHIPPING_PROVIDER
```

Two payment adapters ship on purpose. Paddle was the named requirement; Razorpay
is the one this business will most likely actually run on, because Paddle is a
merchant of record built for digital goods and a sole proprietorship selling
glass jars needs UPI, Indian cards and COD reconciliation. Having both is the
proof that the seam works — the order, cart and refund code is byte-identical
under either.

### The factories fail loud

A mock provider on a live storefront does not fail visibly. It marks orders paid
without collecting money, prints AWBs no courier has, and swallows every order
confirmation. So on a deployed environment, resolving to a mock **throws at
construction** unless `ALLOW_MOCK_PROVIDERS=true` is set explicitly:

```
Refusing to use MockPaymentProvider with APP_ENV=production.
It would mark orders paid without collecting money. Set PAYMENT_PROVIDER=razorpay|paddle
with the matching credentials, or ALLOW_MOCK_PROVIDERS=true for a pre-launch deploy.
```

That flag is currently `true`, because this deployment is a private pre-launch
store. **Setting it to `false` is the switch that makes going live impossible to
do by accident.**

---

## 3. Turning on the real services

Nothing below requires a code change. Each block is `wrangler secret put` plus a
`vars` edit in `wrangler.jsonc`.

### Email — Resend

```bash
npx wrangler secret put RESEND_API_KEY
# wrangler.jsonc vars:  "EMAIL_PROVIDER": "resend", "EMAIL_FROM": "orders@mothersgoldspice.com"
```
Verify the sending domain in Resend first (SPF + DKIM on the Cloudflare zone),
or every message soft-bounces.

### Payments — Razorpay (recommended for India)

```bash
npx wrangler secret put RAZORPAY_KEY_ID
npx wrangler secret put RAZORPAY_KEY_SECRET
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
# vars: "PAYMENT_PROVIDER": "razorpay"
```
Webhook URL to register: `https://<site>/api/webhooks/payment`
Events: `payment_link.paid`, `payment.captured`, `payment.failed`, `refund.processed`.

### Payments — Paddle

```bash
npx wrangler secret put PADDLE_API_KEY
npx wrangler secret put PADDLE_WEBHOOK_SECRET
# vars: "PAYMENT_PROVIDER": "paddle", "PADDLE_ENVIRONMENT": "sandbox" | "production"
# optional: PADDLE_PRODUCT_ID to attach inline prices to a catalogue product
```
Same webhook URL. Events: `transaction.completed`, `transaction.paid`,
`transaction.payment_failed`, `adjustment.created`.

### Shipping — Shiprocket

```bash
npx wrangler secret put SHIPROCKET_EMAIL
npx wrangler secret put SHIPROCKET_PASSWORD
npx wrangler secret put SHIPROCKET_WEBHOOK_TOKEN
# vars: "SHIPPING_PROVIDER": "shiprocket", "SHIPROCKET_PICKUP_LOCATION": "<nickname from their dashboard>"
```
Webhook URL: `https://<site>/api/webhooks/shipping`, authenticated by the
`x-api-key` header set to `SHIPROCKET_WEBHOOK_TOKEN`.

### Then flip the guard

```jsonc
"ALLOW_MOCK_PROVIDERS": "false"
```

`GET /api/health` reports which adapter each seam actually resolved to. Check it
after every credential change — it is the fastest way to catch a typo'd env var.

---

## 4. The mocks are not stubs

This matters for how much the pre-launch testing is worth.

`MockPaymentProvider` **persists a transaction**, returns a hosted-checkout URL
pointing at `/checkout/pay/[id]`, and on success emits a genuinely HMAC-signed
webhook — POSTed over real HTTP to `/api/webhooks/payment`, where the adapter
verifies the signature using the same scheme Paddle uses (`ts=…;h1=…` over
`ts:body`). The confirmation path exercised in testing is the production one.
Only the signer changes.

`MockShipmentProvider` quotes from the real zone rate table, mints an AWB, and
can be walked through the full scan lifecycle from the admin console — each step
firing a signed webhook through the same tracking pipeline Shiprocket will drive.

`MockEmailProvider` accepts everything, and the durable copy already exists in
`email_outbox`, so **`/admin/emails` is a real inbox**: you can read exactly what
a customer would have received, fully rendered, with live links.

Their state lives in `mock_provider_state` (migration `0002`), a table nothing in
the business schema references. When real credentials land, that migration can be
dropped without touching an order.

---

## 5. Data model

`migrations/0001_init.sql` is authoritative. The shape worth knowing:

- **An order is a snapshot.** Product names, variant names, unit prices, tax
  rates and both addresses are copied onto `orders` / `order_items` at placement.
  Editing the catalogue tomorrow cannot rewrite what someone bought today.
- **Stock has three states.** `available → reserved` at order creation,
  `reserved → sold` on payment confirmation, `reserved → available` on
  cancellation or expiry. An unpaid order releases its hold after 30 minutes;
  without that, every abandoned checkout would permanently shrink availability.
- **`order_events` is append-only** and is what both the customer timeline and
  the admin audit view render. Staff-only entries are flagged
  `is_customer_visible = 0`.
- **`webhook_events` has `UNIQUE (provider, event_id)`.** That constraint *is*
  the idempotency lock — whichever concurrent delivery wins the insert processes
  the event; the losers see the violation and return "duplicate".
- **`email_outbox` is written before the provider is called.** A confirmation
  that exists as a row can be retried, inspected and resent. One that only ever
  existed as an in-flight `fetch` is gone the moment the provider 500s.
- The catalogue is **product/variant** shaped, not pickle shaped:
  `products.category` and a variant-per-jar-size model carry chutneys and cookies
  without a migration.

---

## 6. Money and tax

`src/lib/services/pricing.ts` is pure — no database, no clock — because it is the
one place where being wrong costs real money, and pure functions are the only
ones worth exhaustively testing.

**GST is inclusive.** A ₹299 jar at 12% *contains* ₹32.04 of tax; it does not
attract ₹35.88 on top. That is the Indian retail convention and what the label
prints. So `orders.tax_paise` is a breakdown of the total for the invoice, **not
an addition to it**. Getting that backwards overcharges every customer by the
tax rate. Services (courier, COD handling) are taxed at 18% rather than the 12%
food rate.

Other rules the pricing module enforces:

- Percent coupons store **basis points** (10% = `1000`). A plain `10` would be 0.1%.
- A fixed coupon never discounts below zero.
- The free-shipping threshold is judged on the subtotal **after** discount —
  otherwise a coupon that drops a basket below the threshold still wins free delivery.
- Order-level discount is allocated across lines proportionally, with the
  rounding remainder pushed onto the largest line, so line totals always sum
  exactly to the order total.

Rates, thresholds and COD rules live in the `settings` table and are editable at
`/admin/settings` without a deploy. Defaults are in code
(`DEFAULT_SETTINGS`), so a fresh database is immediately a working shop.

---

## 7. Security

| Concern | Approach |
|---|---|
| Passwords | PBKDF2-HMAC-SHA256, **100,000 iterations** (the Workers platform maximum — see §9), per-user salt. Workers have no bcrypt/argon2 binding; this is the strongest KDF the runtime offers natively. The stored format is self-describing, so raising the count later transparently upgrades hashes on next login. |
| Sessions | 256-bit random token in an HttpOnly cookie; only its SHA-256 is stored. A database dump contains nothing replayable. Rotated on sign-in; all sessions revoked on password reset. |
| CSRF | Signed double-submit token (HttpOnly cookie + form field / `x-csrf-token` header) plus an Origin check. Webhook and cron routes are exempt — a gateway has no cookie — and prove themselves with a provider signature instead, which is stronger. |
| Webhooks | Signature verified in the adapter before anything is read. A bad signature is a 401 and a `log.alert`. The raw body is hashed byte-for-byte; re-serialising parsed JSON would never match. |
| Order access | Guests get an HMAC-derived token in their tracking link. Order ids are k-sortable, so a bare `/track/ord_01k…` would be walkable to the previous customer's address and phone number. |
| Enumeration | Sign-in failures are one message. Password reset always reports success. Registering an existing address emails the real owner instead of erroring. |
| Rate limits | Fixed-window counters in D1 (not KV — the counters need read-your-own-write). Login is limited per IP **and** per targeted account, plus a per-account lockout. |
| Payment amounts | A callback claiming less than the order total does not confirm the order. It is flagged for a human. |
| Admin | `requireAdmin` is the first line of every `/admin` page and `/api/admin` route, and every action writes an `audit_log` row. |

---

## 8. Operations

### Deploy

```bash
npm run build && npx wrangler deploy
```

### Migrations

```bash
npx wrangler d1 migrations apply mothers-gold-spice --local
npx wrangler d1 migrations apply mothers-gold-spice --remote
```

### Seed the catalogue

```bash
npx wrangler d1 execute mothers-gold-spice --remote --file=scripts/seed.sql
```
Idempotent. Inventory uses `ON CONFLICT DO NOTHING` so re-seeding never resets
live stock counts, and coupon `used_count` is excluded from updates so a
re-seed cannot resurrect an exhausted code.

### First admin user

See `scripts/seed-admin.sql.example`. There is no bootstrap admin in the seed and
there never will be — a shipped default login is a back door.

### Scheduled maintenance

`POST /api/cron/maintenance` with `Authorization: Bearer $CRON_SECRET` runs six
independent jobs: drain the email outbox, expire stock reservations, abandon
stale carts, prune sessions / tokens / rate-limit windows. One failing job does
not stop the others. Wire it to a Cloudflare Cron Trigger (every 5 minutes) or
any external scheduler.

### Smoke test a deployment

```bash
node scripts/smoke-test.mjs https://<site> --admin-email … --admin-password …
```
Drives a real customer journey over HTTP — register, browse, cart, coupon,
serviceability, checkout, pay, then as staff book the parcel and walk it to
delivered — asserting state and queued emails at each step. It exists because
unit tests cannot tell you the deployed Worker has its D1 binding or that
middleware is exempting the webhook path.

### Unit and integration tests

```bash
npm test
```

207 tests. The integration suite runs on **real workerd against a real local D1**
via `@cloudflare/vitest-pool-workers`, not a SQLite stand-in — the inventory
design leans on D1 specifics (`batch()` atomicity, conditional UPDATEs reporting
`meta.changes`, `RETURNING` on an UPDATE), so a substitute would have happily
passed code that cannot work on the platform it ships to.

---

## 9. Known limits, honestly

- **PBKDF2 is capped at 100,000 iterations by the runtime**, not by choice:

  ```
  NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
  supported (requested 210000).
  ```

  OWASP asks for 210,000. This was found the expensive way — the cap is *not*
  enforced in local development, so the original 210,000 passed every test and
  then 500'd on every sign-up and sign-in in production. `verifyPassword` now
  treats a stored hash above the cap as a failed verification rather than
  throwing, so a legacy hash sends the customer to password reset instead of an
  error page. Going higher needs either a WASM argon2 build or a server-side
  pepper in a Worker secret; both are additive, since the hash format records
  its own parameters.
- **D1 has no interactive transactions.** Multi-row invariants are expressed as
  atomic `batch()` calls, and stock reservation uses a conditional UPDATE with
  explicit compensation when a line loses the race. This is correct but it is
  compensation, not rollback — the reasoning is commented in
  `src/lib/services/inventory.ts`.
- **Order numbers come from a COUNT.** A collision is retried against a UNIQUE
  constraint. At this volume the loop effectively never runs twice; at 50 orders
  a second it would need a real sequence.
- **Serviceability degrades to "yes".** If the courier API is down, checkout
  proceeds using the locally computed zone rather than blocking every order in
  the country. A genuinely unserviceable parcel is caught at booking.
- **The serviceability cache is keyed by PIN code alone.** `cod_available` is
  only trusted when `cod_checked = 1`, because a prepaid lookup writes 0 and
  that used to read back as "no cash on delivery here" — silently refusing COD
  to everyone in that PIN code for three days. A COD-unavailable PIN code
  therefore re-queries the courier each time rather than caching the negative.
- **No GST invoice PDF yet.** The data is all there (`hsn_code`, per-rate tax
  breakdown, legal entity fields in settings); the rendering is not.
- **Refunds for COD orders** are recorded but have no automatic disbursement
  path — there is no gateway to reverse. That is a bank transfer someone makes.
