import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import { fmFetch } from '../../../../../../lib/fm-fetch'
import { refundNativeOrderAndRecord } from '../../../../../../lib/order/native-refund'
import { stripeClient } from '../../../../../../lib/order/native-payment'

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

  // ── CANCEL MUST MOVE THE MONEY, NOT JUST THE STATUS ─────────────────────────
  // A native order that has been charged and is now being cancelled has to be
  // refunded FIRST. Before this, cancel was a pure status write with no Stripe call
  // anywhere in it — order 900000104 sat CANCELED in the portal with $293.40 still
  // captured and $277.39 already paid out to the restaurant.
  //
  // A CANCEL THAT HALF-WORKS IS WORSE THAN ONE THAT REFUSES, so on any Stripe
  // failure this returns an error and leaves the status untouched: the restaurant
  // sees the cancel did not take, rather than a cancelled-looking order that is
  // still holding the customer's money. refundNativeOrderAndRecord does Stripe
  // first and writes nothing if it throws.
  //
  // PARTIAL REFUNDS: the outstanding balance is total − already-refunded, so a
  // previously part-refunded order refunds only the remainder and still lands on
  // CANCELED with `refund` equal to the full total. If a prior partial refund
  // already covered everything, there is nothing to charge back and the cancel
  // proceeds as a plain status write.
  if (status === 'CANCELED' || status === 'CANCELLED') {
    const cancelable = (await sql`
      SELECT o.reference::text AS reference,
             COALESCE(NULLIF(o.total, 0),
               (SELECT MAX(sp.total) FROM disco_stripe_payments sp
                 WHERE sp.order_reference = o.reference AND sp.total > 0)) AS total,
             COALESCE(o.refund, 0) AS refund,
             o.order_status,
             EXISTS (SELECT 1 FROM disco_stripe_payments sp
                      WHERE sp.order_reference = o.reference
                        AND sp.stripe_payment_intent_id IS NOT NULL) AS has_payment
      FROM disco_orders o
      WHERE (o.reference = ${ref}::uuid OR o.fm_order_reference = ${ref}::uuid)
        AND o.fm_order_reference IS NULL
      LIMIT 1
    `.catch(() => [])) as Array<{ reference: string; total: string | null; refund: string | null; order_status: string; has_payment: boolean }>

    const row = cancelable[0]
    if (row?.has_payment) {
      const total = Number(row.total) || 0
      const already = Number(row.refund) || 0
      const outstanding = Math.round((total - already) * 100) / 100
      if (outstanding > 0) {
        const stripe = stripeClient(process.env.STRIPE_SECRET_KEY)
        if (!stripe) {
          return NextResponse.json({ error: 'This order has been charged and cannot be cancelled until refunds are available again. Nothing was changed.' }, { status: 503 })
        }
        try {
          const r = await refundNativeOrderAndRecord({
            stripe, orderReference: row.reference, amount: outstanding,
            alreadyRefunded: already, orderTotal: total,
            source: 'DISCO_CANCEL', statusOverride: status,
          })
          await sql`
            INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
            VALUES (${row.reference}::uuid, 'STATUS_CHANGED', ${JSON.stringify({ status, refunded: outstanding, stripeRefundId: r.refundId })}::jsonb, 'DISCO_STATUS')
          `.catch(() => {})
          return NextResponse.json({ ok: true, orderStatus: status, neon: true, refunded: outstanding, stripeRefundId: r.refundId })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.error('[orders/status] cancel refund failed — status NOT changed:', msg)
          return NextResponse.json({
            error: `This order could not be cancelled because the refund failed: ${msg}. The order is unchanged and the customer has not been charged back — please try again or refund it manually.`,
          }, { status: 502 })
        }
      }
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

    return NextResponse.json({ ok: true, orderStatus: status, neon: true })
  } catch (e) {
    console.error('[orders/status] Neon update failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update status' }, { status: 500 })
  }
}
