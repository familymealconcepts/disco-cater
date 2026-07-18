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
  lat: number
  lng: number
  location: string
  address: string
  // Structured address parts + timezone from FM — so downstream consumers
  // (Expedite courier dispatch) never have to parse the single-line address or
  // assume a timezone.
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  zipcode: string | null
  timezone: string | null
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
  const addressLine1 = addr.addressLine1 != null ? String(addr.addressLine1) : null
  const addressLine2 = addr.addressLine2 != null ? String(addr.addressLine2) : null
  const zipcode = addr.zipcode != null ? String(addr.zipcode) : null
  const address = [addressLine1, city, state, zipcode]
    .map((p) => (p == null ? '' : String(p)))
    .filter(Boolean)
    .join(', ')
  const timezone = r.timezone != null && String(r.timezone).trim() ? String(r.timezone).trim() : null

  return { reference, name, slug, lat, lng, location, address, addressLine1, addressLine2, city: city || null, state: state || null, zipcode, timezone }
}

/**
 * Fetches all FM restaurants, filters to active+coords, and upserts the
 * FM-OWNED columns into disco_restaurant_cache. cuisine/description/image_url are
 * deliberately left alone on conflict — those are owned by the Sanity import.
 * Returns counts + duration.
 */
export async function refreshRestaurantCache(): Promise<{ total: number; cached: number; durationMs: number }> {
  const startedAt = Date.now()
  await runMigrations()

  const fmRows = await fetchAllFmRestaurants()
  const rows = fmRows.map(normalize).filter((x): x is CacheRow => x !== null)

  // Upsert in concurrent chunks. On INSERT, cuisine defaults to 'Other' and
  // description/image_url stay null until the Sanity import fills them; on
  // conflict we only refresh the FM-owned fields, never the Sanity ones.
  const CHUNK = 50
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    await Promise.all(
      chunk.map((c) => sql`
        INSERT INTO disco_restaurant_cache
          (restaurant_reference, name, slug, lat, lng, location, address,
           address_line1, address_line2, city, state, zipcode, timezone, cached_at)
        VALUES (${c.reference}, ${c.name}, ${c.slug}, ${c.lat}, ${c.lng}, ${c.location}, ${c.address},
           ${c.addressLine1}, ${c.addressLine2}, ${c.city}, ${c.state}, ${c.zipcode}, ${c.timezone}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET
          name = EXCLUDED.name,
          slug = EXCLUDED.slug,
          lat = EXCLUDED.lat,
          lng = EXCLUDED.lng,
          location = EXCLUDED.location,
          address = EXCLUDED.address,
          address_line1 = EXCLUDED.address_line1,
          address_line2 = EXCLUDED.address_line2,
          city = EXCLUDED.city,
          state = EXCLUDED.state,
          zipcode = EXCLUDED.zipcode,
          -- Keep an existing timezone if FM sends none, so a manually-set tz isn't wiped.
          timezone = COALESCE(EXCLUDED.timezone, disco_restaurant_cache.timezone),
          cached_at = NOW()
      `),
    )
  }

  return { total: fmRows.length, cached: rows.length, durationMs: Date.now() - startedAt }
}
