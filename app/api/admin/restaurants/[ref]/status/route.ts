import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// POST /api/admin/restaurants/{ref}/status?status={ACTIVE|INACTIVE|SUSPENDED|ARCHIVED}
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const status = req.nextUrl.searchParams.get('status')
  if (!status) return NextResponse.json({ error: 'status required' }, { status: 400 })
  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}?status=${status}`, { method: 'POST', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to change status' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to change status' }, { status: 500 })
  }
}
