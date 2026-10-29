// ONE-TIME catch-up (Peter, 2026-10-29): fill disco_order_stripe_facts for every existing
// Disco-processed order. From then on Stripe's webhook keeps each order current
// (lib/order/stripe-facts.ts refreshStripeFactsForEvent) — there is no scheduled job.
//
// Reads Stripe with the READ-ONLY key (it only reads); writes only disco_order_stripe_facts.
// Safe to re-run: each order's row is replaced with Stripe's current facts.
//   npx tsx scripts/backfill-stripe-facts.ts            # all Disco-processed orders
//   npx tsx scripts/backfill-stripe-facts.ts --missing  # only orders with no row yet
import { config } from 'dotenv'; config({ path: '.env.local', quiet: true } as never)
import Stripe from 'stripe'

const key = process.env.STRIPE_READONLY_KEY || ''
if (!key.startsWith('rk_')) { console.error('Refusing: STRIPE_READONLY_KEY must be a restricted (read-only) key.'); process.exit(1) }
// Two at a time: the live account's rate limit is shared with checkout.
const CONCURRENCY = 2

async function main() {
  const { sql } = await import('../lib/db')
  const { syncOrderStripeFacts } = await import('../lib/order/stripe-facts')
  const stripe = new Stripe(key, { apiVersion: '2025-01-27.acacia', maxNetworkRetries: 5 } as never)
  const missingOnly = process.argv.includes('--missing')
  const refs = ((await sql`
    SELECT o.reference::text AS ref FROM disco_orders o
     WHERE o.fm_order_reference IS NULL AND o.is_deleted = false
       AND (${!missingOnly} OR NOT EXISTS (SELECT 1 FROM disco_order_stripe_facts f WHERE f.order_reference = o.reference::text))
     ORDER BY o.created_at DESC
  `) as { ref: string }[]).map(r => r.ref)
  console.log(`${refs.length} orders to sync`)
  let done = 0, i = 0
  const failed: string[] = []
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < refs.length) {
      const ref = refs[i++]
      try { await syncOrderStripeFacts(stripe as never, ref) } catch (e) { failed.push(ref); console.error('  failed', ref, (e as Error).message) }
      if (++done % 50 === 0) console.log(`  ${done}/${refs.length}`)
    }
  }))
  console.log(`done: ${done - failed.length} synced, ${failed.length} failed`)
  if (failed.length) process.exit(1)
}
main()
