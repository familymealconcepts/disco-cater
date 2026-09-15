/**
 * Retry sweep for third-party delivery orders that never got a courier.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 * Dispatch fires EXACTLY ONCE, on payment success (native-payment-succeeded.ts, via the Stripe
 * payment_intent.succeeded webhook). There is no retry anywhere else in the codebase. So an order
 * paid while dlivrd is unreachable — or while our credentials are wrong — burns its only trigger
 * and is stranded permanently, with `expedite_delivery_id` left NULL and nothing to notice.
 *
 * That is not hypothetical. On 2026-09-11 the outbound Expedite secret was regenerated while it
 * served both inbound and outbound, every dispatch began returning 401 "Auth failure. Hash
 * mismatch", and FOUR orders worth $1,912 went to their delivery dates with no courier booked:
 * #900000139, #900000142, #900000146 and #900000151. Nobody found out until a restaurant phoned
 * in about a driver who never arrived, two hours after the window. Measured over the preceding 90
 * days those four were the ONLY stranded orders — but they were 4 of just 12 native third-party
 * deliveries in that period, so a single bad window stranded a third of them.
 *
 * This sweep is what would have caught all four, days early, automatically.
 *
 * ── THE PICKUP TIME IS THE DEADLINE, NOT THE DELIVERY WINDOW ──────────────────────────────────
 * THE SINGLE MOST IMPORTANT RULE HERE. `order_time` is the customer's requested DROP-OFF. The
 * courier is sent to collect READY_BY_LEAD_MINUTES earlier — 30 minutes — and that earlier
 * instant is the real deadline.
 *
 * Getting this wrong is not theoretical either: #900000146 was reported as "13 minutes left" at
 * 09:47 against its 10:00 window when its actual pickup deadline, 09:30, had already gone by. An
 * order can look comfortably recoverable and be unrecoverable. So this module NEVER reads
 * order_time directly. It builds the REAL payload via buildPayloadFromNeon and reads
 * `tasks[0].event_at` — the exact instant the courier would be told to collect. The gate and the
 * courier therefore cannot disagree about when pickup is, no matter how the lead time, the
 * timezone handling or the ready-by rule change later.
 *
 * ── THE MARGIN, AND WHY 20 MINUTES ────────────────────────────────────────────────────────────
 * "Pickup is in the future" is not sufficient: a dispatch one minute before pickup is useless.
 * dlivrd has to accept the job, find a driver, and get them to the restaurant. Under about twenty
 * minutes there is no realistic runway for that, and what you get is a courier arriving after the
 * food's ready-by has passed — or arriving at nothing and still charging for the trip.
 *
 * 20 minutes also interlocks with the 15-minute cadence: an order is either seen at least one
 * full cycle before its deadline, or it is already inside the margin and gets ALERTED rather than
 * dispatched. There is no window in which the sweep quietly does a useless thing.
 *
 * ── WHAT IT REFUSES TO TOUCH ──────────────────────────────────────────────────────────────────
 *  * Anything that is not THIRD_PARTY_DELIVERY — enforced again inside dispatchExpediteForOrder's
 *    claim, so pickup and own-delivery orders are structurally unreachable.
 *  * Anything not in a PAID status. DUE is what native-payment-succeeded sets on payment (line
 *    121) and is the normal state for an upcoming paid order; PAID is included for completeness.
 *    Everything else is excluded deliberately: RESERVED and UNPAID have not been paid for,
 *    PAYMENT_FAILED and EXPIRED never will be, CANCELED / VOIDED / REFUND / PARTIAL_REFUND are
 *    unwound, and COMPLETED is already over. REOPEN is excluded too — only 12 exist fleet-wide,
 *    none of them native third-party, and booking a courier against an ambiguous status is not a
 *    risk worth taking for a case that does not occur.
 *  * Anything already claimed or booked — `expedite_delivery_id IS NULL` in the query, and then
 *    the atomic claim inside dispatchExpediteForOrder decides for real.
 *
 * ── IDEMPOTENCE AND CONCURRENCY ───────────────────────────────────────────────────────────────
 * This does not implement its own locking. It calls dispatchExpediteForOrder, whose claim flips
 * expedite_delivery_id NULL -> 'PENDING' in a single conditional UPDATE, so exactly one caller
 * can ever proceed for a given order — a second sweep run, or a sweep racing the live webhook,
 * loses the claim and returns without calling dlivrd.
 *
 * VERIFIED, NOT ASSUMED: 2, 5, 10 and 25 concurrent claims against one row each produced exactly
 * ONE winner, and a claim against an already-booked order produced zero
 * (scripts/verify-expedite-dispatch-sweep.ts reproduces it). Two runs back to back therefore
 * cannot create two deliveries.
 *
 * ── IT IS LOUD ON PURPOSE ─────────────────────────────────────────────────────────────────────
 * Every dispatch this sweep performs is an alert, because each one is evidence that the live path
 * failed. A repair job that silently fixes things conceals the outage that made it necessary —
 * the whole reason this week went unnoticed for four days. Orders it CANNOT rescue are alerted
 * separately and more urgently: that is a delivery about to be missed, and a human still has time
 * to telephone the restaurant.
 */
import { sql } from '../db'
import { alertOps } from '../ops-alert'
import { buildPayloadFromNeon, dispatchExpediteForOrder, nativeDispatchEnabled } from '../expedite'

/** Minimum runway between now and pickup for a dispatch to be worth making. See the header. */
export const DISPATCH_MARGIN_MINUTES = 20

/**
 * The whole scheduling decision, as a pure function, so it can be tested exhaustively without a
 * database, a network call, or any risk of booking a courier as a side effect of a test.
 *
 *   'dispatch'   pickup is far enough away to be worth booking
 *   'too-close'  pickup is still ahead but inside the margin — a courier cannot realistically
 *                be found and routed in time, so alert a human instead
 *   'missed'     pickup has already passed; nothing can be done automatically
 *
 * The boundary is inclusive at the margin: exactly DISPATCH_MARGIN_MINUTES of runway dispatches.
 */
export function classifyPickup(
  pickupAt: string | Date,
  now: Date,
  marginMinutes: number = DISPATCH_MARGIN_MINUTES,
): { decision: 'dispatch' | 'too-close' | 'missed'; minutesToPickup: number } {
  const ms = (pickupAt instanceof Date ? pickupAt : new Date(pickupAt)).getTime() - now.getTime()
  const minutesToPickup = Math.round(ms / 60000)
  if (minutesToPickup < 0) return { decision: 'missed', minutesToPickup }
  if (minutesToPickup < marginMinutes) return { decision: 'too-close', minutesToPickup }
  return { decision: 'dispatch', minutesToPickup }
}

/** Statuses that mean "paid and still expected". See the header for every exclusion. */
export const PAID_STATUSES = ['DUE', 'PAID']

/**
 * How far back to look. An order whose date is already behind us cannot have a future pickup, so
 * this is only a cheap bound on the scan; the real decision is always the payload's event_at.
 * One day of slack absorbs timezone edges without letting the scan grow unbounded.
 */
const LOOKBACK_DAYS = 1

export interface SweepCandidate {
  orderNumber: string
  orderId: number
  reference: string
  restaurantName: string
  total: string
  pickupAt: string | null
  minutesToPickup: number | null
}

export interface SweepSummary {
  scanned: number
  dispatched: SweepCandidate[]
  failed: SweepCandidate[]
  tooLate: SweepCandidate[]
  unbuildable: SweepCandidate[]
  skippedDisabled: boolean
}

export async function sweepFailedExpediteDispatches(now: Date = new Date()): Promise<SweepSummary> {
  const summary: SweepSummary = {
    scanned: 0, dispatched: [], failed: [], tooLate: [], unbuildable: [], skippedDisabled: false,
  }

  // Same flag the live path is gated on. If native dispatch is off, this must not quietly become
  // a second way for couriers to be booked.
  if (!nativeDispatchEnabled()) {
    summary.skippedDisabled = true
    return summary
  }

  // NO `.catch(() => [])` ON THIS QUERY, DELIBERATELY. An empty result and a failed query look
  // identical downstream — both produce "scanned 0, nothing to do" — and this sweep exists
  // precisely because a silent nothing-to-do is how four orders reached their delivery dates with
  // no courier. A broken scan must throw, so the route alerts. That is not a hypothetical either:
  // the first version of this query swallowed a real error and reported a clean run while four
  // stranded orders sat in front of it.
  //
  // ${LOOKBACK_DAYS}::int IS LOAD-BEARING. Without the cast the driver sends an untyped
  // parameter, Postgres resolves `CURRENT_DATE - $n` as integer arithmetic, and the whole
  // predicate fails with `operator does not exist: date >= integer`. Never drop the cast.
  const rows = (await sql`
    SELECT id, order_number::text AS order_number, reference::text AS reference,
           restaurant_name, total::text AS total
      FROM disco_orders
     WHERE is_deleted = false
       AND order_type = 'DELIVERY'
       AND delivery_type = 'THIRD_PARTY_DELIVERY'
       AND expedite_delivery_id IS NULL
       AND order_status = ANY(${PAID_STATUSES})
       AND order_date >= CURRENT_DATE - (${LOOKBACK_DAYS}::int)
     ORDER BY order_date, order_time
  `) as Array<{ id: number; order_number: string; reference: string; restaurant_name: string; total: string }>

  summary.scanned = rows.length

  for (const row of rows) {
    const base: SweepCandidate = {
      orderNumber: row.order_number, orderId: row.id, reference: row.reference,
      restaurantName: row.restaurant_name, total: row.total, pickupAt: null, minutesToPickup: null,
    }

    // The gate reads the REAL payload's pickup instant — see the header.
    const payload = await buildPayloadFromNeon(row.reference)
    if (!payload) {
      summary.unbuildable.push(base)
      await alertOps('expedite sweep: could not build a payload for an order with no courier', {
        orderNumber: row.order_number, reference: row.reference, restaurant: row.restaurant_name,
      })
      continue
    }

    const pickupAt = payload.tasks[0].event_at
    const { decision, minutesToPickup: minutes } = classifyPickup(pickupAt, now)
    const candidate: SweepCandidate = { ...base, pickupAt, minutesToPickup: minutes }

    if (decision !== 'dispatch') {
      // Too close, or already gone. Dispatching here books a courier to collect from a window that
      // has closed — they arrive at nothing and may still charge. Alert instead, urgently: if the
      // pickup is merely close rather than past, a phone call can still save the order.
      summary.tooLate.push(candidate)
      await alertOps(
        decision === 'missed'
          ? 'expedite sweep: DELIVERY MISSED — order has no courier and its pickup time has passed'
          : 'expedite sweep: DELIVERY AT RISK — order has no courier and pickup is too close to dispatch',
        {
          orderNumber: row.order_number, restaurant: row.restaurant_name, total: row.total,
          pickupAt, minutesToPickup: minutes, marginMinutes: DISPATCH_MARGIN_MINUTES,
          action: 'call the restaurant and the customer — this will NOT be dispatched automatically',
        },
      )
      continue
    }

    // The claim inside dispatchExpediteForOrder decides whether this run actually proceeds.
    await dispatchExpediteForOrder(row.id)

    const after = (await sql`
      SELECT expedite_delivery_id, expedite_provider_delivery_id, expedite_status, expedite_delivery_fee::text AS fee
        FROM disco_orders WHERE id = ${row.id}
    `.catch(() => [])) as Array<{ expedite_delivery_id: string | null; expedite_provider_delivery_id: string | null; expedite_status: string | null; fee: string | null }>
    const booked = after[0]?.expedite_delivery_id && after[0].expedite_delivery_id !== 'PENDING'

    if (booked) {
      summary.dispatched.push(candidate)
      // Loud by design: a sweep dispatch means the live path failed for this order.
      await alertOps('expedite sweep: dispatched a courier for an order that had none', {
        orderNumber: row.order_number, restaurant: row.restaurant_name, total: row.total,
        pickupAt, minutesToPickup: minutes,
        expediteDeliveryId: after[0]?.expedite_delivery_id,
        providerDeliveryId: after[0]?.expedite_provider_delivery_id,
        fee: after[0]?.fee, status: after[0]?.expedite_status,
        note: 'this order was paid but never got a courier from the live path — check why',
      })
    } else {
      // dispatchExpediteForOrder already alerted with the specific reason (failed dlivrd call,
      // menu-method disagreement, unbuildable payload) or simply lost the claim to another run.
      summary.failed.push(candidate)
    }
  }

  return summary
}
