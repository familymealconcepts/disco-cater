import { NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// GET /api/admin/dashboard/statistics — count metrics, no filters
export async function GET() {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/admin/dashboard/statistics`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch stats' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch stats' }, { status: 500 })
  }
}
