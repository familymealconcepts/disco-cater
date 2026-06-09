import { NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../lib/db'
import { getFmServiceAuthHeader } from '../../../lib/fm-service-auth'

// Public restaurant feed for the fullmap. Bypasses Sanity entirely: pulls live
// restaurants straight from FM (via a server service account) and layers Disco's
// own overrides from Neon. A restaurant appears on the map ONLY when a Disco
// admin has marked it visible in disco_restaurant_overrides — FM's admin list
// reports type "ORDERING" for everything, so there's no MARKETPLACE flag to key
// off; the `visible` override is our source of truth instead. Cached 5 minutes.
export const revalidate = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

type FmRow = Record<string, unknown>

// Fetch every page of FM's admin restaurants list with the service JWT. Retries
// once on 401 by force-refreshing the token.
async function fetchAllFmRestaurants(): Promise<FmRow[]> {
  const SIZE = 200
  const MAX_PAGES = 100
  const all: FmRow[] = []
  let header = await getFmServiceAuthHeader()
  let page = 0
  let totalPages = 1
  let retried = false

  while (page < totalPages && page < MAX_PAGES) {
    const params = new URLSearchParams({ page: String(page), size: String(SIZE) })
    const res = await fetch(`${FM}/api/admin/restaurants?${params}`, { headers: header, cache: 'no-store' })
    if (res.status === 401 && !retried) {
      retried = true
      header = await getFmServiceAuthHeader(true)
      continue
    }
    if (!res.ok) break
    const d = await res.json().catch(() => null)
    const content: FmRow[] = Array.isArray(d?.content) ? d.content : Array.isArray(d) ? d : []
    all.push(...content)
    totalPages = typeof d?.totalPages === 'number' ? d.totalPages : 1
    page++
  }
  return all
}

export async function GET() {
  try {
    await runMigrations()

    const fmRows = await fetchAllFmRestaurants()
    const overrideRows = (await sql`
      SELECT restaurant_reference, is_premium, order_url, visible, stripe_connected FROM disco_restaurant_overrides
    `) as { restaurant_reference: string; is_premium: boolean; order_url: string | null; visible: boolean; stripe_connected: boolean }[]

    const overrides = new Map(overrideRows.map((o) => [o.restaurant_reference, o]))

    // Core qualification: active, non-blocked restaurants. (FM reports type
    // "ORDERING" for all of them, so there's no MARKETPLACE filter — map
    // visibility is driven entirely by the `visible` override below.)
    const qualifying = fmRows.filter((r) => {
      const status = String((r.status ?? r.restaurantStatus) || '').toUpperCase()
      const blocked = r.blocked === true
      return status === 'ACCEPTED' && !blocked
    })

    const result = qualifying
      .map((r) => {
        const addr = (r.address || {}) as Record<string, unknown>
        const lat = asNumber(addr.latitude)
        const lng = asNumber(addr.longitude)
        if (lat == null || lng == null) return null // require numeric coords

        const reference = String(r.reference ?? r.restaurantReference ?? '')
        if (!reference) return null

        // Map listing is opt-in AND payment-ready: a restaurant appears only
        // when a Disco admin marked it visible AND its Stripe Connect status
        // (synced via /api/admin/sync-stripe-status) is connected.
        const ov = overrides.get(reference)
        if (!ov?.visible || !ov?.stripe_connected) return null

        const businessName = String(r.businessName || '')
        const slug = r.businessNameWithoutSpaces
          ? String(r.businessNameWithoutSpaces).toLowerCase()
          : slugify(businessName)

        // FM's admin list returns no cuisine/category data, so default to 'Other'.
        // Real cuisine data needs a separate source (Sanity, or a future column
        // on disco_restaurant_overrides / manual entry).
        const cuisine = 'Other'

        const city = String(addr.city || '')
        const state = String(addr.state || '')
        const location = [city, state].filter(Boolean).join(', ')
        const address = [addr.addressLine1, city, state, addr.zipcode]
          .map((p) => (p == null ? '' : String(p)))
          .filter(Boolean)
          .join(', ')

        const orderUrl = ov?.order_url || `/restaurants/${slug}`
        const isPremium = ov?.is_premium ?? false

        return {
          reference,
          name: businessName,
          slug,
          cuisine,
          description: typeof r.description === 'string' ? r.description : '',
          image: typeof r.locationImage === 'string' ? r.locationImage : null,
          lat,
          lng,
          location,
          address,
          orderUrl,
          isPremium,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

    console.log(
      `[Restaurants API] Returning ${result.length} visible+stripe-connected restaurants (of ${qualifying.length} ACCEPTED, ${fmRows.length} fetched)`,
    )

    return NextResponse.json(result)
  } catch (e) {
    console.error('[Restaurants API] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load restaurants' }, { status: 500 })
  }
}
