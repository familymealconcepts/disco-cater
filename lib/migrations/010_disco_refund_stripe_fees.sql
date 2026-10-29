-- 010_disco_refund_stripe_fees.sql
-- The Stripe processing fee on a refunded Disco payment, and who paid it. Peter, 2026-10-29: the
-- RESTAURANT bears the Stripe fee on a refund, not Disco. Stripe keeps its fee when a charge is
-- refunded, and the restaurant's payout was already net of that fee, so without this Disco paid it
-- (#900000747: $10.97).
--
-- One row per refund. fee_amount is the refunded share of the charge's Stripe fee; recovered_amount
-- is what was taken back from the restaurant by transfer reversal (its own payout first, then its
-- other recent payouts), each reversal listed in `sources`. Anything not recovered is 'uncollected':
-- Disco is covering it until Super Admin's "Recover Stripe fee" takes it from a later payout.
--
-- Written by lib/order/refund-stripe-fee.ts; read by reports (Total Distributed), order details and
-- Super Admin. Additive: one new table, nothing else touched. Applies to refunds from 2026-10-29 on —
-- past refunds are deliberately not recovered.

CREATE TABLE IF NOT EXISTS disco_refund_stripe_fees (
  id                   BIGSERIAL PRIMARY KEY,
  order_reference      TEXT NOT NULL CHECK (btrim(order_reference) <> ''),
  restaurant_reference TEXT,
  stripe_refund_id     TEXT NOT NULL UNIQUE,
  stripe_charge_id     TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  via                  TEXT NOT NULL,
  refund_amount        NUMERIC(12, 2) NOT NULL CHECK (refund_amount >= 0),
  fee_amount           NUMERIC(12, 2) NOT NULL CHECK (fee_amount >= 0),
  recovered_amount     NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (recovered_amount >= 0 AND recovered_amount <= fee_amount),
  status               TEXT NOT NULL CHECK (status IN ('pending', 'recovered', 'uncollected')),
  -- [{transferId, reversalId, amount, how: 'own_payout'|'other_payout', manual, at, by}]
  sources              JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS disco_refund_stripe_fees_order ON disco_refund_stripe_fees (order_reference);
CREATE INDEX IF NOT EXISTS disco_refund_stripe_fees_status ON disco_refund_stripe_fees (status, created_at);
