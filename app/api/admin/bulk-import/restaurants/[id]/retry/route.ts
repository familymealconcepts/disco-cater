import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../../lib/admin-auth'
import { MENUUPLOAD_BASE, menuuploadHeaders } from '../../../../../../../lib/menuupload'

// PATCH /api/admin/bulk-import/restaurants/{id}/retry
// Forwards to {menuupload}/scraped-restaurants/{id}/retry
export async function PATCH(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { id } = await params
  try {
    const res = await fetch(`${MENUUPLOAD_BASE}/scraped-restaurants/${id}/retry`, {
      method: 'PATCH',
      headers: menuuploadHeaders(),
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Retry failed', raw }, { status: res.status })
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to retry' }, { status: 500 })
  }
}
