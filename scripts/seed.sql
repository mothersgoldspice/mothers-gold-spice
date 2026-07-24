-- Mother's Gold Spice — seed data for the catalogue and promotions.
--
--   npx wrangler d1 execute mothers-gold-spice --local  --file=scripts/seed.sql
--   npx wrangler d1 execute mothers-gold-spice --remote --file=scripts/seed.sql
--
-- This file is run repeatedly — on a fresh local database, after a schema reset,
-- and against production whenever the catalogue copy changes. Everything here is
-- therefore idempotent, and idempotent in the specific sense that matters for a
-- live shop: re-running updates the *descriptive* fields and never touches the
-- *operational* ones (stock counts, coupon usage counters).
--
-- Two deliberate choices hold that line:
--
--   1. ON CONFLICT DO UPDATE, never INSERT OR REPLACE. REPLACE resolves a
--      conflict by DELETEing the existing row first, and with foreign keys
--      enforced that delete cascades — re-seeding `products` with OR REPLACE
--      would silently take `product_variants` and `inventory` (i.e. real stock)
--      down with it. DO UPDATE mutates the row in place and cascades nothing.
--   2. Fixed literal ids and one fixed literal timestamp. No newId(), no
--      unixepoch() — a seed that generates fresh values on every run is not a
--      seed, it is an insert.
--
-- Money is INTEGER paise: ₹299 is 29900. GST is basis points: 1200 is 12%.

-- One literal epoch-ms timestamp for the whole file (2026-07-14T03:33:20Z).
-- A SQL function such as unixepoch() * 1000 would write a different value on
-- every run, so `updated_at` would churn, every audit diff would show phantom
-- catalogue edits, and "has this row changed since the last seed?" would stop
-- being answerable. Bump this constant by hand when the seed content changes.
-- Value used below: 1784000000000

-- ─────────────────────────────────────────────────────────────────────────────
-- Products
-- ─────────────────────────────────────────────────────────────────────────────

-- The launch SKU. Copy is kept in step with src/components/Product.astro and the
-- back-panel text in LABEL.md — the label and the product page must never
-- disagree about ingredients, allergens or shelf life.
INSERT INTO products (
  id, slug, name, subtitle, description, category, status,
  hero_image, images_json, ingredients, allergens,
  shelf_life_months, storage_note, is_veg, sort_order, created_at, updated_at
) VALUES (
  'prd_seed_mangopickle',
  'mango-mustard-pickle',
  'Mango Mustard Pickle',
  'Hand-made in Bangalore · Small Batch',
  'Tart raw mango, slow-cooked in mustard oil with a blend of roasted spices — mustard, fenugreek, garlic, red chili. Bold, deeply aromatic, and made to last on your shelf without a single preservative.',
  'pickle',
  'active',
  '/mango-jar.webp',
  '["/mango-jar.webp","/jar.webp"]',
  'Raw Mango (60%), Mustard Oil (25%), Salt, Spices (Mustard Seeds, Fenugreek, Red Chilli, Turmeric, Asafoetida).',
  'Contains Mustard.',
  12,
  'Store in a cool, dry place away from direct sunlight. Refrigerate after opening. Always use a clean, dry spoon. Oil naturally separates, which is normal.',
  1,
  10,
  1784000000000,
  1784000000000
)
ON CONFLICT (id) DO UPDATE SET
  slug              = excluded.slug,
  name              = excluded.name,
  subtitle          = excluded.subtitle,
  description       = excluded.description,
  category          = excluded.category,
  status            = excluded.status,
  hero_image        = excluded.hero_image,
  images_json       = excluded.images_json,
  ingredients       = excluded.ingredients,
  allergens         = excluded.allergens,
  shelf_life_months = excluded.shelf_life_months,
  storage_note      = excluded.storage_note,
  is_veg            = excluded.is_veg,
  sort_order        = excluded.sort_order,
  updated_at        = excluded.updated_at;

-- The next two products ship as 'draft': invisible to the storefront, fully
-- present in the admin. They exist in the seed on purpose — the brand is a
-- multi-category food brand, not a pickle shop, and a catalogue that only ever
-- holds pickles lets category-blind assumptions (one GST rate, one HSN code,
-- one shelf life, one storage rule) creep into the code unnoticed.
INSERT INTO products (
  id, slug, name, subtitle, description, category, status,
  hero_image, images_json, ingredients, allergens,
  shelf_life_months, storage_note, is_veg, sort_order, created_at, updated_at
) VALUES (
  'prd_seed_garlicchutney',
  'roasted-garlic-chutney',
  'Roasted Garlic Chutney',
  'Hand-made in Bangalore · Small Batch',
  'Whole garlic cloves roasted until they turn sweet, then ground down with red chilli, tamarind and sesame oil. Savoury and warm rather than sharp. A spoonful carries curd rice, dosa or a plain paratha.',
  'chutney',
  'draft',
  NULL,
  '[]',
  'Garlic (55%), Sesame Oil, Red Chilli, Tamarind, Salt, Cumin, Asafoetida.',
  'Contains Sesame.',
  6,
  'Store in a cool, dry place away from direct sunlight. Refrigerate after opening. Always use a clean, dry spoon.',
  1,
  20,
  1784000000000,
  1784000000000
)
ON CONFLICT (id) DO UPDATE SET
  slug              = excluded.slug,
  name              = excluded.name,
  subtitle          = excluded.subtitle,
  description       = excluded.description,
  category          = excluded.category,
  status            = excluded.status,
  hero_image        = excluded.hero_image,
  images_json       = excluded.images_json,
  ingredients       = excluded.ingredients,
  allergens         = excluded.allergens,
  shelf_life_months = excluded.shelf_life_months,
  storage_note      = excluded.storage_note,
  is_veg            = excluded.is_veg,
  sort_order        = excluded.sort_order,
  updated_at        = excluded.updated_at;

INSERT INTO products (
  id, slug, name, subtitle, description, category, status,
  hero_image, images_json, ingredients, allergens,
  shelf_life_months, storage_note, is_veg, sort_order, created_at, updated_at
) VALUES (
  'prd_seed_gheecookies',
  'ghee-jaggery-cookies',
  'Ghee and Jaggery Cookies',
  'Hand-made in Bangalore · Small Batch',
  'Short, crumbly cookies baked with cow ghee and jaggery in place of refined sugar. Cardamom, a little cashew, and nothing else. Made for the evening cup of chai.',
  'cookie',
  'draft',
  NULL,
  '[]',
  'Whole Wheat Flour, Jaggery, Cow Ghee, Cashew, Cardamom, Salt, Baking Soda.',
  'Contains Wheat (Gluten), Milk (Ghee) and Tree Nuts (Cashew).',
  3,
  'Store in a cool, dry place in an airtight tin. Best eaten within two weeks of opening. Do not refrigerate, as the cookies go soft.',
  1,
  30,
  1784000000000,
  1784000000000
)
ON CONFLICT (id) DO UPDATE SET
  slug              = excluded.slug,
  name              = excluded.name,
  subtitle          = excluded.subtitle,
  description       = excluded.description,
  category          = excluded.category,
  status            = excluded.status,
  hero_image        = excluded.hero_image,
  images_json       = excluded.images_json,
  ingredients       = excluded.ingredients,
  allergens         = excluded.allergens,
  shelf_life_months = excluded.shelf_life_months,
  storage_note      = excluded.storage_note,
  is_veg            = excluded.is_veg,
  sort_order        = excluded.sort_order,
  updated_at        = excluded.updated_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- Variants
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `shipping_weight_grams` is the packed weight the courier actually bills on:
-- net product + glass jar + carton + filler, per PACKAGING.md. It is stored
-- rather than derived because it is a property of how this SKU is packed, and
-- couriers charge on 500 g slabs, so an approximation costs real money.
--
-- `hsn_code` and `gst_rate_bps` live on the variant, not on a global setting.
-- That is what lets a cookie at 18% (HSN 1905) sit in the same cart as a pickle
-- at 12% (HSN 2001) without a schema change or a special case at checkout.
--
-- `compare_at_price_paise` is left NULL everywhere. A struck-through price the
-- product was never actually sold at is a lie the storefront would render.

INSERT INTO product_variants (
  id, product_id, sku, name, weight_grams, shipping_weight_grams,
  price_paise, compare_at_price_paise, hsn_code, gst_rate_bps,
  status, sort_order, created_at, updated_at
) VALUES
  (
    'var_seed_mango250', 'prd_seed_mangopickle', 'MGS-MMP-250', '250 g',
    250, 500, 29900, NULL, '20019000', 1200, 'active', 10,
    1784000000000, 1784000000000
  ),
  (
    'var_seed_mango500', 'prd_seed_mangopickle', 'MGS-MMP-500', '500 g',
    500, 750, 49900, NULL, '20019000', 1200, 'active', 20,
    1784000000000, 1784000000000
  ),
  (
    'var_seed_chutney200', 'prd_seed_garlicchutney', 'MGS-RGC-200', '200 g',
    200, 450, 24900, NULL, '21039040', 1200, 'active', 10,
    1784000000000, 1784000000000
  ),
  (
    'var_seed_cookies250', 'prd_seed_gheecookies', 'MGS-GJC-250', '250 g',
    250, 450, 34900, NULL, '19053100', 1800, 'active', 10,
    1784000000000, 1784000000000
  )
ON CONFLICT (id) DO UPDATE SET
  product_id             = excluded.product_id,
  sku                    = excluded.sku,
  name                   = excluded.name,
  weight_grams           = excluded.weight_grams,
  shipping_weight_grams  = excluded.shipping_weight_grams,
  price_paise            = excluded.price_paise,
  compare_at_price_paise = excluded.compare_at_price_paise,
  hsn_code               = excluded.hsn_code,
  gst_rate_bps           = excluded.gst_rate_bps,
  status                 = excluded.status,
  sort_order             = excluded.sort_order,
  updated_at             = excluded.updated_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- Inventory
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ON CONFLICT DO NOTHING, and this is the one place in the file where that is
-- not interchangeable with DO UPDATE: re-seeding must never silently reset live
-- stock counts. These numbers seed a variant the first time it appears and are
-- never written again — after that, on_hand belongs to sales, restocks and the
-- inventory_ledger, and a catalogue copy fix run against production must not
-- quietly hand the shop back 48 jars it does not have.
--
-- Correcting a count is a deliberate act with a paper trail (an admin stock
-- adjustment, which writes inventory_ledger), not a side effect of this file.

INSERT INTO inventory (variant_id, on_hand, reserved, reorder_level, track, updated_at) VALUES
  ('var_seed_mango250',   48, 0, 6, 1, 1784000000000),
  ('var_seed_mango500',   24, 0, 6, 1, 1784000000000),
  -- Draft products cannot be bought, but the row exists from day one so the
  -- admin stock screen and the low-stock report never have to handle a missing
  -- inventory row for a variant that is about to go live.
  ('var_seed_chutney200',  0, 0, 6, 1, 1784000000000),
  ('var_seed_cookies250',  0, 0, 6, 1, 1784000000000)
ON CONFLICT (variant_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Coupons
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `value` is type-dependent: 'percent' stores basis points (10% = 1000),
-- 'fixed' stores paise, 'free_shipping' ignores it entirely and stores 0.
--
-- `used_count` is deliberately absent from every DO UPDATE clause below. It is
-- a running total that coupon_redemptions is the ledger for, so re-seeding must
-- not reset it — an exhausted single-use code springing back to life is the
-- coupon equivalent of resetting stock.

-- First-order welcome code. per_user_limit 1 is belt-and-braces on top of
-- first_order_only: the latter is checked against order history, the former
-- against redemptions, and a guest who later registers can slip past one alone.
INSERT INTO coupons (
  id, code, description, type, value,
  min_subtotal_paise, max_discount_paise, starts_at, ends_at,
  usage_limit, per_user_limit, used_count, first_order_only,
  status, provider_discount_id, created_at, updated_at
) VALUES (
  'cpn_seed_welcome10',
  'WELCOME10',
  '10% off your first order of ₹499 or more.',
  'percent',
  1000,
  49900,
  NULL,
  NULL,
  NULL,
  NULL,
  1,
  0,
  1,
  'active',
  NULL,
  1784000000000,
  1784000000000
)
ON CONFLICT (id) DO UPDATE SET
  code               = excluded.code,
  description        = excluded.description,
  type               = excluded.type,
  value              = excluded.value,
  min_subtotal_paise = excluded.min_subtotal_paise,
  max_discount_paise = excluded.max_discount_paise,
  starts_at          = excluded.starts_at,
  ends_at            = excluded.ends_at,
  usage_limit        = excluded.usage_limit,
  per_user_limit     = excluded.per_user_limit,
  first_order_only   = excluded.first_order_only,
  status             = excluded.status,
  updated_at         = excluded.updated_at;

-- Free shipping below the ₹999 default threshold in DEFAULT_SETTINGS, which is
-- the whole point of the code: it pulls a one-jar basket up to two jars.
INSERT INTO coupons (
  id, code, description, type, value,
  min_subtotal_paise, max_discount_paise, starts_at, ends_at,
  usage_limit, per_user_limit, used_count, first_order_only,
  status, provider_discount_id, created_at, updated_at
) VALUES (
  'cpn_seed_freeship',
  'FREESHIP',
  'Free delivery on orders of ₹699 or more.',
  'free_shipping',
  0,
  69900,
  NULL,
  NULL,
  NULL,
  NULL,
  1,
  0,
  0,
  'active',
  NULL,
  1784000000000,
  1784000000000
)
ON CONFLICT (id) DO UPDATE SET
  code               = excluded.code,
  description        = excluded.description,
  type               = excluded.type,
  value              = excluded.value,
  min_subtotal_paise = excluded.min_subtotal_paise,
  max_discount_paise = excluded.max_discount_paise,
  starts_at          = excluded.starts_at,
  ends_at            = excluded.ends_at,
  usage_limit        = excluded.usage_limit,
  per_user_limit     = excluded.per_user_limit,
  first_order_only   = excluded.first_order_only,
  status             = excluded.status,
  updated_at         = excluded.updated_at;

-- Last Diwali's code, kept in the seed as a fixture rather than as a promotion.
-- It is disabled AND its window closed in November 2025, so it exercises both
-- rejection branches of the coupon validator and gives the checkout UI a real
-- row to render "this code is no longer valid" against. Without it, the invalid
-- coupon path is only ever tested with a code that does not exist at all, which
-- is a different code path and a different error message.
INSERT INTO coupons (
  id, code, description, type, value,
  min_subtotal_paise, max_discount_paise, starts_at, ends_at,
  usage_limit, per_user_limit, used_count, first_order_only,
  status, provider_discount_id, created_at, updated_at
) VALUES (
  'cpn_seed_diwali25',
  'DIWALI25',
  'Diwali 2025 gifting offer. Expired.',
  'percent',
  1500,
  99900,
  20000,
  1760000000000,
  1763000000000,
  200,
  1,
  0,
  0,
  'disabled',
  NULL,
  1760000000000,
  1784000000000
)
ON CONFLICT (id) DO UPDATE SET
  code               = excluded.code,
  description        = excluded.description,
  type               = excluded.type,
  value              = excluded.value,
  min_subtotal_paise = excluded.min_subtotal_paise,
  max_discount_paise = excluded.max_discount_paise,
  starts_at          = excluded.starts_at,
  ends_at            = excluded.ends_at,
  usage_limit        = excluded.usage_limit,
  per_user_limit     = excluded.per_user_limit,
  first_order_only   = excluded.first_order_only,
  status             = excluded.status,
  updated_at         = excluded.updated_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- Settings
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Intentionally not seeded. DEFAULT_SETTINGS in src/lib/settings.ts already
-- produces a working store, and `settings` holds overrides only. Writing a full
-- row here would freeze today's defaults into the database, so every later
-- change to DEFAULT_SETTINGS would silently fail to reach any store that had
-- ever been seeded.
--
-- The first admin user is not seeded either: a password hash cannot be written
-- by hand. See scripts/seed-admin.sql.example.
