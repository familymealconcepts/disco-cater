import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../../lib/admin-auth'
import { MENUUPLOAD_BASE, menuuploadHeaders, maybeDecodeId } from '../../../../../../../lib/menuupload'

// GET /api/admin/bulk-import/locations/{id}/restaurants
// Forwards to {menuupload}/scraped-locations/{id}/scraped-restaurants
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { id } = await params
  const locationId = maybeDecodeId(decodeURIComponent(id))
  const sp = req.nextUrl.searchParams
  const params2 = new URLSearchParams()
  const page = sp.get('page')
  if (page && page !== '0') params2.set('page', page)
  params2.set('size', sp.get('size') || '25')
  if (sp.get('search')) params2.set('search', sp.get('search')!)
  if (sp.get('status')) params2.set('status', sp.get('status')!)
  try {
    const res = await fetch(`${MENUUPLOAD_BASE}/scraped-locations/${locationId}/scraped-restaurants?${params2}`, {
      headers: menuuploadHeaders(),
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to fetch restaurants', raw }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch restaurants' }, { status: 500 })
  }
}
