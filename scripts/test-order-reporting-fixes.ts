// Tests for the reporting + fulfillment-time fixes (items a-f). Matches this
// repo's existing test convention (see scripts/test-max-orders-cap.ts): a
// plain tsx script that exercises the REAL code against REAL data and asserts
// expected outcomes — no mocking, no separate test framework.
//
// Usage: npx tsx scripts/test-order-reporting-fixes.ts

import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { neon } from '@neondatabase/serverless'
import { selfDeliveryFulfillmentDateTime, fulfillmentDateTime } from '../lib/order/fulfillment-time'

const sql = neon(process.env.DATABASE_URL as string)

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  :: ${detail}` : ''}`) }
}

async function main() {
  // ── (a) Self-delivery fulfillment time: order time minus 30 minutes ──
  const t1 = selfDeliveryFulfillmentDateTime('2026-08-02', '14:30:00')
  check('self-delivery: 2:30 PM -> 2:00 PM (the reference order)', t1?.date === '2026-08-02' && t1?.time === '14:00:00', JSON.stringify(t1))

  const t2 = selfDeliveryFulfillmentDateTime('2026-08-02', '00:10:00')
  check('self-delivery: day rollover (12:10 AM -> 11:40 PM prior day)', t2?.date === '2026-08-01' && t2?.time === '23:40:00', JSON.stringify(t2))

  const t3 = selfDeliveryFulfillmentDateTime('2026-01-01', '00:15:00')
  check('self-delivery: month+year rollover (Jan 1 00:15 -> Dec 31 prior year 23:45)', t3?.date === '2025-12-31' && t3?.time === '23:45:00', JSON.stringify(t3))

  const t4 = selfDeliveryFulfillmentDateTime('', '14:30:00')
  check('self-delivery: blank date returns null (never throws)', t4 === null)

  // fulfillmentDateTime: only OWN_DELIVERY gets the offset.
  const fPickup = fulfillmentDateTime('OWN_DELIVERY_TYPO_NOT_MATCHED', '2026-08-02', '14:30:00')
  check('fulfillmentDateTime: unrecognized/non-OWN_DELIVERY type is untouched', fPickup?.date === '2026-08-02' && fPickup?.time === '14:30:00', JSON.stringify(fPickup))

  const fSelf = fulfillmentDateTime('OWN_DELIVERY', '2026-08-02', '14:30:00')
  check('fulfillmentDateTime: OWN_DELIVERY applies the -30min offset', fSelf?.date === '2026-08-02' && fSelf?.time === '14:00:00', JSON.stringify(fSelf))

  const fThirdParty = fulfillmentDateTime('NASH_DELIVERY', '2026-08-02', '14:30:00')
  check('fulfillmentDateTime: third-party delivery is untouched (deferred — no Expedite time field yet)', fThirdParty?.date === '2026-08-02' && fThirdParty?.time === '14:30:00', JSON.stringify(fThirdParty))

  const fNull = fulfillmentDateTime('PICKUP', '', '')
  check('fulfillmentDateTime: blank order date/time returns null', fNull === null)

  // ── (d) Reporting: the real order 70627950 / Glen Rock reference case ──
  const glenRockRef = '31e70961-005b-43c9-ab97-0455b69d0343' // Francesca Catering - Glen Rock
  const orderRows = await sql`SELECT id FROM disco_orders WHERE order_number = '70627950'` as { id: number }[]
  check('reference order 70627950 exists in disco_orders', orderRows.length === 1)

  // Real order count for Glen Rock (all-time, not scoped to a date range) —
  // sanity check that disco_orders itself has real history, matching the
  // "318+ orders" the diagnosis found (not asserting an exact number since
  // this can grow, just confirming it's not the ~1 the broken query returned).
  const realCount = await sql`
    SELECT COUNT(*)::int AS n FROM disco_orders
    WHERE restaurant_reference = ${glenRockRef} AND is_deleted = false
      AND order_status IN ('DUE','COMPLETED','PAID','PARTIAL_REFUND','REFUND')
  ` as { n: number }[]
  check('Glen Rock has real order history in disco_orders (not ~1)', (realCount[0]?.n || 0) > 100, `count=${realCount[0]?.n}`)

  // The OLD (broken) query — reproduced here standalone, NOT calling the fixed
  // route — to confirm the INNER JOIN really does collapse to a tiny number,
  // proving the bug this fix addresses is real and the new query differs from it.
  const oldBrokenCount = await sql`
    SELECT COUNT(*)::int AS n
    FROM disco_sale_transactions st
    JOIN disco_orders o ON o.id = st.order_id
    WHERE o.restaurant_reference = ${glenRockRef}
      AND st.transaction_type = 'ORIGINAL'
      AND o.order_status IN ('DUE','COMPLETED','PAID','PARTIAL_REFUND','REFUND')
  ` as { n: number }[]
  check(
    'the OLD inner-join query undercounts Glen Rock (confirms the bug is real)',
    (oldBrokenCount[0]?.n || 0) < (realCount[0]?.n || 0),
    `old(joined)=${oldBrokenCount[0]?.n} new(direct)=${realCount[0]?.n}`,
  )

  // ── (f) Created Date timezone conversion sanity check ──
  // Confirm the AT TIME ZONE expression actually shifts the date for a
  // timestamp near a day boundary (proves the fix isn't a no-op).
  const tzCheck = await sql`
    SELECT
      ('2026-08-02T02:30:00Z'::timestamptz)::date AS utc_date,
      ('2026-08-02T02:30:00Z'::timestamptz AT TIME ZONE 'America/New_York')::date AS ny_date
  ` as { utc_date: string | Date; ny_date: string | Date }[]
  // neon() returns ::date columns as JS Date objects, not strings — use
  // toISOString (UTC-based, matches how Postgres round-trips a DATE value)
  // rather than String()/toString(), which would apply the LOCAL system
  // timezone and could shift the day again, masking the very bug this checks.
  const isoDay = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10)
  const utcDate = isoDay(tzCheck[0]?.utc_date)
  const nyDate = isoDay(tzCheck[0]?.ny_date)
  check(
    'AT TIME ZONE actually shifts the date across the UTC/ET boundary (2:30 AM UTC = prior evening ET)',
    utcDate === '2026-08-02' && nyDate === '2026-08-01',
    `utc=${utcDate} ny=${nyDate}`,
  )

  console.log(`\n=== SUMMARY === ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error('TEST SCRIPT ERROR', e); process.exit(1) })
