import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantUserRef } from '../../../../lib/restaurant-auth'
import { buildForwardForm } from '../../../../lib/multi-link-forward'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Mirrors FM's getLinksData(): the listing call carries page/size/sort PLUS
// `dashboardUrl` (the restaurant's own group url, fetched from /groups) and
// `userReference`. We inject userReference from the JWT here — FM reads it from
// the same token, and the client (httpOnly cookie) can't decode it.
export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  params.set('page', sp.get('page') || '0')
  params.set('size', sp.get('size') || '25')
  sp.getAll('sort').forEach(s => params.append('sort', s))
  const dashboardUrl = sp.get('dashboardUrl')
  if (dashboardUrl) params.set('dashboardUrl', dashboardUrl)
  const userReference = await getRestaurantUserRef()
  if (userReference) params.set('userReference', userReference)
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/links/listing?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch links' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch links' }, { status: 500 })
  }
}

// Create a link. FM sends multipart/form-data: a JSON `request` part + an
// optional `image` file part. We accept that FormData from the client, inject
// the trusted `userReference` into the JSON part, and forward it as-is. A
// legacy JSON body is still accepted (wrapped into the `request` part) so older
// callers keep working.
export async function POST(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const fd = await buildForwardForm(req)
    const res = await fetch(`${FM}/api/system-admin/restaurants/links`, {
      method: 'POST', headers: h, body: fd,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to create' }, { status: 500 }) }
}
