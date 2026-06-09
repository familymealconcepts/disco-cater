import { sql, runMigrations } from './db'
import { getFmServiceAuthHeader } from './fm-service-auth'

// Builds/refreshes disco_restaurant_cache from FM. This is the ONLY place that
// fetches FM for the map; the public /api/restaurants route reads the cache
// table instead, so map loads never call FM. Shared by the admin refresh route
// and the daily sync-restaurants cron.

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export function slugify(s: string): string {
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

interface CacheRow {
  reference: string
  name: string
  slug: string
  description: string | null
  imageUrl: string | null
  lat: number
  lng: number
  location: string
  address: string
}

// Normalize one FM row into a cache row, or null if it doesn't qualify
// (must be ACCEPTED, not blocked, with numeric coords + a reference).
function normalize(r: FmRow): CacheRow | null {
  const status = String((r.status ?? r.restaurantStatus) || '').toUpperCase()
  if (status !== 'ACCEPTED' || r.blocked === true) return null

  const addr = (r.address || {}) as Record<string, unknown>
  const lat = asNumber(addr.latitude)
  const lng = asNumber(addr.longitude)
  if (lat == null || lng == null) return null

  const reference = String(r.reference ?? r.restaurantReference ?? '')
  if (!reference) return null

  const name = String(r.businessName || '')
  const slug = r.businessNameWithoutSpaces ? String(r.businessNameWithoutSpaces).toLowerCase() : slugify(name)

  const city = String(addr.city || '')
  const state = String(addr.state || '')
  const location = [city, state].filter(Boolean).join(', ')
  const address = [addr.addressLine1, city, state, addr.zipcode]
    .map((p) => (p == null ? '' : String(p)))
    .filter(Boolean)
    .join(', ')

  return {
    reference,
    name,
    slug,
    description: typeof r.description === 'string' ? r.description : null,
    imageUrl: typeof r.locationImage === 'string' ? r.locationImage : null,
    lat,
    lng,
    location,
    address,
  }
}

/**
 * Fetches all FM restaurants, filters to active+coords, and upserts them into
 * disco_restaurant_cache. Returns counts + duration.
 */
export async function refreshRestaurantCache(): Promise<{ total: number; cached: number; durationMs: number }> {
  const startedAt = Date.now()
  await runMigrations()

  const fmRows = await fetchAllFmRestaurants()
  const rows = fmRows.map(normalize).filter((x): x is CacheRow => x !== null)

  // Upsert in concurrent chunks (FM cuisine is unknown → cache keeps the
  // table default 'Other'). One round-trip per row, parallelized per chunk.
  const CHUNK = 50
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    await Promise.all(
      chunk.map((c) => sql`
        INSERT INTO disco_restaurant_cache
          (restaurant_reference, name, slug, description, image_url, lat, lng, location, address, cached_at)
        VALUES (${c.reference}, ${c.name}, ${c.slug}, ${c.description}, ${c.imageUrl}, ${c.lat}, ${c.lng}, ${c.location}, ${c.address}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET
          name = EXCLUDED.name,
          slug = EXCLUDED.slug,
          description = EXCLUDED.description,
          image_url = EXCLUDED.image_url,
          lat = EXCLUDED.lat,
          lng = EXCLUDED.lng,
          location = EXCLUDED.location,
          address = EXCLUDED.address,
          cached_at = NOW()
      `),
    )
  }

  return { total: fmRows.length, cached: rows.length, durationMs: Date.now() - startedAt }
}
