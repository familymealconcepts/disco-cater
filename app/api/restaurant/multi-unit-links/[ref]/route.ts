import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'
import { buildForwardForm } from '../../../../../lib/multi-link-forward'
import { upsertLocationLink, buildLinkRow } from '../../../../../lib/location-links'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { getDiscoGroupAccounts } from '../../../../../lib/disco-restaurant-auth'
import { updateNativeLink, deleteNativeLink, slugTaken, linkOwnerEmail } from '../../../../../lib/multi-unit-links'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

type Ctx = NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>

async function nativeUpdate(ctx: Ctx, ref: string, req: NextRequest) {
  if (ctx.role !== 'SYSTEM_ADMIN' && ctx.role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'System admin only' }, { status: 403 })
  // Only the SA who owns the link may edit it.
  if ((await linkOwnerEmail(ref)) !== ctx.email) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const fd = await req.formData()
  const raw = fd.get('request')
  let json: Record<string, unknown> = {}
  if (raw && typeof (raw as Blob).text === 'function') { try { json = JSON.parse(await (raw as Blob).text()) } catch { json = {} } }
  const slug = String(json.url || '').trim().toLowerCase()
  const title = String(json.header || '').trim()
  const memberRefs = Array.isArray(json.restaurantReferences) ? (json.restaurantReferences as unknown[]).map(String) : []
  if (!title) return NextResponse.json({ error: 'Title is required', description: 'Title is required' }, { status: 400 })
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: 'Invalid URL', description: 'URL may contain only lowercase letters, numbers, and hyphens.' }, { status: 400 })
  if (!memberRefs.length) return NextResponse.json({ error: 'Pick at least one location', description: 'Choose at least one location.' }, { status: 400 })
  const allow = new Set<string>([ctx.restaurantReference])
  try { for (const g of await getDiscoGroupAccounts(ctx.businessName, ctx.email)) allow.add(g.restaurant_reference) } catch { /* home only */ }
  const members = memberRefs.filter(r => allow.has(r))
  if (!members.length) return NextResponse.json({ error: 'Locations not in your group', description: 'Those locations are not in your group.' }, { status: 403 })
  if (await slugTaken(slug, ref)) return NextResponse.json({ error: 'URL already in use', description: 'That URL is already in use — pick another.' }, { status: 409 })
  const okUpd = await updateNativeLink(ref, { slug, title, memberRefs: members })
  if (!okUpd) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ reference: ref, url: slug, header: title })
}

async function nativeDelete(ctx: Ctx, ref: string) {
  if (ctx.role !== 'SYSTEM_ADMIN' && ctx.role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'System admin only' }, { status: 403 })
  if ((await linkOwnerEmail(ref)) !== ctx.email) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await deleteNativeLink(ref)
  return NextResponse.json({ ok: true })
}

// Update a link. Same multipart contract as POST (request JSON part + optional
// image part); userReference is injected from the JWT. On failure we pass FM's
// raw error body back so the client can surface `description` inline.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return nativeUpdate(ctx, ref, req)

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
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

    // Mirror the updated link into Neon for the public /locations/[slug] header
    // (slug + title). FM's response omits the image reference, so image_url is
    // set separately by the client via PATCH .../[ref]/image after this returns.
    // Best effort — the FM update already succeeded.
    try {
      const restaurantReference = await getRestaurantRef()
      await upsertLocationLink(buildLinkRow(request, fmData, restaurantReference))
    } catch (e) {
      console.error('[multi-unit-links] Neon mirror failed (update):', e instanceof Error ? e.message : e)
    }

    return NextResponse.json(text ? fmData : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update' }, { status: 500 }) }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return nativeDelete(ctx, ref)

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/links/${ref}`, { method: 'DELETE', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ error: 'Unable to delete' }, { status: 500 }) }
}
