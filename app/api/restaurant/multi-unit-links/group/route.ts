import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'
import { buildForwardForm } from '../../../../../lib/multi-link-forward'
import { upsertLocationLink, buildLinkRow, fetchFullLink } from '../../../../../lib/location-links'

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
    const { form: fd, request } = await buildForwardForm(req)
    const res = await fetch(`${FM}/api/system-admin/groups?url=${encodeURIComponent(url)}`, {
      method: 'PUT', headers: h, body: fd,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed', raw }, { status: res.status })
    }
    const text = await res.text()
    let fmData: Record<string, unknown> = {}
    if (text) { try { fmData = JSON.parse(text) } catch { fmData = {} } }

    // Mirror the Dashboard link into Neon for the public /locations/[slug] header
    // (same as the regular link PUT). Slug is the ?url query param. Best effort —
    // the FM update already succeeded, so a Neon failure must not fail the save.
    // FM's PUT response is thin (no image ref), so re-fetch the full link object
    // from the listing to recover the uploaded image; fall back to fmData if not.
    try {
      const restaurantReference = await getRestaurantRef()
      // The links listing is scoped to the logged-in restaurant user, so this
      // must use their own token (h = getRestaurantAuthHeader), not a service JWT.
      const full = await fetchFullLink(h, url)
      const row = buildLinkRow(request, full || fmData, restaurantReference)
      if (url) row.slug = url // the group's slug is the query param, not the body
      await upsertLocationLink(row)
    } catch (e) {
      console.error('[multi-unit-links group] Neon mirror failed:', e instanceof Error ? e.message : e)
    }

    return NextResponse.json(text ? fmData : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update group' }, { status: 500 }) }
}
