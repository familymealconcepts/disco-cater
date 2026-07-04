-- 002_disco_menus.sql
-- Disco-native menu items + categories (Neon Postgres). Lets Disco own a
-- restaurant's menu without an FM round-trip. Idempotent (IF NOT EXISTS), so it
-- is safe to run on every boot / re-run.

CREATE TABLE IF NOT EXISTS disco_menu_categories (
  id SERIAL PRIMARY KEY,
  reference UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  restaurant_reference UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  position INTEGER DEFAULT 0,
  visible BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disco_menu_items (
  id SERIAL PRIMARY KEY,
  reference UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  restaurant_reference UUID NOT NULL,
  category_reference UUID REFERENCES disco_menu_categories(reference),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price NUMERIC(10,2) DEFAULT 0,
  serves VARCHAR(100),
  visible BOOLEAN DEFAULT true,
  position INTEGER DEFAULT 0,
  image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disco_menu_items_restaurant ON disco_menu_items(restaurant_reference);
CREATE INDEX IF NOT EXISTS idx_disco_menu_categories_restaurant ON disco_menu_categories(restaurant_reference);

-- One category name per restaurant — lets POST /api/restaurant/menu upsert a
-- category by (restaurant_reference, name) when creating an item.
CREATE UNIQUE INDEX IF NOT EXISTS uq_disco_menu_categories_rest_name ON disco_menu_categories(restaurant_reference, name);

-- ── Disco-native MENU records (FM-parity rebuild) ────────────────────────────
-- A restaurant has many menus; each menu owns ordered categories which own
-- ordered items. Mirrors FM's Menu → ItemCategory → MealPackage model, but Disco
-- is source of truth for Disco-native restaurants. FM is reference only.
--   type              ← FM MenuType (GENERAL_CATERING, OFFICE_CATERING,
--                       HOLIDAY_CATERING, MEAL_PREP, PRIVATE_CHEF,
--                       NATIONWIDE_SHIPPING, MERCH, POP_UP)
--   url               ← FM per-menu slug (^[a-z0-9-]+$, unique per restaurant)
--   availability_mode ← 'ALWAYS' | 'CUSTOM' (Custom unlocks start_date/end_date)
--   schedule_config   ← pickup window JSON: { scheduleType: 'SAME_DAY'|'CUSTOM',
--                       days: ['MONDAY',…], sameWindow: {from,to},
--                       perDay: { MONDAY:{from,to}, … } }. FM has NO separate
--                       delivery window — delivery reuses the pickup window.
CREATE TABLE IF NOT EXISTS disco_menus (
  reference UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
  id SERIAL PRIMARY KEY,
  restaurant_reference UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  url VARCHAR(120),
  type VARCHAR(40) NOT NULL DEFAULT 'GENERAL_CATERING',
  description TEXT,
  image_url TEXT,
  visible BOOLEAN NOT NULL DEFAULT true,
  archived BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0,
  availability_mode VARCHAR(10) NOT NULL DEFAULT 'ALWAYS',
  start_date DATE,
  end_date DATE,
  schedule_config JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disco_menus_restaurant ON disco_menus(restaurant_reference);
CREATE UNIQUE INDEX IF NOT EXISTS uq_disco_menus_rest_url ON disco_menus(restaurant_reference, url);

-- Link categories to a specific menu (FM ItemCategory is menu-scoped). Nullable +
-- additive so existing restaurant-scoped Disco-native categories keep working; the
-- new menu-scoped editor populates it. Drop the old restaurant-wide unique index
-- so the same category name can exist in different menus.
ALTER TABLE disco_menu_categories ADD COLUMN IF NOT EXISTS menu_reference UUID;
CREATE INDEX IF NOT EXISTS idx_disco_menu_categories_menu ON disco_menu_categories(menu_reference);
CREATE UNIQUE INDEX IF NOT EXISTS uq_disco_menu_categories_menu_name ON disco_menu_categories(menu_reference, name) WHERE menu_reference IS NOT NULL;
-- Item enable/disable + ordering already exist (visible, position); category too.

-- ── Modifiers (FM addOn) ──────────────────────────────────────────────────────
-- A single selectable option with a name + price. Reused across many modifier
-- groups. Disco-native equivalent of FM's /api/addOns. Restaurant-scoped.
CREATE TABLE IF NOT EXISTS disco_modifiers (
  id SERIAL PRIMARY KEY,
  reference UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  restaurant_reference UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  archived BOOLEAN NOT NULL DEFAULT false,
  visible BOOLEAN NOT NULL DEFAULT true,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disco_modifiers_restaurant ON disco_modifiers(restaurant_reference);

-- ── Modifier groups (FM extraItemsGroup) ─────────────────────────────────────
-- A container of modifiers with selection rules. `external_name`/`sub_external_name`
-- are customer-facing labels; required iff min_selected > 0. Reused across items.
CREATE TABLE IF NOT EXISTS disco_modifier_groups (
  id SERIAL PRIMARY KEY,
  reference UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  restaurant_reference UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  external_name VARCHAR(255),
  sub_external_name VARCHAR(255),
  min_selected INTEGER NOT NULL DEFAULT 0,
  max_selected INTEGER NOT NULL DEFAULT 1,
  archived BOOLEAN NOT NULL DEFAULT false,
  visible BOOLEAN NOT NULL DEFAULT true,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disco_modifier_groups_restaurant ON disco_modifier_groups(restaurant_reference);

-- Group ↔ modifier membership (ordered, many-to-many).
CREATE TABLE IF NOT EXISTS disco_modifier_group_members (
  id SERIAL PRIMARY KEY,
  group_reference UUID NOT NULL,
  modifier_reference UUID NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(group_reference, modifier_reference)
);
CREATE INDEX IF NOT EXISTS idx_disco_mg_members_group ON disco_modifier_group_members(group_reference);

-- Item ↔ group attachment (ordered, with a per-item enable/disable toggle).
CREATE TABLE IF NOT EXISTS disco_item_groups (
  id SERIAL PRIMARY KEY,
  item_reference UUID NOT NULL,
  group_reference UUID NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(item_reference, group_reference)
);
CREATE INDEX IF NOT EXISTS idx_disco_item_groups_item ON disco_item_groups(item_reference);

-- ── Menu money/timing settings (Stage 5) ─────────────────────────────────────
-- Per-menu settings consumed by the native pricer (service charge, tips) + the
-- availability engine (lead time, cutoffs, rolling window) + the order gate
-- (order minimums, max orders/day) + the fulfillment types offered. All additive
-- with safe defaults so existing native menus keep working.
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS offers_pickup BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS offers_delivery BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS service_charge_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS service_charge_name VARCHAR(120);
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS tip_default_type VARCHAR(12) NOT NULL DEFAULT 'PERCENTAGE'; -- PERCENTAGE | CUSTOM | NONE
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS tip_default_value NUMERIC(10,2) NOT NULL DEFAULT 15;
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS pickup_order_minimum NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS delivery_order_minimum NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS max_orders_per_day INTEGER; -- NULL = no limit
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS lead_time_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS rolling_availability_days INTEGER NOT NULL DEFAULT 90;
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS daily_cutoff_time TIME; -- NULL = none
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS hard_cutoff_date DATE; -- NULL = none

-- Delivery settings (Stage 6). JSONB (nested tiers):
--   { method: 'OWN_DELIVERY'|'THIRD_PARTY',
--     own: { primary:{radiusMiles,feeType:'FIXED'|'PERCENT',feeValue},
--            secondary?:{radiusMiles,feeType,feeValue} },
--     thirdPartySubsidyPct: number }
-- OWN_DELIVERY: restaurant delivers + keeps the fee; THIRD_PARTY: Disco dispatches a
-- courier (Expedite) + keeps the fee. Fee is computed server-side from distance.
ALTER TABLE disco_menus ADD COLUMN IF NOT EXISTS delivery_settings JSONB;
