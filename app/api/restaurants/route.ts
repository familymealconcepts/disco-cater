import { NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../lib/db'
import { getFmServiceAuthHeader } from '../../../lib/fm-service-auth'

// Public restaurant feed for the fullmap. Bypasses Sanity entirely: pulls live
// restaurants straight from FM (via a server service account) and layers Disco's
// own Premium/order-URL overrides from Neon. Cached for 5 minutes.
export const revalidate = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Cuisine pill vocabulary used by the fullmap filter.
const CUISINE_PILLS = [
  'American', 'Italian', 'Mexican', 'Japanese', 'Chinese', 'Indian', 'Mediterranean',
  'Thai', 'Korean', 'French', 'Middle Eastern', 'Caribbean', 'BBQ', 'Vegan', 'Other',
] as const

// Map an arbitrary FM cuisine/category string onto one of our pill values.
function mapCuisine(raw?: string): string {
  if (!raw) return 'Other'
  const s = raw.toLowerCase()
  if (s.includes('american')) return 'American'
  if (s.includes('ital')) return 'Italian'
  if (s.includes('mex')) return 'Mexican'
  if (s.includes('japan') || s.includes('sushi')) return 'Japanese'
  if (s.includes('chin')) return 'Chinese'
  if (s.includes('indian')) return 'Indian'
  if (s.includes('medi')) return 'Mediterranean'
  if (s.includes('thai')) return 'Thai'
  if (s.includes('korea')) return 'Korean'
  if (s.includes('french')) return 'French'
  if (s.includes('middle east')) return 'Middle Eastern'
  if (s.includes('caribb') || s.includes('jamaic')) return 'Caribbean'
  if (s.includes('bbq') || s.includes('barbe')) return 'BBQ'
  if (s.includes('vegan') || s.includes('vegetar') || s.includes('plant')) return 'Vegan'
  const exact = CUISINE_PILLS.find((p) => p.toLowerCase() === s)
  return exact || 'Other'
}

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
      SELECT restaurant_reference, is_premium, order_url FROM disco_restaurant_overrides
    `) as { restaurant_reference: string; is_premium: boolean; order_url: string | null }[]

    const overrides = new Map(overrideRows.map((o) => [o.restaurant_reference, o]))

    // TEMP DEBUG: inspect the FM field values we filter on (remove once verified).
    console.log('[Restaurants API] Total FM restaurants fetched:', fmRows.length)
    console.log('[Restaurants API] Sample FM restaurant fields:', JSON.stringify(
      fmRows.slice(0, 3).map((r) => {
        const addr = (r.address || {}) as Record<string, unknown>
        return {
          name: r.businessName,
          restaurantStatus: r.restaurantStatus,
          status: r.status,
          type: r.type,
          blocked: r.blocked,
          hasLat: addr.latitude != null,
          hasLng: addr.longitude != null,
        }
      }), null, 2,
    ))

    // Core qualification: active marketplace restaurants only.
    const qualifying = fmRows.filter((r) => {
      const status = String((r.restaurantStatus ?? r.status) || '').toUpperCase()
      const type = String(r.type || '').toUpperCase()
      const blocked = r.blocked === true
      return status === 'ACCEPTED' && !blocked && type === 'MARKETPLACE'
    })

    const result = qualifying
      .map((r) => {
        const addr = (r.address || {}) as Record<string, unknown>
        const lat = asNumber(addr.latitude)
        const lng = asNumber(addr.longitude)
        if (lat == null || lng == null) return null // require numeric coords

        const reference = String(r.reference ?? r.restaurantReference ?? '')
        if (!reference) return null

        const businessName = String(r.businessName || '')
        const slug = r.businessNameWithoutSpaces
          ? String(r.businessNameWithoutSpaces).toLowerCase()
          : slugify(businessName)

        const categories = Array.isArray(r.categories) ? (r.categories as string[]) : []
        const cuisine = mapCuisine((r.cuisine as string) || categories[0])

        const city = String(addr.city || '')
        const state = String(addr.state || '')
        const location = [city, state].filter(Boolean).join(', ')
        const address = [addr.addressLine1, city, state, addr.zipcode]
          .map((p) => (p == null ? '' : String(p)))
          .filter(Boolean)
          .join(', ')

        const ov = overrides.get(reference)
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

    const filteredOut = fmRows.length - result.length
    console.log(
      `[Restaurants API] Returning ${result.length} restaurants (${qualifying.length} MARKETPLACE+ACCEPTED, ${filteredOut} filtered out)`,
    )

    return NextResponse.json(result)
  } catch (e) {
    console.error('[Restaurants API] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load restaurants' }, { status: 500 })
  }
}
