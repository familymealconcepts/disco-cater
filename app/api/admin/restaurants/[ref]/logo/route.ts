import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Restaurant logo upload (1:1). FM image.service.ts:56-57 —
//   POST /api/restaurants/{reference}/logo  (multipart FormData)
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    const fd = await req.formData()
    const res = await fetch(`${FM}/api/restaurants/${ref}/logo`, { method: 'POST', headers: h, body: fd })
    if (!res.ok) { const raw = await res.text().catch(() => ''); return NextResponse.json({ error: 'Failed to upload logo', raw }, { status: res.status }) }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to upload logo' }, { status: 500 }) }
}
