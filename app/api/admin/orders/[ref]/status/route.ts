import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { findNativeOrder, applyNativeStatusChange, normalizeOrderStatus } from '../../../../../../lib/order/native-status-change'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// PUT /api/admin/orders/{ref}/status?status=&restaurantReference=
//
// A Disco-native order has no FamilyMeal record, so forwarding its status change
// to FM changed nothing and reported a failure. Native orders now go through the
// SAME code the restaurant portal uses — lib/order/native-status-change.ts —
// which voids an open invoice before a cancel, writes Neon, records the event
// and emails the customer. Reimplementing any of that here would have been a
// second door to the same money bug.
//
// restaurantReference is required by FM's endpoint and kept required for FM
// orders; it is not needed for a native one, whose restaurant is on the row.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const status = req.nextUrl.searchParams.get('status')
  const restaurantRef = req.nextUrl.searchParams.get('restaurantReference')

  if (status && await findNativeOrder(ref)) {
    const r = await applyNativeStatusChange(ref, normalizeOrderStatus(status), 'ADMIN_STATUS')
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, orderStatus: r.orderStatus, neon: r.neon })
  }

  if (!status || !restaurantRef) return NextResponse.json({ error: 'status and restaurantReference required' }, { status: 400 })
  try {
    const res = await fetch(`${FM}/api/admin/userOrders/${ref}/updateStatus?status=${status}&restaurantReference=${restaurantRef}`, {
      method: 'PUT', headers: h,
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to update status' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to update status' }, { status: 500 })
  }
}
