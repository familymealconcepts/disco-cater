import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantUserRef, getRestaurantRef } from '../../../../lib/restaurant-auth'
import { buildForwardForm } from '../../../../lib/multi-link-forward'
import { upsertLocationLink, buildLinkRow } from '../../../../lib/location-links'

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
    const { form, request } = await buildForwardForm(req)
    const res = await fetch(`${FM}/api/system-admin/restaurants/links`, {
      method: 'POST', headers: h, body: form,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed', raw }, { status: res.status })
    }
    const text = await res.text()
    let fmData: Record<string, unknown> = {}
    if (text) { try { fmData = JSON.parse(text) } catch { fmData = {} } }

    // Mirror the link into Neon for the public /locations/[slug] header. Best
    // effort — the FM write already succeeded, so a Neon failure must not fail
    // the save (the create-table migration also lives here, idempotent).
    try {
      const restaurantReference = await getRestaurantRef()
      await upsertLocationLink(buildLinkRow(request, fmData, restaurantReference))
    } catch (e) {
      console.error('[multi-unit-links] Neon mirror failed (create):', e instanceof Error ? e.message : e)
    }

    return NextResponse.json(text ? fmData : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to create' }, { status: 500 }) }
}
