import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
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
