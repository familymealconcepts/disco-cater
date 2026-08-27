/**
 * One-off cleanup for the five orders stranded by the NaN own-delivery-fee bug
 * (2026-08-27): 900000097-098 at The Winkin' Rooster, 900000099-101 at Atlanta
 * Bread - Smyrna.
 *
 * These were written to disco_orders with `total = NaN` (Postgres numeric accepts
 * it) and then failed at PaymentIntent creation with "Invalid integer: NaN", so no
 * charge exists. The hourly reserved-expiry sweep deliberately SKIPS orders with no
 * PaymentIntent rather than guessing, so they sit RESERVED forever and show up in the
 * restaurant's order list as phantom orders.
 *
 * Mirrors the sweep's own expire path exactly — order_status = 'EXPIRED', release any
 * promo hold, record an order event — so these rows end up indistinguishable from an
 * order the sweep retired itself.
 *
 * SAFETY: refuses to touch any row that is not RESERVED with a non-finite total, and
 * re-verifies against live Stripe that no PaymentIntent or charge exists for the
 * order first. That check is the whole reason the sweep skips these: when this was
 * last investigated, 2 of 5 stale RESERVED orders had ALREADY succeeded in Stripe,
 * and expiring by age alone would have buried two paid orders.
 *
 *   npx tsx scripts/expire-nan-total-orders.ts           # dry run (default)
 *   npx tsx scripts/expire-nan-total-orders.ts --apply
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import Stripe from 'stripe'
import { sql } from '../lib/db'
import { recordOrderEvent } from '../lib/order/native-payment-succeeded'
import { releaseNativeRestaurantPromoUse } from '../lib/promo-native'

const APPLY = process.argv.includes('--apply')

interface Row {
  id: number
  reference: string
  order_number: string | number
  restaurant_name: string | null
  customer_email: string
  subtotal: string | null
  total: string | null
  created_at: string
}

/** Release any promo hold attached to this order, mirroring the sweep. */
async function releasePromoForOrder(orderReference: string): Promise<number> {
  const uses = (await sql`
    SELECT id, promo_code_id FROM promo_code_uses WHERE order_reference = ${orderReference}::uuid
  `.catch(() => [])) as { id: number; promo_code_id: number }[]
  let released = 0
  for (const u of uses) {
    try { await releaseNativeRestaurantPromoUse(u.id, u.promo_code_id); released++ } catch { /* best-effort */ }
  }
  return released
}

async function main() {
  const key = process.env.STRIPE_READONLY_KEY || process.env.STRIPE_LIVE_SECRET_KEY
  if (!key) throw new Error('No Stripe key available — cannot verify charges before expiring.')
  const stripe = new Stripe(key)

  // total::text = 'NaN' is the only reliable predicate: NaN != NaN in SQL too, so
  // `total IS NULL OR total <> total` reads oddly and `= 'NaN'::numeric` is false.
  const rows = (await sql`
    SELECT id, reference, order_number, restaurant_name, customer_email,
           subtotal::text AS subtotal, total::text AS total, created_at
    FROM disco_orders
    WHERE order_status = 'RESERVED' AND total::text = 'NaN'
    ORDER BY created_at
  `) as unknown as Row[]

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} RESERVED order(s) with a non-finite total\n`)
  if (!rows.length) { console.log('Nothing to do.'); return }

  // Pull every PI + charge since the day before the earliest row, once, and match
  // by order reference in metadata and by exact amount.
  const gte = Math.floor(Date.parse(String(rows[0].created_at)) / 1000) - 86400
  const [pis, charges] = await Promise.all([
    stripe.paymentIntents.list({ limit: 100, created: { gte } }),
    stripe.charges.list({ limit: 100, created: { gte } }),
  ])

  let expired = 0, refused = 0
  for (const r of rows) {
    const label = `#${r.order_number} ${r.restaurant_name} (${r.customer_email}) subtotal=$${r.subtotal} total=${r.total}`

    // Belt and braces: a linked payment row in our own DB would also disqualify it.
    const linked = (await sql`
      SELECT stripe_payment_intent_id FROM disco_stripe_payments WHERE order_reference = ${r.reference}::uuid
    `.catch(() => [])) as { stripe_payment_intent_id: string | null }[]

    const piHit = pis.data.find(p => JSON.stringify(p.metadata || {}).includes(r.reference))
    const chargeHit = charges.data.find(c => JSON.stringify(c.metadata || {}).includes(r.reference))

    if (linked.length || piHit || chargeHit) {
      refused++
      console.log(`   REFUSED  ${label}`)
      console.log(`            Stripe activity found — leaving RESERVED for a human: ${
        linked.length ? `db payment row ${linked[0].stripe_payment_intent_id}` : piHit ? `PI ${piHit.id} (${piHit.status})` : `charge ${chargeHit!.id}`}`)
      continue
    }

    if (!APPLY) {
      console.log(`   WOULD EXPIRE  ${label} — no PaymentIntent, no charge, no payment row`)
      expired++
      continue
    }

    await sql`UPDATE disco_orders SET order_status = 'EXPIRED', updated_at = NOW() WHERE id = ${r.id}`
    const releasedPromos = await releasePromoForOrder(r.reference)
    await recordOrderEvent(r.reference, 'RESERVED_EXPIRED', {
      paymentIntentId: null,
      paymentIntentStatus: 'never_created',
      reason: 'NaN total from the legacy own-delivery fee shape — PaymentIntent creation rejected by Stripe (Invalid integer: NaN)',
      promoUsesReleased: releasedPromos,
    }, 'NAN_TOTAL_CLEANUP')
    expired++
    console.log(`   EXPIRED  ${label}${releasedPromos ? ` — released ${releasedPromos} promo use(s)` : ''}`)
  }

  console.log(`\n${APPLY ? 'Expired' : 'Would expire'}: ${expired}   Refused (Stripe activity): ${refused}`)
  if (!APPLY) console.log('\nRe-run with --apply to write.')
}

main().catch(e => { console.error(e); process.exit(1) })
