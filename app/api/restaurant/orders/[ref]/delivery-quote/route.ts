import { NextRequest, NextResponse } from 'next/server'
import { resolveOrderAccess } from '../../../../../../lib/order/order-scope'
import { sql } from '../../../../../../lib/db'
import { getDiscoOrder } from '../../../../../../lib/order-edit'
import { validateNativeDelivery } from '../../../../../../lib/order/native-delivery'
import { loadMenuFulfillmentAvailability, loadMenuOrderMinimums } from '../../../../../../lib/order/native-checkout'
import { discountedBase } from '../../../../../../lib/promo-pricing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST — the delivery fee the edit screen shows before a pickup order is
// switched to delivery. The same checks and fee the edit itself applies (see the
// PICKUP ↔ DELIVERY block in ../edit/route.ts): the order's own menu decides
// self-delivery or courier and the fee, the address goes through checkout's
// range check, and the items must meet the menu's delivery minimum. Reads only.
//   body { address: {addressLine1, addressLine2, city, state, zip}, subtotal }
//   → { valid, fulfillment, deliveryFee, distanceMiles, message }
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const access = await resolveOrderAccess(ref)
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status as number })

  let body: { address?: { addressLine1?: string; addressLine2?: string; city?: string; state?: string; zip?: string }; subtotal?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }
  const address = {
    addressLine1: String(body.address?.addressLine1 || '').trim(),
    addressLine2: String(body.address?.addressLine2 || '').trim(),
    city: String(body.address?.city || '').trim(),
    state: String(body.address?.state || '').trim(),
    zip: String(body.address?.zip || '').trim(),
  }
  if (!address.addressLine1 || !address.city || !address.state || !address.zip) {
    return NextResponse.json({ valid: false, message: 'Enter the delivery address: street, city, state and ZIP.' })
  }

  const order = await getDiscoOrder(ref)
  if (!order || order.fm_order_reference) {
    return NextResponse.json({ valid: false, message: "This order's payment was taken by FamilyMeal, so it can't be switched to delivery here." })
  }
  const rows = (await sql`
    SELECT o.menu_reference, t.subtotal, t.discount
    FROM disco_orders o
    LEFT JOIN disco_sale_transactions t ON t.order_id = o.id AND t.transaction_type = 'ORIGINAL'
    WHERE o.id = ${order.id} LIMIT 1
  `.catch(() => [])) as { menu_reference: string | null; subtotal: string | number | null; discount: string | number | null }[]
  const menuReference = rows[0]?.menu_reference || undefined
  const origSubtotal = Number(rows[0]?.subtotal) || 0
  const discountPct = origSubtotal > 0 ? ((Number(rows[0]?.discount) || 0) / origSubtotal) * 100 : 0
  const subtotal = Math.max(0, Number(body.subtotal) || 0)

  const avail = await loadMenuFulfillmentAvailability(order.restaurant_reference, menuReference)
  if (!avail.offersDelivery) return NextResponse.json({ valid: false, message: "This order's menu is pickup only." })
  const mins = await loadMenuOrderMinimums(order.restaurant_reference, menuReference)
  if (mins.delivery > 0 && subtotal < mins.delivery) {
    return NextResponse.json({ valid: false, message: `This menu's delivery minimum is $${mins.delivery.toFixed(2)}; the items come to $${subtotal.toFixed(2)}.` })
  }
  const q = await validateNativeDelivery(order.restaurant_reference, address, discountedBase(subtotal, discountPct), undefined, menuReference)
  return NextResponse.json({
    valid: q.valid, fulfillment: q.fulfillment, deliveryFee: q.deliveryFee,
    distanceMiles: q.distanceMiles, message: q.message,
  })
}
