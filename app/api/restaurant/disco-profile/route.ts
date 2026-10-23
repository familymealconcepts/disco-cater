import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { getRestaurantRef, SELECTED_RESTAURANT_COOKIE } from '../../../../lib/restaurant-auth'
import { cookies } from 'next/headers'
import { requireWritableRestaurantRef } from '../../../../lib/restaurant-write-scope'
import { partsFromOneLine, saveRestaurantAddress } from '../../../../lib/restaurant-address'
import { formatDisplayAddress } from '../../../../lib/address-display'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Disco-native restaurant profile (name / address / phone / logo) — stored in
// disco_restaurant_accounts + disco_restaurant_cache during onboarding. The
// portal reads/edits it here. We NEVER sync these back to FM.

async function resolveRef(): Promise<string | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return null
  // Disco: the currently-selected location (home for a single-location ADMIN);
  // FM: the JWT's restaurant. Keeps read + write on the same location for
  // multi-location SYSTEM_ADMINs.
  if (ctx.authType === 'disco') return await resolveDiscoScopeRef(ctx)
  return await getRestaurantRef()
}

export async function GET() {
  const ref = await resolveRef()
  if (!ref) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    await runMigrations()
    const cache = (await sql`
      SELECT name, phone, address, address_line1, address_line2, city, state, zipcode, image_url, icon_url, timezone
      FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
    `) as { name: string | null; phone: string | null; address: string | null; address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; zipcode: string | null; image_url: string | null; icon_url: string | null; timezone: string | null }[]
    const c = cache[0] || {}
    return NextResponse.json({
      restaurant_reference: ref,
      restaurantName: c.name || '',
      phone: c.phone || '',
      // The Address box shows street, city, state ZIP; line 2 has its own box.
      // A row saved before line 1 existed falls back to its one-line value.
      address: (c.address_line1 ? formatDisplayAddress({ addressLine1: c.address_line1, city: c.city, state: c.state, zipcode: c.zipcode }) : '') || c.address || '',
      addressLine2: c.address_line2 || '',
      logoUrl: c.image_url || '', // Marketplace Image
      iconUrl: c.icon_url || '',  // Logo
      // IANA zone the menu form labels its hard-cutoff time with. '' = not set.
      timezone: c.timezone || '',
    })
  } catch (err) {
    console.error('[restaurant/disco-profile] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to fetch profile' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    // The write target is the restaurant_reference the CLIENT explicitly claims
    // (the one its form was loaded for), verified against the caller's permitted
    // set — never whatever the session's CURRENT selection resolves to. That's
    // the DeCheco's bug: load Location A's profile, switch to Location B, save —
    // without this, the write silently landed on B because that's what resolveRef()
    // resolves to at save time, not what the form displayed.
    const check = await requireWritableRestaurantRef(body?.restaurant_reference)
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
    const ref = check.ref

    // ── MAY-WRITE IS NOT THE SAME QUESTION AS IS-THIS-WHAT-YOU-ARE-LOOKING-AT ──
    // requireWritableRestaurantRef only asks whether the caller is ALLOWED to
    // write this reference. It says nothing about whether the reference is the
    // restaurant the form was actually showing — and for a chain admin every
    // location in the chain is allowed, so a wrong reference sails through.
    //
    // That was live exposure. Opening a DUPLICATED location's Account page on an
    // FM (master-password) session rendered the SOURCE's name and reference,
    // because getRestaurantRef() discards a selected reference FamilyMeal has
    // never heard of and falls back to the JWT's home restaurant. Saving then
    // rewrote the live source's name, phone, address and logo while the operator
    // believed they were editing the copy.
    //
    // COMPARE AGAINST THE VIEWER'S OWN SELECTION, not against a re-resolution.
    // The selected-restaurant cookie is what the operator actually clicked, and
    // it is set for a Disco-native target too (see 4a5299e). Falling back to
    // resolveRef() covers a single-location ADMIN, who has no selection.
    //
    // REFUSE, never redirect the write. Silently retargeting is how the DeCheco's
    // bug behaved (load Location A, switch to B, save, and the write landed on B);
    // an explicit refusal tells the operator to reload instead of guessing which
    // restaurant they meant.
    const store = await cookies()
    const selected = (store.get(SELECTED_RESTAURANT_COOKIE)?.value || '').trim()
    const viewing = selected || (await resolveRef()) || ''
    if (viewing && viewing.toLowerCase() !== ref.toLowerCase()) {
      console.error('[disco-profile] refused a write whose reference is not the one in view:', { claimed: ref, viewing })
      return NextResponse.json({
        error: 'This page was loaded for a different location than the one you have selected, so nothing was saved. Reload the page and try again.',
      }, { status: 409 })
    }
    const restaurantName = String(body?.restaurantName || '').trim()
    const phone = String(body?.phone || '').trim()
    const address = String(body?.address || '').trim()
    const addressLine2 = String(body?.addressLine2 || '').trim()
    // Images are optional — only touched when explicitly provided.
    // logoUrl = Marketplace Image (image_url); iconUrl = Logo (icon_url).
    const logoUrl = body?.logoUrl != null ? String(body.logoUrl).trim() : undefined
    const iconUrl = body?.iconUrl != null ? String(body.iconUrl).trim() : undefined

    await runMigrations()

    // disco_restaurant_cache (drives the marketplace listing). Re-geocode when the
    // address is present so the map pin stays accurate.
    await sql`
      UPDATE disco_restaurant_cache SET
        name = COALESCE(NULLIF(${restaurantName}, ''), name),
        phone = ${phone || null},
        cached_at = NOW()
      WHERE restaurant_reference = ${ref}
    `
    // Every address column + the map pin, from this one box (lib/restaurant-address.ts).
    const saved = await saveRestaurantAddress(ref, await partsFromOneLine(address, addressLine2))
    // Marketplace Image (image_url) — only when explicitly provided.
    if (logoUrl !== undefined) {
      await sql`
        UPDATE disco_restaurant_cache SET image_url = ${logoUrl || null}, cached_at = NOW()
        WHERE restaurant_reference = ${ref}
      `
    }
    // Logo (icon_url) — only when explicitly provided.
    if (iconUrl !== undefined) {
      await sql`
        UPDATE disco_restaurant_cache SET icon_url = ${iconUrl || null}, cached_at = NOW()
        WHERE restaurant_reference = ${ref}
      `
    }

    return NextResponse.json({ success: true, address: saved.address, located: saved.located })
  } catch (err) {
    console.error('[restaurant/disco-profile] PUT failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to update profile' }, { status: 500 })
  }
}
