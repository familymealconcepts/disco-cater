-- 011_disco_stripe_facts.sql
-- Peter, 2026-10-29 (reporting audit decisions 3 and 4): reports show what Stripe ACTUALLY
-- charged as a fee, transferred and reversed — not Disco's estimate of it — and on future
-- orders the restaurant bears Stripe's actual fee.
--
-- Reports are built from Neon (scheduled reports can't call Stripe per row), so Stripe's facts
-- for each Disco-processed order are copied here by the sync-stripe-facts cron
-- (lib/order/stripe-facts.ts). FamilyMeal-copied orders are never synced (Peter: nothing
-- involving FamilyMeal-copied orders).
--
-- Amounts in dollars, like every other money column here. Additive: two new tables.

CREATE TABLE IF NOT EXISTS disco_order_stripe_facts (
  order_reference   TEXT PRIMARY KEY CHECK (btrim(order_reference) <> ''),
  captured          NUMERIC(12, 2) NOT NULL DEFAULT 0,   -- every successful charge on the order
  refunded          NUMERIC(12, 2) NOT NULL DEFAULT 0,   -- Stripe's amount_refunded, however the refund was made
  stripe_fee        NUMERIC(12, 2) NOT NULL DEFAULT 0,   -- Stripe's actual fee (balance transactions)
  fee_known         BOOLEAN NOT NULL DEFAULT true,       -- false while a charge has no balance transaction yet
  transferred       NUMERIC(12, 2) NOT NULL DEFAULT 0,   -- every transfer to the restaurant for this order
  reversed          NUMERIC(12, 2) NOT NULL DEFAULT 0,   -- reversals of those, except refund-fee recoveries
  invoice_status    TEXT,                                -- newest invoice's Stripe status (invoice orders)
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- charge/transfer ids, for tracing
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS disco_order_stripe_facts_synced ON disco_order_stripe_facts (synced_at);

-- One row per charge settled to Stripe's actual fee (lib/order/stripe-fee-trueup.ts).
-- delta = actual − estimate the transfer was computed with (cents in `detail`): > 0 is taken
-- back from the restaurant's payout by reversal, < 0 is paid to it by transfer.
CREATE TABLE IF NOT EXISTS disco_stripe_fee_trueups (
  id                   BIGSERIAL PRIMARY KEY,
  stripe_charge_id     TEXT NOT NULL UNIQUE,
  order_reference      TEXT NOT NULL CHECK (btrim(order_reference) <> ''),
  payout_transfer_id   TEXT,
  estimated_fee        NUMERIC(12, 2),
  actual_fee           NUMERIC(12, 2),
  delta                NUMERIC(12, 2),
  settled_amount       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status               TEXT NOT NULL CHECK (status IN ('pending', 'settled', 'no_difference', 'uncollected', 'skipped', 'failed')),
  reason               TEXT,
  detail               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS disco_stripe_fee_trueups_order ON disco_stripe_fee_trueups (order_reference);
