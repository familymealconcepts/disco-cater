import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { getDiscoGroupAccounts } from '../../../../lib/disco-restaurant-auth'
import { sql, runMigrations } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Disco-native: the SA's locations are their group accounts (getDiscoGroupAccounts),
// enriched from disco_restaurant_cache. Returns FM's { content, totalElements } +
// Location field names so the page needs no changes. Zero FM.
async function discoLocations(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>, req: NextRequest) {
  const group = await getDiscoGroupAccounts(ctx.businessName, ctx.email)
  const refs = [...new Set([ctx.restaurantReference, ...group.map(g => g.restaurant_reference)].filter(Boolean))]
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
