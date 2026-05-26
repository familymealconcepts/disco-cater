import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// POST /api/admin/restaurants/{ref}/block?block={bool}
// Forwards to FM POST /api/admin/restaurants/manage/block/{ref}?block={bool}
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const block = req.nextUrl.searchParams.get('block') || 'true'
  try {
    const res = await fetch(`${FM}/api/admin/restaurants/manage/block/${ref}?block=${block}`, { method: 'POST', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to toggle block' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to toggle block' }, { status: 500 })
  }
}
