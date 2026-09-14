import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import { fmFetch } from '../../../../../../lib/fm-fetch'
import { sendOrderCancellationEmail } from '../../../../../../lib/order/cancellation-email'
import { voidUnpaidOrderInvoice } from '../../../../../../lib/order/invoice-void'
import Stripe from 'stripe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// disco_orders.order_status CHECK set (001_disco_orders.sql).
const ALLOWED = new Set([
  'CART', 'RESERVED', 'DUE', 'COMPLETED', 'CANCELED', 'CANCELLED', 'REFUND', 'REFUNDED',
  'PARTIAL_REFUND', 'EXPIRED', 'VOID', 'VOIDED', 'UNPAID', 'PAID', 'PAYMENT_FAILED', 'REOPEN',
])

// Normalize the few UI aliases to the canonical Neon status.
function normStatus(s: string): string {
  const u = (s || '').toUpperCase()
  if (u === 'COMPLETE') return 'COMPLETED'
  if (u === 'CANCEL') return 'CANCELED'
  if (u === 'REFUND') return 'REFUNDED'
  if (u === 'VOID') return 'VOIDED'
  return u
}

// PUT /api/restaurant/orders/{ref}/status?orderStatus=...
//
// STATUS ONLY — THIS DELIBERATELY DOES NOT TOUCH STRIPE, including on CANCEL,
// with ONE narrow exception documented immediately below.
// Cancelling and refunding are two separate deliberate actions, available in either
// order: cancel here, refund with the Refund button. A refund-on-cancel coupling was
// built and then reverted on purpose — moving a customer's money as a side effect of
// a status change is not something a restaurant should trigger without choosing it.
//
// THE ONE EXCEPTION — voiding an open invoice on an UNPAID order. This does not
// move money and is not a refund; it withdraws a bill that must never be paid.
// Without it, cancelling left the Stripe invoice payable, and a customer paying a
// cancelled order triggered the payout transfer while the order stayed CANCELED.
// It fires ONLY for CANCEL + order_status UNPAID + an invoice still stored 'open'
// (see lib/order/invoice-void.ts). Every other cancel, including every card order,
// still touches nothing in Stripe. If the void fails, the cancel is REFUSED rather
// than reported as successful — a cancelled order with a live invoice is the exact
// state this exists to prevent.
//
// What makes that safe is elsewhere, and must stay:
//   • CANCELED/CANCELLED and VOID/VOIDED are in REFUNDABLE (app/api/restaurant/
//     orders/route.ts and .../[ref]/route.ts), so the Refund button SURVIVES a
//     cancellation. Cancelling used to hide the only tool for giving the money back
//     — that was the actual bug.
//   • The reconciliation sweep treats CANCELED/VOID as deliberate human states
//     (lib/order/native-payment-reconciliation.ts) instead of reverting them to DUE,
//     which is what makes a cancellation stick at all.
// Remove either and cancelling silently becomes a trap again.
// Neon (disco_orders) is the source of truth — a Disco-native session (no FM
// cookie) used to silently 401 here, so status changes (Complete/Cancel) never
// persisted. We now write Neon directly and attempt the FM proxy best-effort for
// FM-synced orders; an FM failure never blocks the Neon write.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid order reference' }, { status: 400 })

  const raw = req.nextUrl.searchParams.get('orderStatus') || ''
  const status = normStatus(raw)
  if (!ALLOWED.has(status)) return NextResponse.json({ error: 'Unsupported status' }, { status: 400 })

  // Ownership: enforce BEFORE the FM proxy so a foreign ref can't mutate FM state either.
  const scope = await assertOrderInScope(ref, ctx)
  if (!scope.ok) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  // ── Void an open invoice BEFORE cancelling (see THE ONE EXCEPTION above) ──
  // Order matters: void first, then flip the status. If the void succeeds but the
  // status write fails we are left with an un-payable invoice on a still-UNPAID
  // order — recoverable. The reverse (cancelled order, live invoice) is the money
  // bug itself, so it must never be reachable.
  if (status === 'CANCELED' || status === 'CANCELLED') {
    const key = process.env.STRIPE_SECRET_KEY
    const stripe = key ? new Stripe(key, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1]) : null
    const voided = await voidUnpaidOrderInvoice(ref, stripe)
    if (voided.action === 'failed') {
      console.error('[orders/status] invoice void failed — refusing to cancel:', ref, voided.invoiceId, voided.error)
      return NextResponse.json({
        error: `This order was not cancelled: its invoice could not be voided, so the customer could still pay it. ${voided.error}`,
      }, { status: 502 })
    }
    if (voided.action === 'voided') {
      console.log('[orders/status] voided invoice before cancel:', ref, voided.invoiceId)
    }
  }

  // Best-effort FM proxy (FM-synced orders). Uses the user's FM token when present,
  // else the SUPER_ADMIN service account. Never fatal.
  try {
    const headers = await getFmHeaderForRestaurant(ctx)
    const res = await fmFetch(`${FM}/api/orders/${ref}/updateStatus?orderStatus=${encodeURIComponent(raw)}`, {
      method: 'PUT', headers,
    })
    if (!res.ok) console.error('[orders/status] FM updateStatus non-OK (non-fatal):', res.status)
  } catch (e) {
    console.error('[orders/status] FM updateStatus failed (non-fatal):', e instanceof Error ? e.message : e)
  }

  // Neon write — the source of truth for the restaurant portal.
  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`
      UPDATE disco_orders SET order_status = ${status}, updated_at = NOW()
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid
      RETURNING reference
    `) as Array<{ reference: string }>

    if (!rows.length) {
      // No Neon row yet (un-synced FM-only order). The FM proxy above already
      // attempted the change; report ok so the portal reflects it.
      return NextResponse.json({ ok: true, orderStatus: status, neon: false })
    }

    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${rows[0].reference}::uuid, 'STATUS_CHANGED', ${JSON.stringify({ status })}::jsonb, 'DISCO_STATUS')
    `.catch(e => console.error('[orders/status] event insert (non-fatal):', e instanceof Error ? e.message : e))

    // Tell the customer. This route was silent on cancellation while /void was
    // not, so the COMMON cancel path told nobody — and because cancelling is
    // deliberately status-only (it does not refund), that was the exact case
    // where the customer was left holding a charge with no message.
    //
    // Idempotent, DISCO-source-only and non-throwing inside the helper, so a
    // repeat call or an email failure can never turn a successful cancellation
    // into an error response.
    if (status === 'CANCELED' || status === 'CANCELLED') {
      const r = await sendOrderCancellationEmail(rows[0].reference, 'DISCO_STATUS')
      if (!r.sent && r.reason !== 'not-disco-source' && r.reason !== 'already-sent') {
        console.error('[orders/status] cancellation email not sent:', r.reason)
      }
    }

    return NextResponse.json({ ok: true, orderStatus: status, neon: true })
  } catch (e) {
    console.error('[orders/status] Neon update failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update status' }, { status: 500 })
  }
}
