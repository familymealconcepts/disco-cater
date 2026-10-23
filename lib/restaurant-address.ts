import { sql } from './db'
import { formatDisplayAddress } from './address-display'

/**
 * ONE WRITE PATH FOR A DISCO-NATIVE RESTAURANT'S ADDRESS (Peter, 23 Oct 2026).
 *
 * disco_restaurant_cache carries the address several ways, and different
 * surfaces read different ones:
 *   - `address`            one line — customer page header, the order's
 *                          restaurant_address snapshot (PDF), reminder emails
 *   - `address_line1/2`, `city`, `state`, `zipcode`
 *                          structured — link pages, marketplace/search,
 *                          confirmation emails, Expedite courier pickups
 *   - `location`           "City, ST" — cards, map popup, search, city pages
 *   - `lat`/`lng`          the map pin, delivery radius, courier routing
 *
 * Restaurant Info used to write only `address` (+ a best-effort pin), and no
 * native writer ever set `address_line1`, so every structured reader kept the
 * last value FamilyMeal's nightly mirror put there. Almost Home – Monmouth Beach
 * Gianni's saved "36 Beach Rd, Monmouth Beach" and its link page, emails and
 * courier pickups still said "282 E Main St, Oceanport".
 *
 * saveRestaurantAddress writes ALL of them from one set of parts, so they can no
 * longer disagree. `address_line1` is the street only; `address_line2` is the
 * optional suite/unit/floor; `address` is the composed one-line form, line 2
 * included. lib/restaurant-cache.ts no longer overwrites any of these on a
 * native row.
 */

export interface RestaurantAddressParts {
  line1: string | null
  line2?: string | null
  city: string | null
  state: string | null
  zipcode: string | null
}

const COUNTRY_RE = /^(?:usa?|u\.s\.a?\.?|united states(?: of america)?)$/i
const ST_ZIP_RE = /^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/
const ZIP_RE = /^\d{5}(?:-\d{4})?$/

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null)

/**
 * "36 Beach Rd, Monmouth Beach, NJ 07750[, USA]" → street / city / ST / zip.
 * Also accepts "…, City, NJ, 07750". Null when the line has no recognisable
 * "City, ST ZIP" tail — the caller then asks the geocoder.
 */
export function parseOneLineAddress(value: string | null | undefined): RestaurantAddressParts | null {
  const f = String(value || '').split(',').map(x => x.trim()).filter(Boolean).filter(x => !COUNTRY_RE.test(x))
  if (f.length < 3) return null
  let state: string | null = null, zip: string | null = null, cityIdx = -1
  const last = f[f.length - 1]
  const m = ST_ZIP_RE.exec(last)
  if (m) { state = m[1].toUpperCase(); zip = m[2]; cityIdx = f.length - 2 }
  else if (ZIP_RE.test(last) && /^[A-Za-z]{2}$/.test(f[f.length - 2] || '')) { state = f[f.length - 2].toUpperCase(); zip = last; cityIdx = f.length - 3 }
  if (cityIdx < 1) return null
  return { line1: f.slice(0, cityIdx).join(', '), city: f[cityIdx], state, zipcode: zip }
}

type Geo = { lat: number; lng: number; parts: RestaurantAddressParts | null }

/** Google first (same key the rest of the app geocodes with), Mapbox as the fallback. Never throws. */
export async function geocodeAddress(address: string): Promise<Geo | null> {
  if (!address) return null
  const gkey = process.env.GOOGLE_PLACES_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY
  if (gkey) {
    try {
      const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&components=country:US&key=${gkey}`)
      const d = await res.json().catch(() => null) as { results?: Array<{ geometry?: { location?: { lat: number; lng: number } }; address_components?: Array<{ long_name: string; short_name: string; types: string[] }> }> } | null
      const top = d?.results?.[0]
      const loc = top?.geometry?.location
      if (loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))) {
        const c = (t: string, short = false) => { const x = top?.address_components?.find(a => a.types.includes(t)); return x ? (short ? x.short_name : x.long_name) : null }
        const street = [c('street_number'), c('route', true)].filter(Boolean).join(' ') || null
        const city = c('locality') || c('sublocality') || c('postal_town') || c('administrative_area_level_3')
        return { lat: Number(loc.lat), lng: Number(loc.lng), parts: street ? { line1: street, city, state: c('administrative_area_level_1', true), zipcode: c('postal_code') } : null }
      }
    } catch { /* fall through to Mapbox */ }
  }
  const mkey = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  if (mkey) {
    try {
      const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?country=us&limit=1&access_token=${mkey}`)
      const d = await res.json().catch(() => null) as { features?: Array<{ center?: [number, number] }> } | null
      const ctr = d?.features?.[0]?.center
      if (ctr && Number.isFinite(ctr[0]) && Number.isFinite(ctr[1])) return { lat: ctr[1], lng: ctr[0], parts: null }
    } catch { /* no pin */ }
  }
  return null
}

/** The one-line form every one-line reader gets — line 2 included, after the street. */
export function composeRestaurantAddress(p: RestaurantAddressParts): string {
  return formatDisplayAddress({ addressLine1: p.line1, addressLine2: p.line2 ?? null, city: p.city, state: p.state, zipcode: p.zipcode })
}

export interface SaveAddressResult { address: string; parts: RestaurantAddressParts; located: boolean }

/**
 * Write a native restaurant's address everywhere it is stored. `coords` are used
 * when the caller already has them (a Places pick); otherwise the address is
 * geocoded. If no pin can be found the old one is KEPT and `located` is false,
 * so the caller can say so rather than silently leaving a stale pin.
 */
export async function saveRestaurantAddress(
  ref: string,
  input: RestaurantAddressParts,
  coords?: { lat: number | null | undefined; lng: number | null | undefined } | null,
): Promise<SaveAddressResult> {
  const parts: RestaurantAddressParts = {
    line1: clean(input.line1), line2: clean(input.line2 ?? null),
    city: clean(input.city), state: clean(input.state)?.toUpperCase() ?? null, zipcode: clean(input.zipcode),
  }
  const noLine2 = { ...parts, line2: null }
  const oneLine = composeRestaurantAddress(noLine2)
  let lat = coords?.lat != null && Number.isFinite(Number(coords.lat)) ? Number(coords.lat) : null
  let lng = coords?.lng != null && Number.isFinite(Number(coords.lng)) ? Number(coords.lng) : null
  if ((lat == null || lng == null) && oneLine) {
    const g = await geocodeAddress(oneLine)
    if (g) { lat = g.lat; lng = g.lng }
  }
  const address = composeRestaurantAddress(parts) || null
  const location = parts.city ? [parts.city, parts.state].filter(Boolean).join(', ') : null
  await sql`
    UPDATE disco_restaurant_cache SET
      address = ${address},
      address_line1 = ${parts.line1},
      address_line2 = ${parts.line2},
      city = ${parts.city},
      state = ${parts.state},
      zipcode = ${parts.zipcode},
      location = COALESCE(${location}, location),
      lat = COALESCE(${lat}, lat),
      lng = COALESCE(${lng}, lng),
      cached_at = NOW()
    WHERE restaurant_reference = ${ref}`
  return { address: address || '', parts, located: lat != null && lng != null }
}

/**
 * Restaurant Info's single "Street, City, State ZIP" box → parts. The typed
 * words are kept; the geocoder is asked only when the line has no recognisable
 * city/state/zip tail.
 */
export async function partsFromOneLine(value: string, line2?: string | null): Promise<RestaurantAddressParts> {
  const typed = clean(value)
  if (!typed) return { line1: null, line2: clean(line2 ?? null), city: null, state: null, zipcode: null }
  const parsed = parseOneLineAddress(typed)
  if (parsed) return { ...parsed, line2: clean(line2 ?? null) }
  const g = await geocodeAddress(typed)
  if (g?.parts) return { ...g.parts, line2: clean(line2 ?? null) }
  return { line1: typed, line2: clean(line2 ?? null), city: null, state: null, zipcode: null }
}

/** The street the portal's location editors show in their "Address" field: line 1 when set, else the legacy one-line value. */
export function streetForEditor(row: { address_line1?: unknown; address?: unknown }): string {
  return String(row.address_line1 || row.address || '')
}
