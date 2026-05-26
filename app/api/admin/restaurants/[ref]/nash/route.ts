import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// PATCH /api/admin/restaurants/{ref}/nash?nashAllowed={bool}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const nash = req.nextUrl.searchParams.get('nashAllowed') || 'false'
  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}/nashAllowed?nashAllowed=${nash}`, { method: 'PATCH', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to toggle nash' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to toggle nash' }, { status: 500 })
  }
}
