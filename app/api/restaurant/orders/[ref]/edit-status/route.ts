import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { getRestaurantRole } from '../../../../../../lib/restaurant-auth'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import {
  getDiscoOrder, loadFmOrderDetails, parseFmOrder, hoursUntil, isEditableStatus, MAX_EDITS, applyPendingEdit,
  isOrderInPast, loadRestaurantTimeZone, RESTAURANT_TZ_DEFAULT,
} from '../../../../../../lib/order-edit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])
}

// GET — edit eligibility for an order, read from Disco's Neon state (with an FM
// fallback for pickup/status when the order isn't mirrored in disco_orders yet).
// Also resolves a stale pending edit: if edit_status='pending_payment' and the
// Stripe invoice is now paid, the edit is applied here (so the page opens in a
// clean state); if still open, the order is returned read-only (awaiting payment).
//   → { editCount, canEdit, reason, editStatus, pendingPayment }
export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  // Admin portal (fm_admin_token) can read eligibility too — treated as SUPER_ADMIN.
  const ctx = await getRestaurantAuthContext()
  let isAdminEdit = false
  if (!ctx) {
    try { await getAdminAuthHeader(); isAdminEdit = true }
    catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  } else {
    // Restaurant session: scope to its own order (this GET can auto-apply a
    // pending edit + settle a Stripe invoice). Admin portal is exempt.
    const scope = await assertOrderInScope(ref, ctx)
    if (!scope.ok) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  try { await runDiscoOrderMigrations() } catch { /* best-effort */ }

  let order = await getDiscoOrder(ref)
  let editStatus: string | null = order?.edit_status ?? null
  let pendingPayment = false

  // Resolve a pending edit before deciding eligibility.
  if (order && editStatus === 'pending_payment') {
    const prows = (await sql`
      SELECT pending_stripe_invoice_id, pending_edit_data FROM disco_orders WHERE id = ${order.id} LIMIT 1
    `.catch(() => [])) as { pending_stripe_invoice_id: string | null; pending_edit_data: Record<string, unknown> | null }[]
    const invoiceId = prows[0]?.pending_stripe_invoice_id || ''
    const pending = prows[0]?.pending_edit_data
    const stripe = stripeClient()
    if (invoiceId && pending && stripe) {
      try {
        const inv = await stripe.invoices.retrieve(invoiceId)
        if (inv.status === 'paid') {
          const invPi = (inv as unknown as { payment_intent?: string | { id?: string } | null }).payment_intent
          const piId = typeof invPi === 'string' ? invPi : (invPi?.id ?? null)
          // The customer has paid — apply the edit and, no matter what, clear the
          // pending state so the page opens clean (no amber banner). If the apply
          // itself fails, still clear edit_status so the order isn't stuck.
          try {
            await applyPendingEdit({ orderId: order.id, orderReference: order.reference, pending, invoiceId, paymentIntentId: piId })
          } catch (applyErr) {
            console.error('[edit-status] applyPendingEdit failed after paid invoice — clearing pending:', applyErr instanceof Error ? applyErr.message : applyErr)
            await sql`
              UPDATE disco_orders
              SET edit_status = NULL, pending_edit_data = NULL, pending_edit_delta = NULL,
                  pending_stripe_invoice_id = NULL, updated_at = NOW()
              WHERE id = ${order.id}
            `.catch(() => {})
          }
          editStatus = null
          pendingPayment = false
          order = await getDiscoOrder(ref) // re-read the now-applied state
        } else {
          pendingPayment = true // 'open' / unpaid → read-only
        }
      } catch (e) {
        console.error('[edit-status] invoice check failed:', e instanceof Error ? e.message : e)
        pendingPayment = true // can't confirm paid → treat as pending
      }
    } else {
      pendingPayment = true // no invoice id / Stripe unavailable → treat as pending
    }
  }

  let editCount = 0
  let status = ''
  let pickupDate = ''
  let pickupTime = ''
  if (order) {
    editCount = order.edit_count ?? 0
    status = order.order_status
    pickupDate = String(order.order_date).slice(0, 10)
    pickupTime = order.order_time
  } else {
    const details = await loadFmOrderDetails(ref)
    if (details) {
      const fm = parseFmOrder(details)
      status = fm.status
      pickupDate = fm.orderDateIso
      pickupTime = fm.orderTime
    }
  }

  // SUPER_ADMIN bypasses the 24-hour pickup-proximity restriction (only). An
  // admin-portal session is treated as SUPER_ADMIN for this purpose.
  // Use the already-resolved ctx for a Disco-native session (getRestaurantRole()
  // only decodes the FM JWT, so it's always null there — the same gap fixed in
  // manage/bulk-pricing/page.tsx) and fall back to the FM decode for FM sessions.
  const isSuperAdmin = isAdminEdit
    || (ctx?.authType === 'disco' ? ctx.role === 'SUPER_ADMIN' : (await getRestaurantRole()) === 'SUPER_ADMIN')

  // Absolute past-date gate — anchored to the restaurant tz, applies to ALL roles
  // (incl. SUPER_ADMIN). Distinct from the hoursUntil<24 future rule below.
  const restaurantTz = order?.restaurant_reference
    ? await loadRestaurantTimeZone(order.restaurant_reference)
    : RESTAURANT_TZ_DEFAULT
  const isPast = isOrderInPast(pickupDate, pickupTime, restaurantTz)

  const hrs = hoursUntil(pickupDate, pickupTime)
  let canEdit = true
  let reason = ''
  if (isPast) { canEdit = false; reason = "This order's date has already passed." }
  else if (pendingPayment) { canEdit = false; reason = 'Awaiting customer payment for the pending edit' }
  else if (editCount >= MAX_EDITS) { canEdit = false; reason = 'Maximum edits reached' }
  else if (!isSuperAdmin && hrs < 24) { canEdit = false; reason = 'Order cannot be edited within 24 hours of pickup' }
  else if (status && !isEditableStatus(status)) { canEdit = false; reason = `This order is ${status.toLowerCase()} and can no longer be edited` }

  return NextResponse.json({ editCount, canEdit, reason, editStatus, pendingPayment })
}
