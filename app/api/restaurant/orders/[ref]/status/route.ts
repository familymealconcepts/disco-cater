import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import { fmFetch } from '../../../../../../lib/fm-fetch'
import { applyNativeStatusChange, voidInvoiceBeforeCancel, normalizeOrderStatus, ALLOWED_ORDER_STATUSES } from '../../../../../../lib/order/native-status-change'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i


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
  const status = normalizeOrderStatus(raw)
  if (!ALLOWED_ORDER_STATUSES.has(status)) return NextResponse.json({ error: 'Unsupported status' }, { status: 400 })

  // Ownership: enforce BEFORE the FM proxy so a foreign ref can't mutate FM state either.
  const scope = await assertOrderInScope(ref, ctx)
  if (!scope.ok) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  // Void BEFORE the FM proxy: the invariant is "withdraw the bill, THEN flip the
  // status", and FM's status counts as a status.
  const v = await voidInvoiceBeforeCancel(ref, status)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status })

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

  // Neon write, invoice void, event and cancellation email all live in ONE
  // place now, shared with the super-admin route — see lib/order/native-status-change.ts.
  const r = await applyNativeStatusChange(ref, status, 'DISCO_STATUS', { invoiceAlreadyVoided: true })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true, orderStatus: r.orderStatus, neon: r.neon })
}
