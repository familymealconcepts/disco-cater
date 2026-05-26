import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { MENUUPLOAD_BASE, menuuploadHeaders } from '../../../../../lib/menuupload'

// GET /api/admin/bulk-import/locations — list of bulk-import jobs.
// Forwards to {menuupload}/scraped-locations with x-api-key.
// Admin auth gates access (only SUPER_ADMIN should hit this).
export async function GET(req: NextRequest) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  const page = sp.get('page')
  if (page && page !== '0') params.set('page', page)
  params.set('size', sp.get('size') || '25')
  try {
    const res = await fetch(`${MENUUPLOAD_BASE}/scraped-locations?${params}`, {
      headers: menuuploadHeaders(),
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to fetch locations', raw }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to reach menuupload service' }, { status: 500 })
  }
}

// POST — address-based bulk-import creation (FM /bulk)
export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const res = await fetch(`${MENUUPLOAD_BASE}/bulk`, {
      method: 'POST',
      headers: { ...menuuploadHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to create bulk import', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to create bulk import' }, { status: 500 })
  }
}
