import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const EMPTY = { unseenByAdmin: 0, newOrdersCount: 0 }

// New/unread orders count for the sidebar badge, scoped to one location:
//   - explicit ?restaurantReference wins (a specific location)
//   - getRestaurantRef() then gives the SA's SELECTED location (cookie) or the
//     ADMIN's own restaurant from the JWT — so ADMIN and SA-viewing-a-location
//     both get their own location's unread count.
// (A SYSTEM_ADMIN on the all-locations view resolves to their home restaurant
//  ref here; a true cross-location aggregate would need an FM endpoint that
//  doesn't exist yet.) Always exposes `newOrdersCount` for the sidebar.
export async function GET(req: NextRequest) {
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json(EMPTY)
  }
  const queryRef = req.nextUrl.searchParams.get('restaurantReference') || ''
  const ref = queryRef || (await getRestaurantRef()) || ''
  if (!ref) return NextResponse.json(EMPTY)
  try {
    const res = await fetch(`${FM}/api/orders/${ref}/statistics`, { headers: authHeaders })
    if (!res.ok) return NextResponse.json(EMPTY)
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    // FM has used a few names for this over time — accept whichever is present.
    const newOrdersCount = Number(
      data.unseenByAdmin ?? data.numberOfUnseenOrders ?? data.newOrders ?? data.unseenCount ?? 0,
    ) || 0
    return NextResponse.json({ ...data, unseenByAdmin: data.unseenByAdmin ?? newOrdersCount, newOrdersCount })
  } catch {
    return NextResponse.json(EMPTY)
  }
}
