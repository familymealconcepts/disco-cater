import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'
import { buildForwardForm } from '../../../../../lib/multi-link-forward'
import { upsertLocationLink, buildLinkRow, fetchFullLink } from '../../../../../lib/location-links'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Update a link. Same multipart contract as POST (request JSON part + optional
// image part); userReference is injected from the JWT. On failure we pass FM's
// raw error body back so the client can surface `description` inline.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  try {
    const { form, request } = await buildForwardForm(req)
    const res = await fetch(`${FM}/api/system-admin/restaurants/links/${ref}`, {
      method: 'PUT', headers: h, body: form,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed', raw }, { status: res.status })
    }
    const text = await res.text()
    let fmData: Record<string, unknown> = {}
    if (text) { try { fmData = JSON.parse(text) } catch { fmData = {} } }

    // TEMP: inspect FM's PUT response shape (does it echo the image reference?).
    console.log('[multi-unit-links PUT] FM response:', JSON.stringify(fmData).slice(0, 800))

    // Mirror the updated link into Neon for the public /locations/[slug] header.
    // Best effort — the FM update already succeeded. FM's PUT response is thin
    // (no image ref), so re-fetch the full link object from the listing to
    // recover the uploaded image; fall back to fmData if not found.
    try {
      const restaurantReference = await getRestaurantRef()
      const slug = String((fmData as { url?: unknown })?.url || (request as { url?: unknown })?.url || '').trim()
      const full = await fetchFullLink(h, slug)
      await upsertLocationLink(buildLinkRow(request, full || fmData, restaurantReference))
    } catch (e) {
      console.error('[multi-unit-links] Neon mirror failed (update):', e instanceof Error ? e.message : e)
    }

    return NextResponse.json(text ? fmData : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update' }, { status: 500 }) }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/links/${ref}`, { method: 'DELETE', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ error: 'Unable to delete' }, { status: 500 }) }
}
