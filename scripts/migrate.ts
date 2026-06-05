// Schema migration for the recurring-orders feature (Neon Postgres).
//
// Run from the disco-cater folder:
//   npx tsx scripts/migrate.ts
//
// Reads DATABASE_URL from .env.local. Idempotent — every statement uses
// IF NOT EXISTS, so re-running is safe.

import { config } from 'dotenv'
import { neon } from '@neondatabase/serverless'

config({ path: '.env.local' })

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run: vercel env pull .env.local --environment=production')
  process.exit(1)
}

const sql = neon(process.env.DATABASE_URL)

// Each statement runs on its own — the Neon HTTP driver does not support
// multiple statements per round-trip.
const statements: string[] = [
  `CREATE TABLE IF NOT EXISTS recurring_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_fm_reference VARCHAR(255) NOT NULL,
    customer_email VARCHAR(255) NOT NULL,
    customer_first_name VARCHAR(255),
    customer_last_name VARCHAR(255),
    restaurant_reference VARCHAR(255) NOT NULL,
    restaurant_name VARCHAR(255) NOT NULL,
    restaurant_slug VARCHAR(255),
    source_order_reference VARCHAR(255) NOT NULL,
    frequency_type VARCHAR(20) NOT NULL CHECK (frequency_type IN ('WEEKLY', 'BIWEEKLY', 'MONTHLY')),
    repeat_every_day VARCHAR(10) NOT NULL,
    start_date DATE NOT NULL,
    end_kind VARCHAR(10) NOT NULL DEFAULT 'NEVER' CHECK (end_kind IN ('NEVER', 'COUNT', 'DATE')),
    end_count INTEGER,
    end_date DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CANCELED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS recurring_order_occurrences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recurring_order_id UUID NOT NULL REFERENCES recurring_orders(id) ON DELETE CASCADE,
    scheduled_date DATE NOT NULL,
    scheduled_time VARCHAR(20),
    status VARCHAR(30) NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN (
      'SCHEDULED',
      'REMINDER_SENT',
      'CHARGE_ATTEMPTED',
      'CHARGE_FAILED',
      'PAYMENT_REMINDER_SENT',
      'PLACED',
      'CANCELED',
      'SKIPPED'
    )),
    fm_order_reference VARCHAR(255),
    charge_attempted_at TIMESTAMPTZ,
    charge_failed_at TIMESTAMPTZ,
    placed_at TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    cancellation_reason VARCHAR(255),
    cart_snapshot JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recurring_orders_customer ON recurring_orders(customer_fm_reference)`,
  `CREATE INDEX IF NOT EXISTS idx_recurring_orders_status ON recurring_orders(status)`,
  `CREATE INDEX IF NOT EXISTS idx_occurrences_recurring_order ON recurring_order_occurrences(recurring_order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_occurrences_scheduled_date ON recurring_order_occurrences(scheduled_date)`,
  `CREATE INDEX IF NOT EXISTS idx_occurrences_status ON recurring_order_occurrences(status)`,
]

async function main() {
  for (const stmt of statements) {
    await sql.query(stmt)
  }

  const rows = (await sql.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('recurring_orders', 'recurring_order_occurrences')
     ORDER BY table_name`
  )) as { table_name: string }[]

  console.log('Migration complete — tables created:')
  for (const r of rows) console.log(`  - ${r.table_name}`)
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
