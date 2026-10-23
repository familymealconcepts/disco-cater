import { NextRequest, NextResponse } from 'next/server'
import { stripeStatusByReference, type StripeAccountStatus } from '../../../../lib/stripe-account-status'
import { runStripeCapabilityMigrations } from '../../../../lib/db'
import { getRestaurantAuthHeader, getRestaurantRole, getRestaurantEmail, getRestaurantRef } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { discoGroupRefs } from '../../../../lib/disco-restaurant-auth'
import { resolveDiscoGroupScope } from '../../../../lib/restaurant-write-scope'
import { sql, runMigrations } from '../../../../lib/db'
import { placeNewLocation, syncAfterGrant } from '../../../../lib/location-groups'
import { saveRestaurantAddress, streetForEditor } from '../../../../lib/restaurant-address'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Disco-native: the SA's locations are their group accounts (getDiscoGroupAccounts),
// enriched from disco_restaurant_cache. Returns FM's { content, totalElements } +
// Location field names so the page needs no changes. Zero FM.
//
// ROLE GATES REACH (fixed 2026-09-01). This used to call getDiscoGroupAccounts
// with no role branch, so an ADMIN carrying drifted grant rows got the whole
// list — verified, Stacy Freemyer (role ADMIN, FM assigns her Woodstock alone)
// got all 8 Atlanta Bread locations here. resolveDiscoGroupScope returns
// home-ref-only for any role that isn't SYSTEM_ADMIN, which is also what the
// portal shell already assumes: RESTAURANT_USER_NAV has no Locations entry, so
// an ADMIN was never meant to reach this list at all.
//
// SUPER_ADMIN keeps EXACTLY today's behaviour (their own business_name/
// email-domain group) rather than becoming unrestricted here — a true "every
// restaurant" view would need a real list-all-restaurants query, which does not
// exist; building one wasn't in scope.
async function discoLocations(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>, req: NextRequest) {
  const gate = await resolveDiscoGroupScope(ctx)
  const reachable = gate.unrestricted
    ? await discoGroupRefs(ctx.businessName, ctx.email, ctx.restaurantReference)
    : gate.refs
  const refs = [...new Set([ctx.restaurantReference, ...reachable].filter(Boolean))]
  if (!refs.length) return NextResponse.json({ content: [], totalElements: 0 })
  const search = (req.nextUrl.searchParams.get('search') || '').trim().toLowerCase()
  await runMigrations()
  const rows = (await sql`
    SELECT c.restaurant_reference AS reference, c.name AS "businessName",
           c.address, c.address_line1, c.address_line2, c.city, c.state, c.zipcode, c.phone,
           -- ── NOT cached_at. ────────────────────────────────────────────
           -- cached_at is the last time the SYNC refreshed this row, so the
           -- "Registered" column moved every time the cache ran and showed
           -- today's date for a restaurant onboarded in July. Al Volo and
           -- Realmuto read 10/01 in the portal against 07/20 and 07/22 in the
           -- super-admin list, which takes FamilyMeal's real createdDate.
           --
           -- disco_restaurant_overrides.created_at is when Disco first recorded
           -- the restaurant and is immutable: 2026-07-20 19:09 and 2026-07-22
           -- 21:40 for those two, the same day as FM's own value. Falls back to
           -- cached_at only when no overrides row exists at all.
           to_char(COALESCE(ovr.created_at, c.cached_at), 'YYYY-MM-DD') AS "createdDate",
           -- MAP. blocked is the inverse of the Map toggle, the column the
           -- marketplace feed actually reads. It was derived from is_live, which
           -- nothing maintains, so every location read as blocked.
           (NOT COALESCE(ovr.visible, true)) AS blocked
    FROM disco_restaurant_cache c
    LEFT JOIN disco_restaurant_overrides ovr ON ovr.restaurant_reference = c.restaurant_reference
    WHERE c.restaurant_reference = ANY(${refs}::text[])
      AND (${search} = '' OR LOWER(c.name) LIKE '%' || ${search} || '%' OR LOWER(COALESCE(c.address, '')) LIKE '%' || ${search} || '%')
    ORDER BY COALESCE(location_position, 999999) ASC, name ASC
  `) as Record<string, string | boolean | null>[]
  // Stripe status from the SHARED resolver — the same stored snapshot the
  // super-admin Ordering column reads, so the two screens cannot disagree about
  // the same restaurant. Never a live Stripe call.
  await runStripeCapabilityMigrations()
  const stripeStatus: Record<string, StripeAccountStatus> = await stripeStatusByReference(sql, rows.map(r => String(r.reference))).catch(() => ({}))
  const content = rows.map(r => ({
    reference: r.reference,
    businessName: r.businessName,
    address: { addressLine1: streetForEditor(r), addressLine2: r.address_line2 || '', city: r.city || '', state: r.state || '', zipcode: r.zipcode || '', phoneNumber: r.phone || '' },
    createdDate: r.createdDate,
    blocked: r.blocked,
    archived: false,
    stripe: stripeStatus[String(r.reference)] ?? null,
  }))
  return NextResponse.json({ content, totalElements: content.length })
}

// Mirrors FM's createRequestOption(): drops falsy values (page=0 is omitted),
// and appends each sort entry separately.
export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') return discoLocations(ctx, req)
  // ── A FAMILYMEAL-PASSWORD SYSTEM ADMIN SEES DISCO'S LIST (22 Oct 2026) ─────
  // Same list, same screen as a Disco-password System Admin: the person the
  // verified FM token names, resolved through Disco's grants. This replaced
  // FamilyMeal's list plus the multi-unit-link sibling merge below it, which
  // reached other businesses' locations and is no longer a source of access.
  if (ctx && (await getRestaurantRole()) === 'SYSTEM_ADMIN') {
    const email = (await getRestaurantEmail()) || ''
    if (!email) return NextResponse.json({ content: [], totalElements: 0 })
    return discoLocations({
      ...ctx, authType: 'disco', email, role: 'SYSTEM_ADMIN',
      restaurantReference: (await getRestaurantRef()) || '', businessName: null,
    }, req)
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  const page = sp.get('page')
  if (page && page !== '0') params.set('page', page)
  const size = sp.get('size') || '25'
  params.set('size', size)
  if (sp.get('search')) params.set('search', sp.get('search')!)
  sp.getAll('sort').forEach(s => params.append('sort', s))
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants?${params}`, { headers: h })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to fetch locations', status: res.status, raw: text }, { status: res.status })
    }
    const data = await res.json()
    // FM's rows carry FM references; a converted restaurant's Stripe snapshot is
    // keyed on its DISCO reference. stripeStatusByReference bridges both, which is
    // the bug that made Lee's Chinese Food read Connected on the super-admin
    // screen while being genuinely restricted. Best-effort: a failure here must
    // leave the locations list working, just without the Stripe column.
    try {
      const list = Array.isArray(data?.content) ? data.content : []
      if (list.length) {
        await runStripeCapabilityMigrations()
        const statuses = await stripeStatusByReference(sql, list.map((l: { reference?: unknown }) => String(l?.reference ?? '')))
        data.content = list.map((l: { reference?: unknown }) => ({ ...l, stripe: statuses[String(l?.reference ?? '')] ?? null }))
      }
    } catch { /* leave FM's payload untouched */ }
    // The multi-unit-link "native siblings" merge that lived here was removed
    // on 22 Oct 2026: link pages are customer-facing listings, not access, and
    // the merge exposed other businesses' locations. Only a non-System-Admin
    // FM session reaches this branch now, and it gets FamilyMeal's own answer.
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Unable to fetch locations' }, { status: 500 })
  }
}

// ── ADD A NEW LOCATION (Peter, 22 Oct 2026) ─────────────────────────────────
// Any System Admin can create a location. It is born Disco-native, HIDDEN from
// the marketplace (visible = false) and with ONLINE ORDERING OFF, so nothing a
// customer can reach changes until someone deliberately turns it on — and the
// marketplace still needs a Stripe account on top of both. Zero FamilyMeal.
//
// It goes on exactly two lists: the creator's, and the Primary System Admin's
// (lib/system-admin-authority.ts primariesFor — the Primary who shares a
// location with the creator). Nobody else is granted it; the creator can then
// assign it onward under the normal rules.
//
// A plain ADMIN is one location by design (CLAUDE.md, "Who can see which
// restaurants") and cannot create a second. An FM session has no Disco identity
// to put the location on, so it is refused with a pointer rather than creating
// a location nobody can see.
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (ctx.authType !== 'disco' || !ctx.email) {
    return NextResponse.json({ error: 'Sign in with your Disco Cater password to add a location.' }, { status: 403 })
  }
  const role = (ctx.role || '').toUpperCase()
  if (role !== 'SYSTEM_ADMIN' && role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Only a System Admin can add a location.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const name = s(body.name)
  if (!name) return NextResponse.json({ error: 'Location name is required.' }, { status: 400 })

  await runMigrations()
  const { randomUUID } = await import('node:crypto')
  const { primariesFor } = await import('../../../../lib/system-admin-authority')
  const ref = randomUUID()
  const slug = (name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 50) || 'location') + '-' + ref.slice(0, 6)
  const creator = ctx.email.trim().toLowerCase()

  // Timezone defaults to the creator's current location's, so lead times and
  // cutoffs have a clock before anyone edits it. Same business, almost always
  // the same region; editable afterwards.
  const tzRows = (await sql`
    SELECT timezone FROM disco_restaurant_cache WHERE restaurant_reference = ${ctx.restaurantReference} LIMIT 1
  `.catch(() => [])) as Array<{ timezone: string | null }>

  try {
    await sql`
      INSERT INTO disco_restaurant_cache
        (restaurant_reference, name, slug, phone, address, address_line2, city, state, zipcode, timezone,
         is_disco_native, is_live, cached_at)
      VALUES (${ref}, ${name}, ${slug}, ${s(body.phone)}, ${s(body.addressLine1)}, ${s(body.addressLine2)},
              ${s(body.city)}, ${s(body.state)}, ${s(body.zipcode)}, ${tzRows[0]?.timezone ?? null},
              true, false, NOW())
    `
    // Then every address column + the pin through the shared writer.
    await saveRestaurantAddress(ref, { line1: s(body.addressLine1), line2: s(body.addressLine2), city: s(body.city), state: s(body.state), zipcode: s(body.zipcode) })
    // visible = false is a literal, the one value the marketplace-switch guard
    // permits outside lib/marketplace-switch.ts.
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, online_ordering_enabled, contact_email, updated_at)
      VALUES (${ref}, false, false, ${creator}, NOW())
      ON CONFLICT (restaurant_reference) DO NOTHING
    `
    const primaries = await primariesFor(creator)
    const owners = [...new Set([creator, ...primaries])]
    await sql`
      INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by)
      SELECT e, ${ref}, ${creator} FROM unnest(${owners}::text[]) AS e
      ON CONFLICT (account_email, restaurant_reference) DO NOTHING
    `
    // The new location joins the creator's group; the group's Primary gets it.
    await placeNewLocation(ref, { creatorEmail: creator })
    await syncAfterGrant(creator, [ref])
    return NextResponse.json({ ok: true, reference: ref, name, grantedTo: owners })
  } catch (e) {
    console.error('[restaurant/locations POST] create failed:', ref, e instanceof Error ? e.message : e)
    // No partial location: neon HTTP has no transactions, so undo by hand.
    await sql`DELETE FROM disco_restaurant_location_access WHERE restaurant_reference = ${ref}`.catch(() => {})
    await sql`DELETE FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref}`.catch(() => {})
    await sql`DELETE FROM disco_restaurant_cache WHERE restaurant_reference = ${ref}`.catch(() => {})
    return NextResponse.json({ error: 'Could not create the location. Nothing was saved.' }, { status: 500 })
  }
}
