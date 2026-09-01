import { NextRequest, NextResponse } from 'next/server'
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
  const content = rows.map(r => ({
    reference: r.reference,
    businessName: r.businessName,
    address: { addressLine1: r.address || '', addressLine2: r.address_line2 || '', city: r.city || '', state: r.state || '', zipcode: r.zipcode || '', phoneNumber: r.phone || '' },
    createdDate: r.createdDate,
    blocked: r.blocked,
    archived: false,
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
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch locations' }, { status: 500 })
  }
}
