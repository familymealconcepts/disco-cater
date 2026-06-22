import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { getRestaurantRole } from '../../../../../../lib/restaurant-auth'
import { runDiscoOrderMigrations } from '../../../../../../lib/db'
import {
  getDiscoOrder, loadFmOrderDetails, parseFmOrder, hoursUntil, isEditableStatus, MAX_EDITS,
} from '../../../../../../lib/order-edit'

// GET — edit eligibility for an order, read from Disco's Neon state (with an FM
// fallback for pickup/status when the order isn't mirrored in disco_orders yet).
//   → { editCount, canEdit, reason }
export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try { await runDiscoOrderMigrations() } catch { /* best-effort */ }

  let editCount = 0
  let status = ''
  let pickupDate = ''
  let pickupTime = ''

  const order = await getDiscoOrder(ref)
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

  // SUPER_ADMIN bypasses the 24-hour pickup-proximity restriction (only).
  const isSuperAdmin = (await getRestaurantRole()) === 'SUPER_ADMIN'

  const hrs = hoursUntil(pickupDate, pickupTime)
  let canEdit = true
  let reason = ''
  if (editCount >= MAX_EDITS) { canEdit = false; reason = 'Maximum edits reached' }
  else if (!isSuperAdmin && hrs < 24) { canEdit = false; reason = 'Order cannot be edited within 24 hours of pickup' }
  else if (status && !isEditableStatus(status)) { canEdit = false; reason = `This order is ${status.toLowerCase()} and can no longer be edited` }

  return NextResponse.json({ editCount, canEdit, reason })
}
