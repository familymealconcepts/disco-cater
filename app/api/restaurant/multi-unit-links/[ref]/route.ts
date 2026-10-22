import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef, getRestaurantRole, getFmSessionPermittedRefs } from '../../../../../lib/restaurant-auth'
import { buildForwardForm } from '../../../../../lib/multi-link-forward'
import { upsertLocationLink, buildLinkRow } from '../../../../../lib/location-links'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { checkLinkUrl, recordLinkUrl, retireLinkUrl, urlRecorded } from '../../../../../lib/link-url-registry'
import { sql } from '../../../../../lib/db'
import { resolveDiscoAccessScope, discoRefAllowed } from '../../../../../lib/restaurant-write-scope'
import { updateNativeLink, deleteNativeLink, nativeLinkExists, resolveLinkEditScope, linkCreator, linkEditDecision } from '../../../../../lib/multi-unit-links'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

type Ctx = NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>

async function nativeUpdate(ctx: Ctx, ref: string, req: NextRequest) {
  if (ctx.role !== 'SYSTEM_ADMIN' && ctx.role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'System admin only' }, { status: 403 })
  // ── SHARED VIEW, CREATOR EDIT ──────────────────────────────────────────────
  // Anyone who can reach a member SEES the link (the GET listing, unchanged).
  // Only the person who created it may change it. Reach is not enough: a link is
  // one shared public page, and two system admins curating the same page against
  // each other — each able to remove the other's locations — is worse than one
  // owner and a conversation.
  //
  // 403 and NOT 404, deliberately: the viewer can already see this link in their
  // Links tab, so pretending it does not exist would be a lie they can disprove
  // by looking. It names the creator instead, which is the actual next step.
  //
  // SUPER_ADMIN BYPASSES THIS. Support has to be able to fix any link, and a
  // support case must never be blocked because a restaurant's system admin
  // happened to create it.
  const creator = await linkCreator(ref)
  const isSuperAdmin = ctx.role === 'SUPER_ADMIN'
  const scope = await resolveDiscoAccessScope(ctx)
  const editScope = await resolveLinkEditScope(ref, scope)
  const decision = linkEditDecision({
    isSuperAdmin, viewerEmail: ctx.email || null, ownerEmail: creator?.email ?? null,
    createdByConversion: creator?.createdByConversion === true,
    reachesAMember: editScope.allowed,
  })
  if (!decision.allowed) {
    return NextResponse.json({
      error: decision.rule === 'conversion-reach' ? 'Not your locations' : 'Only the creator can edit this link',
      description: decision.rule === 'conversion-reach'
        ? 'You can only edit a link that includes at least one location you have access to.'
        : creator?.name
          ? `This link was created by ${creator.name}. Ask them to make the change, or create your own link.`
          : 'This link was created by someone else. Ask them to make the change, or create your own link.',
      createdBy: creator?.name ?? null,
    }, { status: 403 })
  }

  // Reach still BOUNDS what anyone may do, on either rule: they cannot add a
  // location outside their reach, and members outside it are preserved rather
  // than dropped.
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
  // ── ONLY LOCATIONS ON YOUR OWN LIST (Peter, 22 Oct 2026) ─────────────────
  // A location already on the page that the editor does not hold stays exactly
  // where it is (editScope.retained — they were never theirs to remove, and
  // existing pages are not changed). Anything ELSE named must be on the
  // editor's own Disco list, or the save is REFUSED and says which ones.
  const retainedSet = new Set(editScope.retained)
  const rejected = memberRefs.filter(r => !discoRefAllowed(scope, r) && !retainedSet.has(r))
  if (rejected.length) {
    return NextResponse.json({
      error: 'Locations not on your list',
      description: `You can only add locations on your own list. ${rejected.length} location(s) are not.`,
      rejected,
    }, { status: 403 })
  }
  const accepted = memberRefs.filter(r => discoRefAllowed(scope, r))
  const members = [...new Set([...accepted, ...editScope.retained])]
  if (!members.length) return NextResponse.json({ error: 'Pick at least one location', description: 'Choose at least one location.' }, { status: 400 })
  // ── A CHANGED URL MUST BE NEW (lib/link-url-registry.ts) ─────────────────
  const current = (await sql`SELECT slug FROM disco_multi_unit_links WHERE reference = ${ref}::uuid LIMIT 1`) as Array<{ slug: string }>
  const oldSlug = (current[0]?.slug || '').toLowerCase()
  if (slug !== oldSlug) {
    const url = await checkLinkUrl(slug, ref)
    if (!url.ok) {
      return NextResponse.json({
        error: 'URL not available',
        description: url.suggestion ? `${url.reason} Try “${url.suggestion}”.` : url.reason,
        suggestion: url.suggestion,
      }, { status: 409 })
    }
  }
  const okUpd = await updateNativeLink(ref, { slug, title, memberRefs: members })
  if (!okUpd) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (slug !== oldSlug) {
    await recordLinkUrl(slug, ref, 'rename')
    if (oldSlug) await retireLinkUrl(oldSlug)
  }
  return NextResponse.json({
    reference: ref, url: slug, header: title,
    saved: members.length,
    rejected: [],
    retained: editScope.retained,
  })
}

async function nativeDelete(ctx: Ctx, ref: string) {
  if (ctx.role !== 'SYSTEM_ADMIN' && ctx.role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'System admin only' }, { status: 403 })
  // Creator only, SUPER_ADMIN excepted — same rule as edit. See nativeUpdate.
  const creator = await linkCreator(ref)
  const isSuperAdmin = ctx.role === 'SUPER_ADMIN'
  const scope = await resolveDiscoAccessScope(ctx)
  const editScope = await resolveLinkEditScope(ref, scope)
  const decision = linkEditDecision({
    isSuperAdmin, viewerEmail: ctx.email || null, ownerEmail: creator?.email ?? null,
    createdByConversion: creator?.createdByConversion === true,
    reachesAMember: editScope.allowed,
  })
  if (!decision.allowed) {
    return NextResponse.json({
      error: decision.rule === 'conversion-reach' ? 'Not your locations' : 'Only the creator can delete this link',
      description: creator?.name && decision.rule === 'creator'
        ? `This link was created by ${creator.name}. Ask them to delete it.`
        : 'You can only delete a link that includes locations you have access to.',
      createdBy: creator?.name ?? null,
    }, { status: 403 })
  }
  // Deleting removes the page for EVERY member, so nobody short of a SUPER_ADMIN
  // may delete one that still carries locations they cannot reach.
  if (editScope.retained.length) {
    return NextResponse.json({
      error: 'Not allowed',
      description: `This link includes ${editScope.retained.length} location(s) you do not have access to, so it cannot be deleted. Remove your locations from it instead.`,
    }, { status: 403 })
  }
  // The URL stays taken forever (lib/link-url-registry.ts): record it retired.
  const gone = (await sql`SELECT slug FROM disco_multi_unit_links WHERE reference = ${ref}::uuid LIMIT 1`) as Array<{ slug: string }>
  if (gone[0]?.slug) { await recordLinkUrl(gone[0].slug, ref, 'delete'); await retireLinkUrl(gone[0].slug) }
  await deleteNativeLink(ref)
  return NextResponse.json({ ok: true })
}

// Update a link. Same multipart contract as POST (request JSON part + optional
// image part); userReference is injected from the JWT. On failure we pass FM's
// raw error body back so the client can surface `description` inline.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const ctx = await getRestaurantAuthContext()
  // BRANCH ON WHAT THE LINK IS, NOT ON HOW THE CALLER LOGGED IN. This used to test
  // `ctx?.authType === 'disco'`, so a SYSTEM_ADMIN holding an fm_restaurant_token
  // edited FM's link instead of the native one — the same defect shape as the
  // clone route and the password reset. A native link is edited natively whatever
  // session the caller happens to hold.
  if (ctx && await nativeLinkExists(ref)) return nativeUpdate(ctx, ref, req)

  // ── FAMILYMEAL-BACKED LINK: THE SAME RULES BEFORE ANYTHING IS FORWARDED ────
  // Every location must be on the editor's own Disco list (a Super Admin is
  // unrestricted), and a URL Disco has never recorded must pass the URL check.
  if (ctx) {
    try {
      const fd = await (req.clone() as NextRequest).formData()
      const raw = fd.get('request')
      const json = raw && typeof (raw as Blob).text === 'function' ? JSON.parse(await (raw as Blob).text()) : {}
      const refs = Array.isArray(json.restaurantReferences) ? (json.restaurantReferences as unknown[]).map(String) : []
      const role = ctx.authType === 'disco' ? (ctx.role || '') : ((await getRestaurantRole()) || '')
      if (role !== 'SUPER_ADMIN') {
        const list = ctx.authType === 'disco'
          ? (await resolveDiscoAccessScope(ctx)).refs
          : (ctx.fmToken ? await getFmSessionPermittedRefs(ctx.fmToken) : new Set<string>())
        const rejected = refs.filter(r => !list.has(r))
        if (rejected.length) {
          return NextResponse.json({
            error: 'Locations not on your list',
            description: `You can only include locations on your own list. ${rejected.length} location(s) are not.`,
            rejected,
          }, { status: 403 })
        }
      }
      const slug = String(json.url || '').trim().toLowerCase()
      if (slug && !(await urlRecorded(slug))) {
        const url = await checkLinkUrl(slug)
        if (!url.ok) {
          return NextResponse.json({
            error: 'URL not available',
            description: url.suggestion ? `${url.reason} Try “${url.suggestion}”.` : url.reason,
            suggestion: url.suggestion,
          }, { status: 409 })
        }
        await recordLinkUrl(slug, null, 'fm-link')
      }
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
  }

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
  // Same rule as PUT: what the link IS decides, not the session type.
  if (ctx && await nativeLinkExists(ref)) return nativeDelete(ctx, ref)

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
