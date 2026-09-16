import { NextRequest, NextResponse } from 'next/server'
import { stripeStatusByReference, type StripeAccountStatus } from '../../../../lib/stripe-account-status'
import { runStripeCapabilityMigrations } from '../../../../lib/db'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { discoGroupRefs } from '../../../../lib/disco-restaurant-auth'
import { resolveDiscoGroupScope } from '../../../../lib/restaurant-write-scope'
import { sql, runMigrations } from '../../../../lib/db'

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
    SELECT restaurant_reference AS reference, name AS "businessName",
           address, address_line2, city, state, zipcode, phone,
           to_char(cached_at, 'YYYY-MM-DD') AS "createdDate",
           (NOT COALESCE(is_live, false)) AS blocked
    FROM disco_restaurant_cache
    WHERE restaurant_reference = ANY(${refs}::text[])
      AND (${search} = '' OR LOWER(name) LIKE '%' || ${search} || '%' OR LOWER(COALESCE(address, '')) LIKE '%' || ${search} || '%')
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
    address: { addressLine1: r.address || '', addressLine2: r.address_line2 || '', city: r.city || '', state: r.state || '', zipcode: r.zipcode || '', phoneNumber: r.phone || '' },
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
    // ── NATIVE SIBLINGS, WHICH FM CANNOT KNOW ABOUT ──────────────────────────
    // A Disco-native location has no FM record, so FM's list can never contain
    // it — and this branch runs for exactly the session our team uses most: the
    // master password on an FM-backed chain issues an fm_restaurant_token, where
    // ctx.email is '' and there is no Disco identity to scope with. That is why
    // a duplicated Stacks & Cordials location was invisible to Peter here.
    //
    // THE AUTHORITY IS THE MULTI-UNIT LINK, which is Disco's own native chain
    // grouping (disco_multi_unit_link_members). It is keyed on the RESTAURANT,
    // not on the caller, so it needs no email and no grant — the two things a
    // master-password session does not have. The clone adds the copy to its
    // source's link, so a duplicate inherits exactly the audience the original
    // had. No FM lookup is involved in resolving it.
    //
    // ── SEEDED FROM FM'S OWN ANSWER, NOT FROM A COOKIE ───────────────────────
    // The first version of this asked getRestaurantRef() for a single "home"
    // reference and looked up that restaurant's chain. That silently did nothing
    // for the exact session it was written for: getRestaurantRef reads the FM
    // JWT's `restaurant` claim, and an FM SYSTEM_ADMIN managing a chain does not
    // necessarily carry one — so homeRef was '' and the whole merge was skipped.
    // Alexander Karana saw "2 of 2" because FM returned 2 and nothing was added.
    //
    // SEEDING FROM FM'S RETURNED REFERENCES fixes that and is better in principle:
    // FM has already decided which locations this caller may see, so using that
    // set as the seed inherits FM's authorization exactly, needs no cookie, no
    // email and no grant, and cannot grant reach the caller did not already have.
    // For every location FM returned, its Disco-native chain siblings are added.
    try {
      const fmList: Array<{ reference?: unknown }> = Array.isArray(data?.content) ? data.content : []
      const seedRefs = fmList.map((l) => String(l?.reference ?? '')).filter(Boolean)
      if (seedRefs.length) {
        const fmRefs = new Set(seedRefs.map((r) => r.toLowerCase()))
        const siblings = (await sql`
          SELECT DISTINCT c.restaurant_reference AS reference, c.name AS "businessName",
                 c.address, c.address_line2, c.city, c.state, c.zipcode, c.phone,
                 to_char(c.cached_at, 'YYYY-MM-DD') AS "createdDate",
                 (NOT COALESCE(c.is_live, false)) AS blocked
            FROM disco_multi_unit_link_members seed
            JOIN disco_multi_unit_link_members sib ON sib.link_reference = seed.link_reference
            JOIN disco_restaurant_cache c ON c.restaurant_reference = sib.restaurant_reference
           WHERE seed.restaurant_reference = ANY(${seedRefs}::text[])
             AND c.is_disco_native = true
             AND c.archived_at IS NULL
        `) as Array<Record<string, unknown>>
        const extra = siblings
          .filter((r) => !fmRefs.has(String(r.reference).toLowerCase()))
          .map((r) => ({
            reference: r.reference,
            businessName: r.businessName,
            address: {
              addressLine1: r.address || '', addressLine2: r.address_line2 || '',
              city: r.city || '', state: r.state || '', zipcode: r.zipcode || '',
              phoneNumber: r.phone || '',
            },
            createdDate: r.createdDate,
            blocked: r.blocked,
            archived: false,
            stripe: null,
            discoNative: true,
          }))
        if (extra.length) {
          data.content = [...fmList, ...extra]
          data.totalElements = (Number(data.totalElements) || fmList.length) + extra.length
        }
      }
    } catch (e) {
      // Never let this blank FM's list — a degraded list beats no list. LOGGED
      // loudly: the previous version failed silently and looked identical to
      // "there is nothing to add", which is what made this take two attempts.
      console.error('[restaurant/locations] native sibling merge failed:', e instanceof Error ? (e.stack || e.message) : e)
    }

    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Unable to fetch locations' }, { status: 500 })
  }
}
