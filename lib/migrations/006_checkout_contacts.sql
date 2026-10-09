-- 006_checkout_contacts.sql
-- Abandoned-checkout contact capture: the "recoverable-cart follow-up list" that
-- 004_checkout_funnel.sql's header deliberately left out of the funnel table and
-- said should be a separate, explicit, separately-retained table. This is that
-- table.
--
-- Why it is NOT more columns on disco_checkout_funnel_sessions:
--   * The funnel table is anonymous analytics (stage, cart value, timestamps) and
--     is kept for 90 days. This table holds PII -- a name, email and phone -- and
--     is kept for 30 days (see app/api/cron/cleanup-checkout-funnel). Two
--     retention periods need two tables; a column cannot be expired separately
--     from its row without a second, easy-to-forget UPDATE.
--   * Keeping the PII in its own table means a funnel query can never pull it in
--     by accident, and dropping this feature is one DROP TABLE that leaves the
--     funnel untouched.
--
-- One row per funnel session (session_id is the same random UUID that keys
-- disco_checkout_funnel_sessions, read server-side from the disco_fn_<ref>
-- cookie). Soft link only, no FK, for the same reason 004 gives for
-- order_reference: the two tables' cleanups must never be coupled.
--
-- Two identities per row, kept apart on purpose:
--   * account_*  -- the SIGNED-IN diner, resolved from the server-side customer
--                   session (lib/customer-auth.ts getCustomerSession). Never
--                   taken from the request body.
--   * contact_*  -- what was in the checkout drawer's contact fields. Pre-filled
--                   from the account but editable (people order for someone
--                   else), so it can legitimately differ from account_*.
--
-- contact_entered_at is set once (first capture) and never overwritten; the
-- contact_* fields and updated_at refresh on every re-capture. order_placed_at
-- stays NULL until /api/order/place succeeds for the same session -- a row with
-- it NULL is the abandoned checkout.
--
-- Nothing reads this table yet and nothing sends to anyone from it.
--
-- Idempotent (IF NOT EXISTS), safe to run on every boot/re-run, same pattern
-- as 001-005.

CREATE TABLE IF NOT EXISTS disco_checkout_contacts (
  session_id TEXT PRIMARY KEY,
  restaurant_reference TEXT NOT NULL,
  account_email TEXT NOT NULL,
  account_first_name TEXT,
  account_last_name TEXT,
  contact_first_name TEXT,
  contact_last_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  contact_company TEXT,
  contact_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  order_placed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkout_contacts_restaurant ON disco_checkout_contacts (restaurant_reference);
-- Drives the 30-day retention cleanup (cleanup-checkout-funnel cron).
CREATE INDEX IF NOT EXISTS idx_checkout_contacts_updated_at ON disco_checkout_contacts (updated_at);
