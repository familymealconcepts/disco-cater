import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import { fmFetch } from '../../../../../../lib/fm-fetch'

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
// STATUS ONLY — THIS DELIBERATELY DOES NOT TOUCH STRIPE, including on CANCEL.
// Cancelling and refunding are two separate deliberate actions, available in either
// order: cancel here, refund with the Refund button. A refund-on-cancel coupling was
// built and then reverted on purpose — moving a customer's money as a side effect of
// a status change is not something a restaurant should trigger without choosing it.
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

    return NextResponse.json({ ok: true, orderStatus: status, neon: true })
  } catch (e) {
    console.error('[orders/status] Neon update failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update status' }, { status: 500 })
  }
}
