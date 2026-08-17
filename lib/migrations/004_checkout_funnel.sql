-- 004_checkout_funnel.sql
-- Native checkout funnel capture: one mutable, upserted row per browsing
-- session (keyed by a client-generated session id), not an append-only event
-- log — bouncing between steps or re-visiting an earlier stage still yields
-- exactly one row. furthest_stage/furthest_stage_rank only ever move forward
-- (see lib/checkout-funnel.ts's upsert); each per-stage *_at timestamp is set
-- once, on first reach, and never overwritten after.
--
-- Deliberately holds NO name/email/phone. A row with contact details for an
-- order that was never placed is a customer who never completed a
-- transaction — the funnel/conversion/cart-value analysis this table exists
-- for needs none of it. contact_entered is a bare boolean + timestamp; if a
-- recoverable-cart follow-up list is wanted later, that's a new, explicit,
-- separately-retained column (or table) — a deliberate, reversible decision,
-- not a default.
--
-- Idempotent (IF NOT EXISTS), safe to run on every boot/re-run, same pattern
-- as 001-003.

CREATE TABLE IF NOT EXISTS disco_checkout_funnel_sessions (
  session_id TEXT PRIMARY KEY,
  restaurant_reference TEXT NOT NULL,
  fulfillment_type TEXT CHECK (fulfillment_type IN ('PICKUP', 'DELIVERY')),
  furthest_stage TEXT NOT NULL CHECK (furthest_stage IN (
    'DATE_TIME_SELECTED', 'ITEM_ADDED', 'CHECKOUT_READY', 'CHECKOUT_OPENED',
    'CONTACT_ENTERED', 'PAYMENT_ATTEMPTED', 'ORDER_PLACED'
  )),
  furthest_stage_rank SMALLINT NOT NULL,
  cart_value_cents INTEGER,
  item_count INTEGER,
  contact_entered BOOLEAN NOT NULL DEFAULT false,
  -- Soft link only (no FK): this table's 90-day cleanup cron must never be
  -- coupled to disco_orders' retention. Populated once /api/order/place
  -- succeeds; matches disco_orders.reference for the eventual order.
  order_reference UUID,
  date_time_selected_at TIMESTAMPTZ,
  item_added_at TIMESTAMPTZ,
  checkout_ready_at TIMESTAMPTZ,
  checkout_opened_at TIMESTAMPTZ,
  contact_entered_at TIMESTAMPTZ,
  payment_attempted_at TIMESTAMPTZ,
  order_placed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkout_funnel_restaurant ON disco_checkout_funnel_sessions (restaurant_reference);
-- Drives the 90-day retention cleanup cron.
CREATE INDEX IF NOT EXISTS idx_checkout_funnel_updated_at ON disco_checkout_funnel_sessions (updated_at);
CREATE INDEX IF NOT EXISTS idx_checkout_funnel_order_reference ON disco_checkout_funnel_sessions (order_reference) WHERE order_reference IS NOT NULL;
