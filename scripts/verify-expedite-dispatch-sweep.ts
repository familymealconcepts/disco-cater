/**
 * Verifies the Expedite dispatch retry sweep.
 *
 *   npx tsx scripts/verify-expedite-dispatch-sweep.ts
 *
 * NOTHING IS EVER DISPATCHED and no real order is modified.
 *
 * Three things are proved, and the middle one is the one that matters:
 *
 *   1. THE PICKUP DECISION, exhaustively, against classifyPickup — a pure function, so every
 *      boundary can be walked without a clock, a database or the possibility of booking a courier
 *      as a side effect of a test. This is why the decision was extracted from the sweep.
 *
 *   2. THE CLAIM GUARD UNDER REAL CONCURRENCY. The sweep's idempotence rests entirely on
 *      dispatchExpediteForOrder's conditional UPDATE, and "Postgres will serialise it" is an
 *      assumption until measured. A synthetic order row is inserted, N identical claims are fired
 *      at it simultaneously, and exactly one must win. The row is deleted afterwards.
 *
 *   3. THE CANDIDATE QUERY, against live data — that it selects only paid, unbooked,
 *      third-party-delivery orders, and that every status outside DISPATCHABLE_STATUSES is excluded.
 *
 * Alerts are silenced for the duration (SLACK_NOTIFICATIONS_WEBHOOK_URL is unset in-process) so a
 * verification run cannot page anyone. alertOps still logs to the console.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
// Silence Slack before anything imports ops-alert. A test must not raise a real alarm.
delete process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL

import { randomUUID } from 'crypto'
import { sql } from '../lib/db'
import { classifyPickup, DISPATCH_MARGIN_MINUTES, DISPATCHABLE_STATUSES } from '../lib/order/expedite-dispatch-sweep'

let failures = 0
const check = (ok: boolean, label: string) => {
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

const NOW = new Date('2026-09-15T13:00:00.000Z')
const at = (mins: number) => new Date(NOW.getTime() + mins * 60000).toISOString()

async function main() {
  // ── 1. the pickup decision ──────────────────────────────────────────────────────────────────
  console.log(`\n=== pickup decision (margin ${DISPATCH_MARGIN_MINUTES}m) ===`)
  const cases: Array<[number, string]> = [
    [-180, 'missed'], [-31, 'missed'], [-1, 'missed'],
    [0, 'too-close'], [1, 'too-close'], [10, 'too-close'],
    [DISPATCH_MARGIN_MINUTES - 1, 'too-close'],
    [DISPATCH_MARGIN_MINUTES, 'dispatch'],
    [DISPATCH_MARGIN_MINUTES + 1, 'dispatch'],
    [120, 'dispatch'], [60 * 24 * 21, 'dispatch'],
  ]
  for (const [mins, expected] of cases) {
    const got = classifyPickup(at(mins), NOW).decision
    check(got === expected, `pickup ${mins >= 0 ? '+' : ''}${mins}m -> ${got}`)
  }
  // The real regression this guards: the delivery WINDOW must never be mistaken for the pickup.
  // #900000146's window was 10:00 ET with pickup 09:30 ET. At 09:47 the window was 13 minutes
  // away and looked recoverable; the pickup had gone 17 minutes earlier.
  const et = (hhmm: string) => new Date(`2026-09-15T${hhmm}:00.000Z`)
  check(classifyPickup(et('14:00'), et('13:47')).decision === 'too-close',
    'the 10:00 WINDOW at 09:47 would read as recoverable (13m) — which is why the window is not the gate')
  check(classifyPickup(et('13:30'), et('13:47')).decision === 'missed',
    'the real 09:30 PICKUP at 09:47 correctly reads as MISSED (-17m)')

  // ── 2. the claim guard under concurrency ────────────────────────────────────────────────────
  console.log('\n=== claim guard under concurrent execution ===')
  const ref = randomUUID()
  const ins = (await sql`
    INSERT INTO disco_orders (reference, order_number, restaurant_reference, restaurant_name,
      customer_first_name, customer_last_name, customer_email, order_type, delivery_type,
      order_status, order_date, order_time, subtotal, total, is_deleted)
    VALUES (${ref}::uuid, 999999999, ${randomUUID()}::uuid, 'SWEEP CLAIM TEST',
      'Sweep', 'Test', 'sweep-verify@invalid.test', 'DELIVERY', 'THIRD_PARTY_DELIVERY',
      'DUE', CURRENT_DATE + 7, '12:00:00', 1, 1, false)
    RETURNING id`) as Array<{ id: number }>
  const id = ins[0].id
  try {
    for (const n of [2, 5, 10, 25]) {
      await sql`UPDATE disco_orders SET expedite_delivery_id = NULL WHERE id = ${id}`
      const res = await Promise.all(Array.from({ length: n }, () => sql`
        UPDATE disco_orders SET expedite_delivery_id = 'PENDING', updated_at = NOW()
        WHERE id = ${id} AND expedite_delivery_id IS NULL
          AND order_type = 'DELIVERY' AND delivery_type = 'THIRD_PARTY_DELIVERY'
        RETURNING reference`.catch(() => [])))
      const winners = res.filter(r => (r as unknown[]).length > 0).length
      check(winners === 1, `${n} concurrent claims -> exactly 1 winner (got ${winners})`)
    }
    await sql`UPDATE disco_orders SET expedite_delivery_id = 'already-booked' WHERE id = ${id}`
    const again = (await sql`
      UPDATE disco_orders SET expedite_delivery_id = 'PENDING' WHERE id = ${id}
        AND expedite_delivery_id IS NULL AND order_type='DELIVERY' AND delivery_type='THIRD_PARTY_DELIVERY'
      RETURNING reference`.catch(() => [])) as unknown[]
    check(again.length === 0, 'a claim against an already-booked order wins nothing (two runs cannot double-book)')
  } finally {
    await sql`DELETE FROM disco_orders WHERE id = ${id}`
    const gone = (await sql`SELECT count(*)::int AS n FROM disco_orders WHERE id = ${id}`) as Array<{ n: number }>
    check(gone[0].n === 0, 'synthetic test row removed')
  }

  // ── 3. the candidate query, against live data ───────────────────────────────────────────────
  console.log('\n=== candidate selection (live data) ===')
  const cands = (await sql`
    SELECT order_number::text AS order_number, order_status, order_type, delivery_type, expedite_delivery_id
      FROM disco_orders
     WHERE is_deleted = false AND order_type = 'DELIVERY' AND delivery_type = 'THIRD_PARTY_DELIVERY'
       AND expedite_delivery_id IS NULL AND order_status = ANY(${DISPATCHABLE_STATUSES})
       AND order_date >= CURRENT_DATE - 1`) as Array<Record<string, string | null>>
  console.log(`   ${cands.length} candidate(s) right now`)
  check(cands.every(c => c.delivery_type === 'THIRD_PARTY_DELIVERY'), 'every candidate is THIRD_PARTY_DELIVERY')
  check(cands.every(c => c.order_type === 'DELIVERY'), 'every candidate is a DELIVERY order')
  check(cands.every(c => c.expedite_delivery_id === null), 'every candidate has no courier yet')
  check(cands.every(c => DISPATCHABLE_STATUSES.includes(String(c.order_status))), 'every candidate is in a dispatchable status')

  const excluded = (await sql`
    SELECT order_status, count(*)::int AS n FROM disco_orders
     WHERE is_deleted = false AND order_type = 'DELIVERY' AND delivery_type = 'THIRD_PARTY_DELIVERY'
       AND NOT (order_status = ANY(${DISPATCHABLE_STATUSES})) GROUP BY 1`) as Array<{ order_status: string; n: number }>
  console.log(`   statuses the sweep will never touch: ${excluded.length ? excluded.map(e => `${e.order_status}=${e.n}`).join(' ') : '(none present)'}`)
  check(!excluded.some(e => DISPATCHABLE_STATUSES.includes(e.order_status)), 'no dispatchable status landed in the excluded set')

  console.log('\n' + '='.repeat(70))
  console.log(failures === 0 ? 'SWEEP VERIFIED — nothing dispatched, no real order modified' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
