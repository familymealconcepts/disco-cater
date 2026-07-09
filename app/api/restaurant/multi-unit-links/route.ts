import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantUserRef, getRestaurantRef } from '../../../../lib/restaurant-auth'
import { buildForwardForm } from '../../../../lib/multi-link-forward'
import { upsertLocationLink, buildLinkRow, getRestaurantLocationLinks } from '../../../../lib/location-links'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { getDiscoGroupAccounts } from '../../../../lib/disco-restaurant-auth'
import { listNativeLinks, createNativeLink, slugTaken } from '../../../../lib/multi-unit-links'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

// The location refs a disco SA may put in a link = their group (+ home).
async function allowedRefs(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>): Promise<Set<string>> {
  const set = new Set<string>()
  if (ctx.restaurantReference) set.add(ctx.restaurantReference)
  try { for (const g of await getDiscoGroupAccounts(ctx.businessName, ctx.email)) set.add(g.restaurant_reference) } catch { /* home only */ }
  return set
}

// Read the multipart `request` JSON part (FM shape) the client sends.
async function readRequestPart(req: NextRequest): Promise<Record<string, unknown>> {
  const fd = await req.formData()
  const raw = fd.get('request')
  if (raw && typeof (raw as Blob).text === 'function') {
    try { return JSON.parse(await (raw as Blob).text()) } catch { return {} }
  }
  return {}
}

// Disco-native listing: the SA's own multi-unit links (SYSTEM_ADMIN) PLUS the
// restaurant's own shareable location links from the Neon mirror (where
// single-restaurant /locations/{slug} links live). Merged + deduped by slug so a
// Disco-native ADMIN sees its links instead of an empty page — and nothing ever
// calls FamilyMeal for a restaurant that has no FM record.
async function nativeList(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>) {
  const nativeLinks = (ctx.role === 'SYSTEM_ADMIN' || ctx.role === 'SUPER_ADMIN') ? await listNativeLinks(ctx.email) : []
  const neonLinks = ctx.restaurantReference ? await getRestaurantLocationLinks(ctx.restaurantReference) : []
  const seen = new Set(nativeLinks.map(l => l.url))
  const content = [...nativeLinks, ...neonLinks.filter(l => !seen.has(l.url))]
  return NextResponse.json({ content, totalElements: content.length })
}

async function nativeCreate(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>, req: NextRequest) {
  if (ctx.role !== 'SYSTEM_ADMIN' && ctx.role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'System admin only' }, { status: 403 })
  const json = await readRequestPart(req)
  const slug = String(json.url || '').trim().toLowerCase()
  const title = String(json.header || '').trim()
  const memberRefs = Array.isArray(json.restaurantReferences) ? (json.restaurantReferences as unknown[]).map(String) : []
  if (!title) return NextResponse.json({ error: 'Title is required', description: 'Title is required' }, { status: 400 })
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: 'Invalid URL slug', description: 'URL may contain only lowercase letters, numbers, and hyphens.' }, { status: 400 })
  if (!memberRefs.length) return NextResponse.json({ error: 'Pick at least one location', description: 'Choose at least one location.' }, { status: 400 })
  const allow = await allowedRefs(ctx)
  const members = memberRefs.filter(r => allow.has(r))
  if (!members.length) return NextResponse.json({ error: 'Locations not in your group', description: 'Those locations are not in your group.' }, { status: 403 })
  if (await slugTaken(slug)) return NextResponse.json({ error: 'URL already in use', description: 'That URL is already in use — pick another.' }, { status: 409 })
  const { reference } = await createNativeLink({ slug, title, ownerEmail: ctx.email, memberRefs: members })
  return NextResponse.json({ reference, url: slug, header: title })
}

// Mirrors FM's getLinksData(): the listing call carries page/size/sort PLUS
// `dashboardUrl` (the restaurant's own group url, fetched from /groups) and
// `userReference`. We inject userReference from the JWT here — FM reads it from
// the same token, and the client (httpOnly cookie) can't decode it.
export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return nativeList(ctx)

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
    if (!res.ok) {
      // FM has no links for this restaurant (e.g. a Disco-native restaurant with no
      // FM record → FM 404s). Fall back to the Neon mirror by reference so the
      // restaurant's own links still load instead of showing "Failed to fetch links".
      const ref = await getRestaurantRef().catch(() => '')
      const content = ref ? await getRestaurantLocationLinks(ref) : []
      if (content.length) return NextResponse.json({ content, totalElements: content.length })
      return NextResponse.json({ error: 'Failed to fetch links' }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch {
    // FM unreachable — still try the Neon mirror before failing.
    const ref = await getRestaurantRef().catch(() => '')
    const content = ref ? await getRestaurantLocationLinks(ref) : []
    if (content.length) return NextResponse.json({ content, totalElements: content.length })
    return NextResponse.json({ error: 'Unable to fetch links' }, { status: 500 })
  }
}

// Create a link. FM sends multipart/form-data: a JSON `request` part + an
// optional `image` file part. We accept that FormData from the client, inject
// the trusted `userReference` into the JSON part, and forward it as-is. A
// legacy JSON body is still accepted (wrapped into the `request` part) so older
// callers keep working.
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return nativeCreate(ctx, req)

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
