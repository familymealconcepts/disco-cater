import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// GET /api/admin/dashboard/sale/stats?fromDate=&toDate=&restaurantReference=
// Per docs/fm-super-admin-audit.md § D.6, FM's canonical SA endpoint is
// /sale/stats (the /statistics variant was a wrong guess earlier).
export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  if (sp.get('fromDate')) params.set('fromDate', sp.get('fromDate')!)
  if (sp.get('toDate')) params.set('toDate', sp.get('toDate')!)
  if (sp.get('restaurantReference')) params.set('restaurantReference', sp.get('restaurantReference')!)
  try {
    const res = await fetch(`${FM}/api/admin/dashboard/sale/stats?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch sale stats' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch sale stats' }, { status: 500 })
  }
}
