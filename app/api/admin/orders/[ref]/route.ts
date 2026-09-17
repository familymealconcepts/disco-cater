import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { loadNativeAdminOrder } from '../../../../../lib/admin/native-order'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// GET /api/admin/orders/{ref}
//
// The super-admin Orders list merges Disco-native orders in (see
// app/api/admin/orders/route.ts), but this detail route only ever asked
// FamilyMeal — and FM has no record of a native order at all, so every one of
// them 404'd here as "Failed to fetch order". A list that shows a row whose
// detail cannot be served is the same gap in two halves.
//
// Native orders are now served from Neon in the SAME shape the list route emits
// for them (FM's UserOrderResponseDto field names), plus the order's items, so
// list row and detail agree field for field.
export async function GET(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params

  const native = await loadNativeAdminOrder(ref)
  if (native) return NextResponse.json(native)

  const restaurantRef = req.nextUrl.searchParams.get('restaurantReference')
  const qs = restaurantRef ? `?restaurantReference=${restaurantRef}` : ''
  try {
    const res = await fetch(`${FM}/api/admin/userOrders/${ref}${qs}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch order' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch order' }, { status: 500 })
  }
}
