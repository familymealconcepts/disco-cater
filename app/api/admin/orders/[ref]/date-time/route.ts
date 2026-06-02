import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// PUT /api/admin/orders/{ref}/date-time?restaurantReference=
// Body: { orderDate: "YYYY-MM-DD", orderTime: "HH:MM:SS" }
// Forwards to FM's super-admin date-time edit (the "Update Order Date & Time"
// popup). Mirrors the restaurant portal's reopen route, but on the admin
// userOrders namespace like the other admin order mutations.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const restaurantRef = req.nextUrl.searchParams.get('restaurantReference')
  const qs = restaurantRef ? `?restaurantReference=${restaurantRef}` : ''
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/admin/userOrders/${ref}/date-time${qs}`, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to update date/time' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to update date/time' }, { status: 500 })
  }
}
