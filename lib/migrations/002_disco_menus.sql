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
