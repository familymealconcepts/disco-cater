import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantUserRef, getRestaurantRef } from '../../../../lib/restaurant-auth'
import { buildForwardForm } from '../../../../lib/multi-link-forward'
import { upsertLocationLink, buildLinkRow, getRestaurantLocationLinks } from '../../../../lib/location-links'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { resolveDiscoGroupScope, resolveDiscoAccessScope, discoRefAllowed } from '../../../../lib/restaurant-write-scope'
import { listReachableNativeLinks, createNativeLink, slugTaken } from '../../../../lib/multi-unit-links'
import { resolveLocationUniverse, scopeAllows } from '../../../../lib/location-universe'
import { sql } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

// Read the multipart `request` JSON part (FM shape) the client sends.
async function readRequestPart(req: NextRequest): Promise<Record<string, unknown>> {
  const fd = await req.formData()
  const raw = fd.get('request')
  if (raw && typeof (raw as Blob).text === 'function') {
    try { return JSON.parse(await (raw as Blob).text()) } catch { return {} }
  }
  return {}
}

// Disco-native listing: every multi-unit link the viewer can REACH, plus the
// restaurant's own shareable location links from the Neon mirror (where
// single-restaurant /locations/{slug} links live). Merged + deduped by slug, and
// nothing ever calls FamilyMeal for a restaurant that has no FM record.
//
// SCOPED BY REACH, NOT OWNERSHIP. This used to call listNativeLinks(ctx.email),
// which lists links the viewer CREATED, and only for SYSTEM_ADMINs. A link is
// created by whoever ran the conversion — an internal account — so 22 of 25
// links fleet-wide (185 restaurant memberships) were invisible to every person
// who could actually reach their locations. See listReachableNativeLinks.
//
// resolveDiscoAccessScope rather than resolveDiscoGroupScope, deliberately: it
// reads disco_restaurant_location_access, the explicit ACL, and its own comment
// names multi-unit-links as an intended call site. resolveDiscoGroupScope
// derives its set from businessName, which would put a NAME MATCH back into a
// permission decision. The role gate is identical in both (SUPER_ADMIN
// unrestricted; SYSTEM_ADMIN its grants; anyone else its anchor).
//
// The WRITE path below still uses resolveDiscoGroupScope and is untouched —
// changing who may create a link is not part of this.
async function nativeList(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>) {
  const scope = await resolveDiscoAccessScope(ctx)
  // viewer is passed so canEdit is computed server-side — the UI must not
  // re-derive the rule and disagree with what PUT/DELETE will allow.
  const nativeLinks = await listReachableNativeLinks(scope, { email: ctx.email || null, isSuperAdmin: ctx.role === 'SUPER_ADMIN' })
  const neonLinks = ctx.restaurantReference ? await getRestaurantLocationLinks(ctx.restaurantReference) : []
  const seen = new Set(nativeLinks.map(l => l.url))
  const content = [...nativeLinks, ...neonLinks.filter(l => !seen.has(l.url))]
  return NextResponse.json({ content, totalElements: content.length })
}

// Create the link in Disco's own store.
//
// Reach is passed in rather than re-derived, because this now serves FM sessions
// too: resolveDiscoAccessScope reads ctx.role, which is null for an FM session,
// so re-deriving here would reject every member of a chain whose admin signed in
// through FamilyMeal.
//
// A native link may hold FM-BACKED members. disco_multi_unit_link_members keys on
// restaurant_reference as TEXT and the public /locations/[slug] page renders every
// member out of disco_restaurant_cache, which mirrors FM restaurants as well — so
// a half-converted chain gets one working page covering all of its locations
// instead of being forced to pick a side.
async function nativeCreate(
  ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>,
  req: NextRequest,
  allows: (ref: string) => boolean,
  isAdmin: boolean,
) {
  if (!isAdmin) return NextResponse.json({ error: 'System admin only' }, { status: 403 })
  const json = await readRequestPart(req)
  const slug = String(json.url || '').trim().toLowerCase()
  const title = String(json.header || '').trim()
  const memberRefs = Array.isArray(json.restaurantReferences) ? (json.restaurantReferences as unknown[]).map(String) : []
  if (!title) return NextResponse.json({ error: 'Title is required', description: 'Title is required' }, { status: 400 })
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: 'Invalid URL slug', description: 'URL may contain only lowercase letters, numbers, and hyphens.' }, { status: 400 })
  if (!memberRefs.length) return NextResponse.json({ error: 'Pick at least one location', description: 'Choose at least one location.' }, { status: 400 })
  // Reach, and SAY WHAT WAS REJECTED rather than silently saving a subset — the
  // same change made on the edit path.
  const members = memberRefs.filter(r => allows(r))
  const rejected = memberRefs.filter(r => !allows(r))
  if (!members.length) {
    return NextResponse.json({
      error: 'Locations not in your group',
      description: 'None of those locations are ones you have access to.',
      rejected,
    }, { status: 403 })
  }
  if (await slugTaken(slug)) return NextResponse.json({ error: 'URL already in use', description: 'That URL is already in use — pick another.' }, { status: 409 })
  const { reference } = await createNativeLink({ slug, title, ownerEmail: ctx.email, memberRefs: members })
  return NextResponse.json({
    reference, url: slug, header: title, saved: members.length, rejected,
    ...(rejected.length ? { warning: `${rejected.length} location(s) were not saved because you do not have access to them.` } : {}),
  })
}

// Mirrors FM's getLinksData(): the listing call carries page/size/sort PLUS
// `dashboardUrl` (the restaurant's own group url, fetched from /groups) and
// `userReference`. We inject userReference from the JWT here — FM reads it from
// the same token, and the client (httpOnly cookie) can't decode it.
export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  // Branch on whether there is anything NATIVE to show, not on the session type.
  // A SYSTEM_ADMIN holding an fm_restaurant_token over native restaurants used to
  // be sent to FM's listing and never saw their own links at all.
  if (ctx) {
    const scope = await resolveDiscoAccessScope(ctx)
    if (scope.unrestricted || scope.refs.size) {
      const reachable = await listReachableNativeLinks(scope, { email: ctx.email || null, isSuperAdmin: ctx.role === 'SUPER_ADMIN' })
      if (reachable.length) return nativeList(ctx)
    }
  }
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

  // BRANCH ON THE MEMBERS, NOT THE SESSION. A chain mid-conversion has native and
  // FM-backed locations at the same time (17 brands / 134 locations on
  // 2026-09-16). Forwarding such a link to FamilyMeal builds it out of FM records,
  // which no longer describe the converted members — and FM has no record at all
  // for a natively-created restaurant, so those members are simply lost.
  //
  // So: if ANY member is native, the link is created in Disco's store, which can
  // hold FM-backed members too. Only an all-FM link still goes to FamilyMeal,
  // where all of its locations genuinely live.
  if (ctx) {
    const cloned = req.clone() as NextRequest
    let memberRefs: string[] = []
    try {
      const json = await readRequestPart(cloned)
      memberRefs = Array.isArray(json.restaurantReferences) ? (json.restaurantReferences as unknown[]).map(String) : []
    } catch { /* fall through to the branches below */ }

    let anyNative = false
    if (memberRefs.length) {
      try {
        const rows = (await sql`
          SELECT 1 FROM disco_restaurant_cache
           WHERE restaurant_reference::text = ANY(${memberRefs}) AND is_disco_native = true LIMIT 1
        `) as unknown[]
        anyNative = rows.length > 0
      } catch { /* unknown → fall back to the session branch below */ }
    }

    if (ctx.authType === 'disco' || anyNative) {
      const universe = await resolveLocationUniverse()
      // Prefer the union reach (it resolves FM sessions too); fall back to
      // Disco's ACL when there is no universe to resolve.
      if (universe) {
        const isAdmin = universe.role === 'SYSTEM_ADMIN' || universe.isSuperAdmin
        return nativeCreate(ctx, req, r => scopeAllows(universe, r), isAdmin)
      }
      const allow = await resolveDiscoAccessScope(ctx)
      const isAdmin = ctx.role === 'SYSTEM_ADMIN' || ctx.role === 'SUPER_ADMIN'
      return nativeCreate(ctx, req, r => discoRefAllowed(allow, r), isAdmin)
    }
  }

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
