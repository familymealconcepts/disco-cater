import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// PUT /api/admin/orders/{ref}/status?status=&restaurantReference=
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const status = req.nextUrl.searchParams.get('status')
  const restaurantRef = req.nextUrl.searchParams.get('restaurantReference')
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
