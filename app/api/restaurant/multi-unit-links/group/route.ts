import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { buildForwardForm } from '../../../../../lib/multi-link-forward'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Proxy for FM's dashboard-group endpoint (/api/system-admin/groups). Lives
// under multi-unit-links/ rather than a top-level groups/ route because that
// path is already taken by the unrelated extraItemsGroups (modifier groups)
// proxy. FM uses this to (a) learn the restaurant's own dashboard group url for
// the `dashboardUrl` listing param + Dashboard-row pinning, and (b) edit the
// auto-managed Dashboard row.

// GET -> { name, url, ... }
export async function GET() {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/system-admin/groups`, { headers: h })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to fetch group', raw }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch group' }, { status: 500 })
  }
}

// PUT /api/system-admin/groups?url={url} — FM's dedicated endpoint for editing
// the auto-managed Dashboard row (urlFrom === 'Dashboard'), used INSTEAD of the
// links PUT. Same multipart contract (request JSON part + optional image part).
export async function PUT(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const url = req.nextUrl.searchParams.get('url') || ''
  try {
    const fd = await buildForwardForm(req)
    const res = await fetch(`${FM}/api/system-admin/groups?url=${encodeURIComponent(url)}`, {
      method: 'PUT', headers: h, body: fd,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update group' }, { status: 500 }) }
}
