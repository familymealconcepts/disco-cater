-- 003_menu_drift.sql
-- FM-side menu drift detection for Disco-native restaurants (Neon Postgres). A
-- converted restaurant's native menu is a frozen snapshot with no ongoing sync
-- back to FM — this table stores the FM menu state captured at last import/
-- verification (the baseline) plus the result of the most recent comparison
-- against FM's CURRENT menu, so an unexpected FM-side edit becomes visible
-- instead of silent. Idempotent (IF NOT EXISTS), so it is safe to run on every
-- boot / re-run.

CREATE TABLE IF NOT EXISTS disco_menu_drift_snapshots (
  restaurant_reference UUID PRIMARY KEY,
  baseline_snapshot JSONB NOT NULL,
  baseline_captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at TIMESTAMPTZ,
  has_drift BOOLEAN NOT NULL DEFAULT false,
  drift_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
