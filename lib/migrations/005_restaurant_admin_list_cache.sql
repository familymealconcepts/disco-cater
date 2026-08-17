-- Full FM restaurant admin-list cache for manage-restaurants/ordering.
-- Populated by a 15-min background cron (lib/restaurant-admin-list-cache.ts)
-- instead of that admin page calling FM directly on every load (measured to
-- 504 under the concurrent-page-fetch pattern it used to run client-side).
--
-- Two tables with IDENTICAL schemas: the cron always writes into _staging,
-- then swaps it in for the live table via an atomic three-way RENAME — only
-- after every row is accounted for against FM's reported totalElements. A
-- partial/failed run never reaches this table; the previous good snapshot
-- keeps serving. Because a swap can flip which physical table holds which
-- name, any FUTURE column addition must ALTER TABLE both names identically.

CREATE TABLE IF NOT EXISTS disco_restaurant_admin_list_cache (
  restaurant_reference TEXT PRIMARY KEY,
  raw JSONB NOT NULL,
  business_name TEXT,
  restaurant_status TEXT,
  admin_email TEXT,
  created_date TIMESTAMPTZ,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disco_restaurant_admin_list_cache_staging (
  restaurant_reference TEXT PRIMARY KEY,
  raw JSONB NOT NULL,
  business_name TEXT,
  restaurant_status TEXT,
  admin_email TEXT,
  created_date TIMESTAMPTZ,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Single-row sync status: last successful swap (what the live table reflects)
-- kept separate from the last attempt (which may have failed), so a read can
-- tell "the cache is complete as of X" from "the cron has been failing since Y"
-- without those two facts overwriting each other.
CREATE TABLE IF NOT EXISTS disco_restaurant_admin_list_sync_meta (
  id INT PRIMARY KEY DEFAULT 1,
  last_success_at TIMESTAMPTZ,
  last_success_total INT,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT disco_restaurant_admin_list_sync_meta_single_row CHECK (id = 1)
);

INSERT INTO disco_restaurant_admin_list_sync_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
