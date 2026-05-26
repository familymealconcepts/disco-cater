import { NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// GET /api/admin/restaurants-list — flat list for filter dropdowns (FM /api/restaurants/list)
export async function GET() {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/restaurants/list`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch list' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch list' }, { status: 500 })
  }
}
