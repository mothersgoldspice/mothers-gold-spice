-- Mother's Gold Spice — order management schema (D1 / SQLite).
--
-- Conventions used throughout:
--   * ids           TEXT, prefixed + k-sortable (see src/lib/ids.ts) — `ord_01J...`
--   * money         INTEGER paise (INR minor units). Never floats. `total_paise`.
--   * timestamps    INTEGER epoch milliseconds (JS `Date.now()`), nullable when "not yet".
--   * booleans      INTEGER 0/1.
--   * JSON blobs    TEXT holding JSON, suffixed `_json`.
--
-- The catalog is deliberately product/variant shaped rather than pickle-shaped: the
-- brand expands to chutneys, cookies and other foods, so `products.category` and a
-- variant-per-jar-size model carry that without a migration.

-- ─────────────────────────────────────────────────────────────────────────────
-- Identity
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,          -- always stored lowercased+trimmed
  email_verified_at INTEGER,
  password_hash     TEXT,                          -- NULL for guest-created shells
  name              TEXT NOT NULL DEFAULT '',
  phone             TEXT,
  role              TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','staff','admin')),
  status            TEXT NOT NULL DEFAULT 'active'   CHECK (status IN ('active','disabled')),
  marketing_opt_in  INTEGER NOT NULL DEFAULT 0,
  failed_logins     INTEGER NOT NULL DEFAULT 0,
  locked_until      INTEGER,
  last_login_at     INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_users_created ON users (created_at DESC);
CREATE INDEX idx_users_role    ON users (role) WHERE role <> 'customer';

-- Sessions store only a SHA-256 of the cookie value; a DB leak cannot be replayed
-- as a login. Rotation on privilege change is handled in src/lib/auth/session.ts.
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,                  -- sha256(raw cookie token), hex
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_sessions_user    ON sessions (user_id, expires_at DESC);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- One table for every single-use link we email: verification, password reset,
-- and the guest order-tracking token. Stored hashed for the same reason as sessions.
CREATE TABLE auth_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT REFERENCES users (id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL CHECK (purpose IN ('email_verify','password_reset','order_access')),
  email        TEXT,
  order_id     TEXT,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_auth_tokens_user    ON auth_tokens (user_id, purpose);
CREATE INDEX idx_auth_tokens_expires ON auth_tokens (expires_at);

CREATE TABLE addresses (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label                TEXT NOT NULL DEFAULT 'Home',
  full_name            TEXT NOT NULL,
  phone                TEXT NOT NULL,
  line1                TEXT NOT NULL,
  line2                TEXT,
  landmark             TEXT,
  city                 TEXT NOT NULL,
  state                TEXT NOT NULL,
  pincode              TEXT NOT NULL,
  country              TEXT NOT NULL DEFAULT 'IN',
  is_default_shipping  INTEGER NOT NULL DEFAULT 0,
  is_default_billing   INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER
);
CREATE INDEX idx_addresses_user ON addresses (user_id) WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Catalog
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE products (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  subtitle           TEXT NOT NULL DEFAULT '',
  description        TEXT NOT NULL DEFAULT '',
  category           TEXT NOT NULL DEFAULT 'pickle',
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  hero_image         TEXT,
  images_json        TEXT NOT NULL DEFAULT '[]',
  ingredients        TEXT NOT NULL DEFAULT '',
  allergens          TEXT NOT NULL DEFAULT '',
  shelf_life_months  INTEGER,
  storage_note       TEXT NOT NULL DEFAULT '',
  is_veg             INTEGER NOT NULL DEFAULT 1,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_products_status ON products (status, sort_order);

CREATE TABLE product_variants (
  id                      TEXT PRIMARY KEY,
  product_id              TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sku                     TEXT NOT NULL UNIQUE,
  name                    TEXT NOT NULL,             -- "250 g"
  weight_grams            INTEGER NOT NULL,          -- net weight of goods
  shipping_weight_grams   INTEGER NOT NULL,          -- packed weight the courier bills on
  price_paise             INTEGER NOT NULL CHECK (price_paise >= 0),
  compare_at_price_paise  INTEGER,
  hsn_code                TEXT NOT NULL DEFAULT '20019000',
  gst_rate_bps            INTEGER NOT NULL DEFAULT 1200,  -- basis points; 1200 = 12%
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  sort_order              INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX idx_variants_product ON product_variants (product_id, sort_order);

-- available = on_hand - reserved. Reservations are held from order creation until
-- the order is paid (converted to a decrement) or cancelled/expired (released).
CREATE TABLE inventory (
  variant_id     TEXT PRIMARY KEY REFERENCES product_variants (id) ON DELETE CASCADE,
  on_hand        INTEGER NOT NULL DEFAULT 0,
  reserved       INTEGER NOT NULL DEFAULT 0,
  reorder_level  INTEGER NOT NULL DEFAULT 6,
  track          INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE inventory_ledger (
  id          TEXT PRIMARY KEY,
  variant_id  TEXT NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,             -- signed change to on_hand
  reason      TEXT NOT NULL,                -- restock | sale | cancel | return | correction | spoilage
  ref_type    TEXT,
  ref_id      TEXT,
  note        TEXT,
  actor_id    TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_inv_ledger_variant ON inventory_ledger (variant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Cart
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE carts (
  id          TEXT PRIMARY KEY,        -- also the value hashed into the cart cookie
  user_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','abandoned')),
  currency    TEXT NOT NULL DEFAULT 'INR',
  order_id    TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_carts_user    ON carts (user_id, status);
CREATE INDEX idx_carts_expires ON carts (expires_at) WHERE status = 'active';

CREATE TABLE cart_items (
  id               TEXT PRIMARY KEY,
  cart_id          TEXT NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  variant_id       TEXT NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_price_paise INTEGER NOT NULL,       -- snapshot; re-validated at checkout
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (cart_id, variant_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Promotions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE coupons (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,     -- stored uppercased
  description         TEXT NOT NULL DEFAULT '',
  type                TEXT NOT NULL CHECK (type IN ('percent','fixed','free_shipping')),
  value               INTEGER NOT NULL DEFAULT 0,   -- percent → bps; fixed → paise
  min_subtotal_paise  INTEGER NOT NULL DEFAULT 0,
  max_discount_paise  INTEGER,
  starts_at           INTEGER,
  ends_at             INTEGER,
  usage_limit         INTEGER,
  per_user_limit      INTEGER NOT NULL DEFAULT 1,
  used_count          INTEGER NOT NULL DEFAULT 0,
  first_order_only    INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  provider_discount_id TEXT,                    -- mirrored into the payment provider
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE coupon_redemptions (
  id          TEXT PRIMARY KEY,
  coupon_id   TEXT NOT NULL REFERENCES coupons (id) ON DELETE CASCADE,
  order_id    TEXT NOT NULL,
  user_id     TEXT,
  email       TEXT,
  amount_paise INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (coupon_id, order_id)
);
CREATE INDEX idx_redemptions_user ON coupon_redemptions (coupon_id, user_id);
CREATE INDEX idx_redemptions_email ON coupon_redemptions (coupon_id, email);

-- ─────────────────────────────────────────────────────────────────────────────
-- Orders
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE orders (
  id                    TEXT PRIMARY KEY,
  order_number          TEXT NOT NULL UNIQUE,      -- MGS-26-0001, shown to customers
  user_id               TEXT REFERENCES users (id) ON DELETE SET NULL,
  email                 TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  customer_name         TEXT NOT NULL,
  is_guest              INTEGER NOT NULL DEFAULT 0,

  status                TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
                          'pending_payment','payment_failed','confirmed','processing','packed',
                          'shipped','out_for_delivery','delivered','cancelled','returned','refunded')),
  payment_status        TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN (
                          'pending','authorized','paid','failed','refunded','partially_refunded')),
  fulfillment_status    TEXT NOT NULL DEFAULT 'unfulfilled' CHECK (fulfillment_status IN (
                          'unfulfilled','processing','fulfilled','returned')),

  currency              TEXT NOT NULL DEFAULT 'INR',
  subtotal_paise        INTEGER NOT NULL DEFAULT 0,
  discount_paise        INTEGER NOT NULL DEFAULT 0,
  shipping_paise        INTEGER NOT NULL DEFAULT 0,
  cod_fee_paise         INTEGER NOT NULL DEFAULT 0,
  tax_paise             INTEGER NOT NULL DEFAULT 0,
  total_paise           INTEGER NOT NULL DEFAULT 0,
  refunded_paise        INTEGER NOT NULL DEFAULT 0,
  tax_inclusive         INTEGER NOT NULL DEFAULT 1,

  coupon_id             TEXT,
  coupon_code           TEXT,

  payment_method        TEXT NOT NULL DEFAULT 'prepaid' CHECK (payment_method IN ('prepaid','cod')),
  shipping_method        TEXT NOT NULL DEFAULT 'surface',
  shipping_zone         TEXT,
  total_weight_grams    INTEGER NOT NULL DEFAULT 0,

  shipping_address_json TEXT NOT NULL,
  billing_address_json  TEXT NOT NULL,

  customer_note         TEXT,
  admin_note            TEXT,
  cancel_reason         TEXT,

  guest_token_hash      TEXT,                     -- lets a guest open /track without an account
  idempotency_key       TEXT UNIQUE,
  cart_id               TEXT,

  placed_at             INTEGER NOT NULL,
  paid_at               INTEGER,
  shipped_at            INTEGER,
  delivered_at          INTEGER,
  cancelled_at          INTEGER,
  reserved_until        INTEGER,                  -- stock hold expiry for unpaid orders
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_orders_user     ON orders (user_id, created_at DESC);
CREATE INDEX idx_orders_email    ON orders (email, created_at DESC);
CREATE INDEX idx_orders_status   ON orders (status, created_at DESC);
CREATE INDEX idx_orders_created  ON orders (created_at DESC);
CREATE INDEX idx_orders_reserved ON orders (reserved_until) WHERE status = 'pending_payment';

CREATE TABLE order_items (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  variant_id        TEXT NOT NULL,
  product_id        TEXT NOT NULL,
  sku               TEXT NOT NULL,
  product_name      TEXT NOT NULL,      -- snapshot: catalog edits must not rewrite history
  variant_name      TEXT NOT NULL,
  image             TEXT,
  unit_price_paise  INTEGER NOT NULL,
  qty               INTEGER NOT NULL CHECK (qty > 0),
  subtotal_paise    INTEGER NOT NULL,
  discount_paise    INTEGER NOT NULL DEFAULT 0,
  tax_paise         INTEGER NOT NULL DEFAULT 0,
  tax_rate_bps      INTEGER NOT NULL DEFAULT 0,
  hsn_code          TEXT,
  weight_grams      INTEGER NOT NULL DEFAULT 0,
  total_paise       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_order_items_order ON order_items (order_id);

-- Append-only customer-visible + internal timeline. Everything that moves an order
-- writes here, which is what /account/orders/[id] and the admin detail view render.
CREATE TABLE order_events (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  message      TEXT NOT NULL,
  data_json    TEXT NOT NULL DEFAULT '{}',
  actor_type   TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('system','customer','admin','provider')),
  actor_id     TEXT,
  is_customer_visible INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events (order_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Payments
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE payments (
  id                    TEXT PRIMARY KEY,
  order_id              TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  provider              TEXT NOT NULL,             -- mock | paddle | razorpay | cod
  provider_checkout_id  TEXT,
  provider_payment_id   TEXT,
  provider_customer_id  TEXT,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                          'pending','authorized','paid','failed','cancelled','refunded','partially_refunded')),
  amount_paise          INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'INR',
  method                TEXT,
  checkout_url          TEXT,
  failure_reason        TEXT,
  raw_json              TEXT NOT NULL DEFAULT '{}',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  captured_at           INTEGER
);
CREATE INDEX idx_payments_order    ON payments (order_id, created_at DESC);
CREATE INDEX idx_payments_checkout ON payments (provider_checkout_id);

CREATE TABLE refunds (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  payment_id          TEXT REFERENCES payments (id) ON DELETE SET NULL,
  provider            TEXT NOT NULL,
  provider_refund_id  TEXT,
  amount_paise        INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  reason              TEXT,
  actor_id            TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_refunds_order ON refunds (order_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Shipping
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE shipments (
  id                     TEXT PRIMARY KEY,
  order_id               TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  provider               TEXT NOT NULL,            -- mock | shiprocket | manual
  provider_order_id      TEXT,
  provider_shipment_id   TEXT,
  awb_code               TEXT,
  courier_name           TEXT,
  status                 TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
                           'created','pickup_scheduled','picked_up','in_transit','out_for_delivery',
                           'delivered','failed_delivery','rto_initiated','rto_delivered','cancelled')),
  label_url              TEXT,
  manifest_url           TEXT,
  tracking_url           TEXT,
  weight_grams           INTEGER NOT NULL DEFAULT 0,
  dimensions_json        TEXT NOT NULL DEFAULT '{}',
  charges_paise          INTEGER NOT NULL DEFAULT 0,
  pickup_scheduled_at    INTEGER,
  shipped_at             INTEGER,
  estimated_delivery_at  INTEGER,
  delivered_at           INTEGER,
  raw_json               TEXT NOT NULL DEFAULT '{}',
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX idx_shipments_order ON shipments (order_id);
CREATE INDEX idx_shipments_awb   ON shipments (awb_code);

CREATE TABLE shipment_events (
  id                 TEXT PRIMARY KEY,
  shipment_id        TEXT NOT NULL REFERENCES shipments (id) ON DELETE CASCADE,
  order_id           TEXT NOT NULL,
  status             TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  location           TEXT,
  occurred_at        INTEGER NOT NULL,
  provider_event_id  TEXT,
  raw_json           TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL,
  UNIQUE (shipment_id, provider_event_id)
);
CREATE INDEX idx_shipment_events_shipment ON shipment_events (shipment_id, occurred_at DESC);

-- Serviceability answers are stable for days and the lookup sits on the checkout
-- critical path, so results are cached rather than re-fetched per keystroke.
CREATE TABLE pincode_cache (
  pincode        TEXT PRIMARY KEY,
  serviceable    INTEGER NOT NULL DEFAULT 1,
  cod_available  INTEGER NOT NULL DEFAULT 0,
  zone           TEXT,
  city           TEXT,
  state          TEXT,
  etd_days       INTEGER,
  provider       TEXT,
  raw_json       TEXT NOT NULL DEFAULT '{}',
  refreshed_at   INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Notifications & email
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  link        TEXT,
  data_json   TEXT NOT NULL DEFAULT '{}',
  read_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);

-- Durable outbox. Every email is persisted BEFORE the provider is called, so a
-- provider outage is a retry rather than a lost order confirmation — and in mock
-- mode this table IS the inbox the admin console renders.
CREATE TABLE email_outbox (
  id                   TEXT PRIMARY KEY,
  to_email             TEXT NOT NULL,
  to_name              TEXT NOT NULL DEFAULT '',
  from_email           TEXT NOT NULL,
  from_name            TEXT NOT NULL DEFAULT '',
  reply_to             TEXT,
  subject              TEXT NOT NULL,
  template             TEXT NOT NULL,
  text_body            TEXT NOT NULL DEFAULT '',
  html_body            TEXT NOT NULL DEFAULT '',
  data_json            TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                         'queued','sending','sent','failed','suppressed','cancelled')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 5,
  last_error           TEXT,
  provider             TEXT,
  provider_message_id  TEXT,
  user_id              TEXT,
  order_id             TEXT,
  idempotency_key      TEXT UNIQUE,
  scheduled_at         INTEGER NOT NULL,
  sent_at              INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_outbox_pending ON email_outbox (status, scheduled_at) WHERE status IN ('queued','failed');
CREATE INDEX idx_outbox_created ON email_outbox (created_at DESC);
CREATE INDEX idx_outbox_order   ON email_outbox (order_id);

CREATE TABLE email_suppressions (
  email       TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  source      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE newsletter_subscribers (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'subscribed' CHECK (status IN ('subscribed','unsubscribed')),
  source          TEXT,
  created_at      INTEGER NOT NULL,
  unsubscribed_at INTEGER
);

CREATE TABLE stock_alerts (
  id           TEXT PRIMARY KEY,
  variant_id   TEXT NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  notified_at  INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE (variant_id, email)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Platform
-- ─────────────────────────────────────────────────────────────────────────────

-- Every inbound provider callback lands here first. `(provider, event_id)` is the
-- idempotency key — a Paddle/Shiprocket retry storm replays the same event id and
-- must not double-confirm an order or double-decrement stock.
CREATE TABLE webhook_events (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL CHECK (source IN ('payment','shipping')),
  provider         TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','ignored')),
  signature_valid  INTEGER NOT NULL DEFAULT 0,
  payload_json     TEXT NOT NULL DEFAULT '{}',
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  order_id         TEXT,
  received_at      INTEGER NOT NULL,
  processed_at     INTEGER,
  UNIQUE (provider, event_id)
);
CREATE INDEX idx_webhook_received ON webhook_events (received_at DESC);

CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_expires ON rate_limits (expires_at);

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  data_json    TEXT NOT NULL DEFAULT '{}',
  ip           TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX idx_audit_entity  ON audit_log (entity_type, entity_id);

-- Runtime-tunable store config (GST rate, free-shipping threshold, COD on/off).
-- Values that an operator changes without a redeploy live here, not in env vars.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

CREATE TABLE product_reviews (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  order_id    TEXT,
  user_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_reviews_product ON product_reviews (product_id, status);
