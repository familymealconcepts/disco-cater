import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { findNativeOrder, applyNativeStatusChange, normalizeOrderStatus, voidInvoiceBeforeCancel, ALLOWED_ORDER_STATUSES } from '../../../../../../lib/order/native-status-change'
import { setFamilyMealOrderStatus } from '../../../../../../lib/order/fm-order-status'
import { sql } from '../../../../../../lib/db'

async function hasDiscoCopy(ref: string): Promise<boolean> {
  const rows = (await sql`SELECT 1 FROM disco_orders WHERE (reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid) AND is_deleted = false LIMIT 1`) as unknown[]
  return rows.length > 0
}


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
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return NextResponse.json({ error: 'Invalid order reference' }, { status: 400 })
  const status = req.nextUrl.searchParams.get('status')
  const restaurantRef = req.nextUrl.searchParams.get('restaurantReference')

  if (status && await findNativeOrder(ref)) {
    const r = await applyNativeStatusChange(ref, normalizeOrderStatus(status), 'ADMIN_STATUS')
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, orderStatus: r.orderStatus, neon: r.neon })
  }

  if (!status || !restaurantRef) return NextResponse.json({ error: 'status and restaurantReference required' }, { status: 400 })
  // A FamilyMeal order: FamilyMeal FIRST, then Disco's copy, the same as the restaurant portal
  // (lib/order/fm-order-status.ts). This called /api/admin/userOrders/{ref}/updateStatus?status=, which
  // FamilyMeal does not have, so every Super Admin status change on a FamilyMeal order failed, and Disco's
  // copy was never written even when it should have been.
  const next = normalizeOrderStatus(status)
  if (!ALLOWED_ORDER_STATUSES.has(next)) return NextResponse.json({ error: 'Unsupported status' }, { status: 400 })
  const v = await voidInvoiceBeforeCancel(ref, next)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status })
  const fm = await setFamilyMealOrderStatus(ref, next, restaurantRef)
  if (!fm.ok) return NextResponse.json({ error: fm.error }, { status: fm.status })
  // Disco's copy, when it has one. A FamilyMeal order not mirrored yet arrives with the next sync.
  if (!(await hasDiscoCopy(ref))) return NextResponse.json({ ok: true, orderStatus: next, neon: false })
  const r = await applyNativeStatusChange(ref, next, 'ADMIN_STATUS', { invoiceAlreadyVoided: true })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true, orderStatus: r.orderStatus, neon: r.neon })
}
