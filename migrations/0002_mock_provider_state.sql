-- State for the MOCK providers only.
--
-- A mock provider stands in for an external system, and that external system has
-- state (a transaction that is pending then paid, a shipment that moves through
-- scan events). Workers are stateless between requests, so the simulated vendor
-- needs somewhere to keep it. These two tables are that somewhere.
--
-- Nothing in the business schema references them. When real Paddle/Shiprocket
-- credentials land and PAYMENT_PROVIDER/SHIPPING_PROVIDER stop being `mock`,
-- this migration can be dropped without touching an order.

CREATE TABLE mock_provider_state (
  key         TEXT PRIMARY KEY,     -- e.g. "payment:mock_txn_01k…", "shipment:mock_shp_01k…"
  kind        TEXT NOT NULL,        -- payment | shipment
  value_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_mock_state_kind ON mock_provider_state (kind, updated_at DESC);
