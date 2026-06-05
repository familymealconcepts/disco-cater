// Stripe-charging migration for recurring orders (Neon Postgres).
//
// Run from the disco-cater folder:
//   npx tsx scripts/migrate-stripe.ts
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
  // Stripe customer + saved payment method captured at recurring-order setup,
  // used by the cron to charge off-session.
  `ALTER TABLE recurring_orders ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255)`,
  `ALTER TABLE recurring_orders ADD COLUMN IF NOT EXISTS stripe_payment_method_id VARCHAR(255)`,
  // The source order's total, captured at setup, used as the charge amount when
  // an occurrence's cart snapshot carries no per-item pricing.
  `ALTER TABLE recurring_orders ADD COLUMN IF NOT EXISTS source_order_total DECIMAL(10,2)`,
  // The Stripe PaymentIntent id for a charged occurrence (audit + reconciliation).
  `ALTER TABLE recurring_order_occurrences ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255)`,
]

async function main() {
  for (const stmt of statements) {
    await sql.query(stmt)
  }

  const cols = (await sql.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'recurring_orders' AND column_name IN ('stripe_customer_id', 'stripe_payment_method_id', 'source_order_total'))
         OR (table_name = 'recurring_order_occurrences' AND column_name = 'stripe_payment_intent_id'))
     ORDER BY table_name, column_name`
  )) as { table_name: string; column_name: string }[]

  console.log('Stripe migration complete — columns present:')
  for (const c of cols) console.log(`  - ${c.table_name}.${c.column_name}`)
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
