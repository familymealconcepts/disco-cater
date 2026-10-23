/**
 * Fills the missing Stripe fee on FamilyMeal-copied sale transactions
 * (source FM_SYNC / FM_LIST) from Stripe, read-only — FamilyMeal is never
 * touched. 23 Oct 2026, after the mirror was found rebuilding these rows with
 * stripe_fee NULL and undoing the 2026-09-23 FM-table backfill.
 *
 * Writes ONLY disco_sale_transactions.stripe_fee, and only where it is NULL.
 * Amounts, status, payouts and transfers are untouched; reports derive Total
 * Distributed from this column at read time. A fee Stripe can't produce stays
 * NULL (never 0, never derived).
 *
 *   npx tsx scripts/backfill-fm-stripe-fees-from-stripe.ts          (dry run)
 *   npx tsx scripts/backfill-fm-stripe-fees-from-stripe.ts --apply
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
import { lookupFmStripeFee } from '../lib/fm-stripe-fee'

const APPLY = process.argv.includes('--apply')

async function main() {
  const rows = (await sql`
    SELECT t.id, t.transaction_status, o.order_number::text AS order_number, o.fm_order_reference::text AS ref, o.order_status
      FROM disco_sale_transactions t JOIN disco_orders o ON o.id = t.order_id
     WHERE t.source IN ('FM_SYNC', 'FM_LIST') AND t.stripe_fee IS NULL AND o.fm_order_reference IS NOT NULL
     ORDER BY t.id`) as Array<{ id: number; transaction_status: string; order_number: string; ref: string; order_status: string }>
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${rows.length} rows with no Stripe fee`)
  const found: Array<{ id: number; fee: number }> = []
  const missing: Record<string, number> = {}
  let i = 0
  const queue = [...rows]
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const r = queue.shift()!
      const f = await lookupFmStripeFee(r.ref)
      if (f) found.push({ id: r.id, fee: f.fee })
      else { const k = `${r.transaction_status}/${r.order_status}`; missing[k] = (missing[k] || 0) + 1 }
      if (++i % 250 === 0) console.log(`  ${i}/${rows.length}`)
    }
  }))
  const total = found.reduce((a, b) => a + b.fee, 0)
  console.log(`fee found in Stripe: ${found.length} rows, total $${total.toFixed(2)}`)
  console.log('no succeeded payment in Stripe (left NULL), by txn/order status:', missing)
  if (!APPLY) return
  let written = 0
  for (let k = 0; k < found.length; k += 100) {
    const c = found.slice(k, k + 100)
    const res = (await sql`
      UPDATE disco_sale_transactions t SET stripe_fee = u.fee, updated_at = NOW()
        FROM unnest(${c.map(x => x.id)}::bigint[], ${c.map(x => x.fee)}::numeric[]) AS u(id, fee)
       WHERE t.id = u.id AND t.stripe_fee IS NULL
      RETURNING 1`) as unknown[]
    written += res.length
  }
  console.log(`written: ${written}`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
