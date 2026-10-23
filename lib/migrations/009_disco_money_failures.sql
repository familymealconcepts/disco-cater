-- 009_disco_money_failures.sql
-- Refund money that went wrong, recorded so NM OS's ops watch can raise it as a suggestion and,
-- where the marketplace can see it was fixed, close it. Until this, Slack (#ops-alerts) was the only
-- record. Written by lib/order/money-failures.ts beside the existing alerts in lib/order/native-refund.ts;
-- read by NM OS as crm_readonly. Approved by Kevin, 2026-10-23 (orchestrator item #30).
--
-- Kinds:
--   refund_refused           the restaurant's Stripe balance could not cover the reversal, so the refund
--                            was refused and nothing moved (assertReversalIsFunded)
--   payout_not_reversed      the diner was refunded but taking the restaurant's share back failed; Disco
--                            is out that amount until it is reversed by hand in Stripe
--   refund_from_disco_funds  an invoice order with no payout transfer was refunded from Disco's own
--                            funds. Recorded only (never a suggestion); its weekly total goes in the
--                            Omakase brief
-- via: which caller started the refund (refundNativeOrder has four).
--
-- Append-only, one row per failure, no personal data (no names, emails or phones). Additive: one new
-- table, nothing else touched. Applied with a short lock_timeout and read back on a fresh connection.

CREATE TABLE IF NOT EXISTS disco_money_failures (
  id                 BIGSERIAL PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('refund_refused', 'payout_not_reversed', 'refund_from_disco_funds')),
  via                TEXT NOT NULL CHECK (via IN ('admin_refund', 'restaurant_refund', 'order_edit', 'sold_out_auto_refund', 'unknown')),
  order_reference    TEXT NOT NULL CHECK (btrim(order_reference) <> ''),
  refund_amount      NUMERIC(12, 2) CHECK (refund_amount >= 0),
  needed_amount      NUMERIC(12, 2) CHECK (needed_amount >= 0),
  held_amount        NUMERIC(12, 2),
  stripe_transfer_id TEXT,
  stripe_error       TEXT CHECK (length(stripe_error) <= 300),
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A refusal says how short the balance was; a failed reversal names the transfer to reverse.
  CONSTRAINT disco_money_failures_refused_shape CHECK (kind <> 'refund_refused' OR (needed_amount IS NOT NULL AND held_amount IS NOT NULL)),
  CONSTRAINT disco_money_failures_not_reversed_shape CHECK (kind <> 'payout_not_reversed' OR stripe_transfer_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS disco_money_failures_order ON disco_money_failures (order_reference, occurred_at);
CREATE INDEX IF NOT EXISTS disco_money_failures_kind ON disco_money_failures (kind, occurred_at);

GRANT SELECT ON disco_money_failures TO crm_readonly;
