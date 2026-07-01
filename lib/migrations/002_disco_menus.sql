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
