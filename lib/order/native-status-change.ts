/**
 * Changing a Disco-native order's status — ONE implementation, shared by the
 * restaurant portal and the super-admin portal.
 *
 * ── WHY IT IS SHARED ────────────────────────────────────────────────────────
 * The restaurant portal's route grew a careful sequence: void an open invoice
 * BEFORE cancelling, write Neon as the source of truth, record an event, email
 * the customer on cancellation. The admin portal's equivalent route forwarded
 * straight to FamilyMeal and so did none of it — and for a native order FM has
 * no record at all, so it simply failed. Reimplementing the sequence there would
 * have produced a second door to the same hole, which is how the last few money
 * bugs in this codebase happened. Both routes now call this.
 *
 * Everything the restaurant route's own header explains about WHY still holds
 * and is not repeated here; see app/api/restaurant/orders/[ref]/status/route.ts.
 * The short version, because it is load-bearing:
 *
 *   • STATUS ONLY. Cancelling never refunds. The two are separate deliberate
 *     acts, available in either order.
 *   • The ONE Stripe touch is voiding an OPEN invoice on an UNPAID order being
 *     cancelled. That withdraws a bill which must never be paid; it moves no
 *     money. If the void fails the cancel is REFUSED rather than reported
 *     successful — a cancelled order with a live invoice is the state this
 *     exists to prevent.
 */
import Stripe from 'stripe'
import { runDiscoOrderMigrations, sql } from '../db'
import { sendOrderCancellationEmail } from './cancellation-email'
import { voidUnpaidOrderInvoice } from './invoice-void'
import { alertOps, alertOnce, resolveAlert } from '../ops-alert'
import { orderLink, money, shortError } from '../ops-alert-format'
import { orderFacts, orderLine } from '../ops-alert-facts'

// disco_orders.order_status CHECK set (001_disco_orders.sql).
export const ALLOWED_ORDER_STATUSES = new Set([
  'CART', 'RESERVED', 'DUE', 'COMPLETED', 'CANCELED', 'CANCELLED', 'REFUND', 'REFUNDED',
  'PARTIAL_REFUND', 'EXPIRED', 'VOID', 'VOIDED', 'UNPAID', 'PAID', 'PAYMENT_FAILED', 'REOPEN',
])

/** Normalize the few UI aliases to the canonical Neon status. */
export function normalizeOrderStatus(s: string): string {
  const u = (s || '').toUpperCase()
  if (u === 'COMPLETE') return 'COMPLETED'
  if (u === 'CANCEL') return 'CANCELED'
  if (u === 'REFUND') return 'REFUNDED'
  if (u === 'VOID') return 'VOIDED'
  return u
}

/**
 * Void an OPEN invoice on an UNPAID order that is being cancelled — the one
 * Stripe touch a status change is allowed to make. Exposed separately because
 * the restaurant route must run it BEFORE its best-effort FamilyMeal proxy: the
 * invariant is "withdraw the bill, THEN flip the status", and FM's status counts
 * as a status. A cancel whose void fails is refused, never reported successful.
 */
export async function voidInvoiceBeforeCancel(ref: string, status: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (status !== 'CANCELED' && status !== 'CANCELLED') return { ok: true }
  const key = process.env.STRIPE_SECRET_KEY
  const stripe = key ? new Stripe(key, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1]) : null
  const voided = await voidUnpaidOrderInvoice(ref, stripe)
  if (voided.action === 'failed') {
    console.error('[native-status] invoice void failed — refusing to cancel:', ref, voided.invoiceId, voided.error)
    return {
      ok: false, status: 502,
      error: `This order was not cancelled: its invoice could not be voided, so the customer could still pay it. ${voided.error}`,
    }
  }
  if (voided.action === 'voided') {
    console.log('[native-status] voided invoice before cancel:', ref, voided.invoiceId)
    // ── AN UNPAID BILL WITHDRAWN AFTER THE FOOD WENT OUT (Peter, 23 Oct 2026) ─
    // Voiding an unpaid invoice is right for an order that will not happen. On
    // an order whose delivery/pickup time has already passed it silently writes
    // off money for food that was most likely made and handed over: four Apollo
    // Bagels Williamsburg orders, $599.67, voided this way on 23 Oct with no
    // alert at all. The cancel itself is unchanged; ops is told.
    const facts = await fulfillmentFacts(ref)
    if (facts?.past) {
      const f = await orderFacts(ref)
      await alertOps({
        severity: 'warn',
        headline: `${money(facts.total)} never collected — order #${facts.orderNumber}`,
        lines: [
          orderLine(f, { amount: null, whenLabel: facts.orderType === 'delivery' ? 'delivered' : 'picked up' }) || facts.restaurant,
          'The order was cancelled after its delivery time with its invoice still unpaid, so the invoice was voided.',
        ],
        action: 'if the food went out, bill the customer another way.',
        link: orderLink(f?.reference ?? ref, facts.orderNumber),
        context: { ref, invoiceId: voided.invoiceId, amount: facts.total },
      }).catch(() => null)
    }
  }
  return { ok: true }
}

/**
 * The order's facts for the cancel-time alerts, and whether its delivery/pickup
 * time has already passed — in the RESTAURANT's timezone (a 7:15 AM delivery in
 * New York is past at 7:15 AM Eastern, not at 7:15 AM on a UTC server).
 * Disco never receives Expedite's delivery status, so the date is the signal.
 */
export async function fulfillmentFacts(ref: string): Promise<{
  past: boolean; orderNumber: string; restaurant: string; customer: string; orderType: string; when: string; total: number
} | null> {
  try {
    const rows = (await sql`
      SELECT o.order_number::text AS order_number, COALESCE(o.restaurant_name, rc.name, '') AS restaurant,
             TRIM(CONCAT_WS(' ', o.customer_first_name, o.customer_last_name, NULLIF('(' || COALESCE(o.company_name, '') || ')', '()'), '<' || o.customer_email || '>')) AS customer,
             o.order_type, to_char(o.order_date, 'Dy DD Mon YYYY') || ' ' || COALESCE(to_char(o.order_time, 'HH12:MI AM'), '') AS when_label,
             COALESCE(o.total, 0)::float AS total,
             ((o.order_date + COALESCE(o.order_time, '23:59'::time)) AT TIME ZONE COALESCE(NULLIF(rc.timezone, ''), 'America/New_York')) < NOW() AS past
        FROM disco_orders o LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
       WHERE (o.reference = ${ref}::uuid OR o.fm_order_reference = ${ref}::uuid) AND o.order_date IS NOT NULL
       LIMIT 1
    `) as Array<{ order_number: string; restaurant: string; customer: string; order_type: string; when_label: string; total: number; past: boolean }>
    const r = rows[0]
    if (!r) return null
    return { past: !!r.past, orderNumber: r.order_number, restaurant: r.restaurant, customer: r.customer, orderType: String(r.order_type || '').toLowerCase(), when: r.when_label, total: Number(r.total) || 0 }
  } catch (e) {
    console.error('[native-status] fulfillment facts lookup failed (non-fatal):', e instanceof Error ? e.message : e)
    return null
  }
}

export type StatusChangeResult =
  | { ok: true; orderStatus: string; neon: boolean }
  | { ok: false; status: number; error: string }

/**
 * Apply a status change to the Neon order identified by `ref` (either its own
 * reference or its mirrored FM reference). `source` is recorded on the event and
 * distinguishes who did it.
 */
export async function applyNativeStatusChange(
  ref: string,
  status: string,
  source: 'DISCO_STATUS' | 'ADMIN_STATUS',
  opts?: { invoiceAlreadyVoided?: boolean; deferCancellationEmail?: boolean },
): Promise<StatusChangeResult> {
  if (!ALLOWED_ORDER_STATUSES.has(status)) return { ok: false, status: 400, error: 'Unsupported status' }

  if (!opts?.invoiceAlreadyVoided) {
    const v = await voidInvoiceBeforeCancel(ref, status)
    if (!v.ok) return v
  }

  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`
      UPDATE disco_orders SET order_status = ${status}, updated_at = NOW()
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid
      RETURNING reference, id, expedite_delivery_id
    `) as Array<{ reference: string; id: number; expedite_delivery_id: string | null }>

    if (!rows.length) return { ok: true, orderStatus: status, neon: false }

    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${rows[0].reference}::uuid, 'STATUS_CHANGED', ${JSON.stringify({ status })}::jsonb, ${source})
    `.catch(e => console.error('[native-status] event insert (non-fatal):', e instanceof Error ? e.message : e))

    // Tell the customer. Idempotent, DISCO-source-only and non-throwing inside
    // the helper, so a repeat call or an email failure can never turn a
    // successful cancellation into an error response.
    // ── STAND THE COURIER DOWN ──────────────────────────────────────────────
    // Cancelling an order left a BOOKED Expedite courier booked. Void has
    // always cancelled it (app/api/restaurant/orders/[ref]/void/route.ts:60),
    // and so do both refund routes and the Stripe webhook — Cancel was the one
    // path that did not, so a driver still turned up for an order nobody was
    // making. Found on #900000473 (Apollo Bagels - Hoboken, 19 Oct 2026):
    // delivery_created ok, $30.00 courier fee, cancelled in Disco, never
    // cancelled at Expedite.
    //
    // This sits in applyNativeStatusChange rather than in the status route so
    // EVERY caller that cancels gets it, which is the mistake that created the
    // gap in the first place — the behaviour lived in routes instead of in the
    // one function they all go through.
    //
    // Best-effort and never throws: a courier API that is down must not turn a
    // successful cancellation into an error, because the cancellation is the
    // part the customer and the kitchen depend on. The outcome is written to
    // disco_expedite_deliveries either way, so "was the courier told?" is a
    // query and not a guess — the same reason disco_mirror_alerts exists.
    if ((status === 'CANCELED' || status === 'CANCELLED') && rows[0].expedite_delivery_id) {
      const deliveryId = rows[0].expedite_delivery_id
      let okFlag = false
      let detail = ''
      try {
        const { cancelDelivery } = await import('../expedite')
        const res = await cancelDelivery(deliveryId)
        okFlag = !!res.success
        detail = res.success ? 'cancelled' : String(res.error ?? 'unknown error')
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e)
      }
      console.log(`[native-status] expedite cancel for ${rows[0].reference}: ${okFlag ? 'ok' : 'FAILED — ' + detail}`)
      await sql`
        INSERT INTO disco_expedite_deliveries
          (order_reference, order_id, event, external_delivery_id, ok, response_body, parsed_status)
        VALUES (${rows[0].reference}::uuid, ${rows[0].id}, 'delivery_cancel', ${deliveryId}, ${okFlag},
                ${detail.slice(0, 500)}, ${okFlag ? 'success' : 'failed'})
      `.catch(e => console.error('[native-status] expedite cancel log failed (non-fatal):', e instanceof Error ? e.message : e))
      if (okFlag) {
        // Closes the thread a previous failed cancel opened, if there was one.
        await resolveAlert(`courier-cancel:${String(rows[0].reference).toLowerCase()}`, 'Resolved: Expedite confirmed the cancellation.').catch(() => false)
      }
      if (!okFlag) {
        // A courier can only still turn up for a delivery that hasn't happened.
        // Disco never receives Expedite's delivery status, so the delivery
        // date decides: past → Expedite's refusal is recorded on the order and
        // nobody is paged (23 Oct: three Apollo Bagels deliveries from 28 Sep–
        // 12 Oct paged ops for "NOT stood down"); upcoming → the alert stands.
        const facts = await fulfillmentFacts(rows[0].reference)
        if (facts?.past) {
          await sql`
            INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
            VALUES (${rows[0].reference}::uuid, 'EXPEDITE_CANCEL_AFTER_DELIVERY',
                    ${JSON.stringify({ expediteDeliveryId: deliveryId, reply: detail.slice(0, 300), deliveryWas: facts.when })}::jsonb, ${source})
          `.catch(e => console.error('[native-status] expedite after-delivery note failed (non-fatal):', e instanceof Error ? e.message : e))
        } else {
          const f = await orderFacts(rows[0].reference)
          const n = f?.orderNumber ?? facts?.orderNumber ?? null
          await alertOnce(`courier-cancel:${String(rows[0].reference).toLowerCase()}`, {
            severity: 'urgent',
            headline: `Courier still booked on a cancelled order — ${n ? `#${n}` : rows[0].reference}`,
            lines: [
              orderLine(f, { amount: null }),
              `The order was cancelled but Expedite rejected the cancellation (${shortError(detail, 80).replace(/^expedite (\d{3})$/i, 'error $1')}), so a driver may still turn up and Disco may still be charged the fee.`,
            ],
            action: 'cancel the delivery with Expedite directly.',
            link: orderLink(rows[0].reference, n),
            context: { orderReference: rows[0].reference, expediteDeliveryId: deliveryId, error: detail.slice(0, 200) },
          }).catch(() => false)
        }
      }
    }

    let deferred = false
    if ((status === 'CANCELED' || status === 'CANCELLED') && opts?.deferCancellationEmail) {
      // The portal's Cancel button opens the Refund dialog next. The email waits
      // for that choice so a cancel + refund is ONE email that states the refund
      // (refund route, withCancellation) and a cancel without one is the plain
      // email (cancellation-email route). If neither ever arrives — the tab was
      // closed — sendDeferredCancellationEmails() in an existing hourly cron
      // sends it. See lib/order/cancellation-email.ts.
      // If the deferral can't be recorded, nothing would ever send it — so the
      // email goes out now instead.
      deferred = await sql`
        INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
        VALUES (${rows[0].reference}::uuid, 'CANCELLATION_EMAIL_DEFERRED', '{}'::jsonb, ${source})
      `.then(() => true, e => { console.error('[native-status] deferral record failed — sending now:', e instanceof Error ? e.message : e); return false })
    }
    if ((status === 'CANCELED' || status === 'CANCELLED') && !deferred) {
      const r = await sendOrderCancellationEmail(rows[0].reference, 'DISCO_STATUS')
      if (!r.sent && r.reason !== 'familymeal-order' && r.reason !== 'already-sent') {
        console.error('[native-status] cancellation email not sent:', r.reason)
      }
    }

    return { ok: true, orderStatus: status, neon: true }
  } catch (e) {
    console.error('[native-status] Neon update failed:', e instanceof Error ? e.message : e)
    return { ok: false, status: 500, error: 'Unable to update status' }
  }
}

/**
 * Is this a Disco-native order (a disco_orders row with no FamilyMeal record)?
 * The branch every admin order route needs: FM cannot answer for these at all.
 */
export async function findNativeOrder(ref: string): Promise<{ reference: string; restaurantReference: string } | null> {
  try {
    const rows = (await sql`
      SELECT reference::text AS reference, restaurant_reference::text AS restaurant_reference
        FROM disco_orders
       WHERE reference = ${ref}::uuid AND fm_order_reference IS NULL AND is_deleted = false
       LIMIT 1
    `) as Array<{ reference: string; restaurant_reference: string }>
    return rows.length ? { reference: rows[0].reference, restaurantReference: rows[0].restaurant_reference } : null
  } catch { return null }
}
