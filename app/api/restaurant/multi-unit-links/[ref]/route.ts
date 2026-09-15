import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'
import { buildForwardForm } from '../../../../../lib/multi-link-forward'
import { upsertLocationLink, buildLinkRow } from '../../../../../lib/location-links'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { resolveDiscoAccessScope, discoRefAllowed } from '../../../../../lib/restaurant-write-scope'
import { updateNativeLink, deleteNativeLink, slugTaken, nativeLinkExists, resolveLinkEditScope, linkCreator } from '../../../../../lib/multi-unit-links'

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
  if (!isSuperAdmin && (!creator?.email || creator.email !== ctx.email)) {
    return NextResponse.json({
      error: 'Only the creator can edit this link',
      description: creator?.name
        ? `This link was created by ${creator.name}. Ask them to make the change, or create your own link.`
        : 'This link was created by someone else. Ask them to make the change, or create your own link.',
      createdBy: creator?.name ?? null,
    }, { status: 403 })
  }

  // Reach still bounds WHAT a creator may do, even though it no longer decides
  // WHO may act: they cannot add a location outside their reach, and members
  // outside it are preserved rather than dropped. A creator whose reach later
  // narrowed must not be able to strip locations they no longer run.
  const scope = await resolveDiscoAccessScope(ctx)
  const editScope = await resolveLinkEditScope(ref, scope)
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
  // TELL THE ADMIN WHAT WAS REJECTED. This used to silently filter out-of-reach
  // locations and report success, so submitting nine with three outside your reach
  // saved six and said "saved" — a quiet partial write with no way to tell it from
  // a complete one.
  const accepted = memberRefs.filter(r => discoRefAllowed(scope, r))
  const rejected = memberRefs.filter(r => !discoRefAllowed(scope, r))
  if (!accepted.length) {
    return NextResponse.json({
      error: 'Locations not in your group',
      description: 'None of those locations are ones you have access to.',
      rejected,
    }, { status: 403 })
  }
  // Members outside this viewer's reach are RETAINED — they were never theirs to
  // remove. See resolveLinkEditScope.
  const members = [...new Set([...accepted, ...editScope.retained])]
  if (await slugTaken(slug, ref)) return NextResponse.json({ error: 'URL already in use', description: 'That URL is already in use — pick another.' }, { status: 409 })
  const okUpd = await updateNativeLink(ref, { slug, title, memberRefs: members })
  if (!okUpd) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({
    reference: ref, url: slug, header: title,
    saved: members.length,
    rejected,
    retained: editScope.retained,
    ...(rejected.length ? {
      warning: `${rejected.length} location(s) were not saved because you do not have access to them.`,
    } : {}),
  })
}

async function nativeDelete(ctx: Ctx, ref: string) {
  if (ctx.role !== 'SYSTEM_ADMIN' && ctx.role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'System admin only' }, { status: 403 })
  // Creator only, SUPER_ADMIN excepted — same rule as edit. See nativeUpdate.
  const creator = await linkCreator(ref)
  const isSuperAdmin = ctx.role === 'SUPER_ADMIN'
  if (!isSuperAdmin && (!creator?.email || creator.email !== ctx.email)) {
    return NextResponse.json({
      error: 'Only the creator can delete this link',
      description: creator?.name
        ? `This link was created by ${creator.name}. Ask them to delete it.`
        : 'This link was created by someone else.',
      createdBy: creator?.name ?? null,
    }, { status: 403 })
  }
  // Deleting removes the page for EVERY member, so even the creator cannot delete
  // one that still carries locations they cannot reach. SUPER_ADMIN is
  // unrestricted and so is never caught by this.
  const scope = await resolveDiscoAccessScope(ctx)
  const editScope = await resolveLinkEditScope(ref, scope)
  if (editScope.retained.length) {
    return NextResponse.json({
      error: 'Not allowed',
      description: `This link includes ${editScope.retained.length} location(s) you do not have access to, so it cannot be deleted. Remove your locations from it instead.`,
    }, { status: 403 })
  }
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
