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
  if (voided.action === 'voided') console.log('[native-status] voided invoice before cancel:', ref, voided.invoiceId)
  return { ok: true }
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
  opts?: { invoiceAlreadyVoided?: boolean },
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
      RETURNING reference
    `) as Array<{ reference: string }>

    if (!rows.length) return { ok: true, orderStatus: status, neon: false }

    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${rows[0].reference}::uuid, 'STATUS_CHANGED', ${JSON.stringify({ status })}::jsonb, ${source})
    `.catch(e => console.error('[native-status] event insert (non-fatal):', e instanceof Error ? e.message : e))

    // Tell the customer. Idempotent, DISCO-source-only and non-throwing inside
    // the helper, so a repeat call or an email failure can never turn a
    // successful cancellation into an error response.
    if (status === 'CANCELED' || status === 'CANCELLED') {
      const r = await sendOrderCancellationEmail(rows[0].reference, 'DISCO_STATUS')
      if (!r.sent && r.reason !== 'not-disco-source' && r.reason !== 'already-sent') {
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
