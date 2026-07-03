// Zero-FM geocoding + distance for native delivery validation (Disco-native
// restaurants). Prefers Mapbox (its token is already provisioned for geocoding
// and used across the app) and falls back to Google. NOTE: the Google Geocoding
// API is currently NOT enabled on the project (REQUEST_DENIED), so Mapbox is the
// working path — verified 2026-07-03.

export interface LatLng { lat: number | null; lng: number | null }

// Mapbox forward geocoding (features[0].center = [lng, lat]).
async function geocodeViaMapbox(address: string): Promise<LatLng> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  if (!token) return { lat: null, lng: null }
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${token}&limit=1&country=US`
    const res = await fetch(url)
    if (!res.ok) { console.warn('[geocode] mapbox HTTP', res.status); return { lat: null, lng: null } }
    const data = await res.json()
    const c = data?.features?.[0]?.center
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') return { lat: c[1], lng: c[0] }
    return { lat: null, lng: null }
  } catch (e) {
    console.error('[geocode] mapbox failed:', e instanceof Error ? e.message : e)
    return { lat: null, lng: null }
  }
}

// Google Geocoding fallback (currently disabled on the project — kept for parity
// with app/api/order/place/route.ts and in case it's enabled later).
async function geocodeViaGoogle(address: string): Promise<LatLng> {
  const key = process.env.GOOGLE_PLACES_API_KEY
  if (!key) return { lat: null, lng: null }
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`
    const res = await fetch(url)
    if (!res.ok) { console.warn('[geocode] google HTTP', res.status); return { lat: null, lng: null } }
    const data = await res.json()
    const loc = data?.results?.[0]?.geometry?.location
    if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') return { lat: loc.lat, lng: loc.lng }
    return { lat: null, lng: null }
  } catch (e) {
    console.error('[geocode] google failed:', e instanceof Error ? e.message : e)
    return { lat: null, lng: null }
  }
}

// Geocode a free-form address to lat/lng. Best-effort: returns { null, null } on
// no result / any error — a geocode miss should surface as "address not
// serviceable", never a thrown error.
export async function geocodeAddress(address: string): Promise<LatLng> {
  if (!address.trim()) return { lat: null, lng: null }
  const viaMapbox = await geocodeViaMapbox(address)
  if (viaMapbox.lat != null && viaMapbox.lng != null) return viaMapbox
  return geocodeViaGoogle(address)
}

const EARTH_RADIUS_MILES = 3958.8
const toRad = (deg: number) => (deg * Math.PI) / 180

// Great-circle distance in miles between two coordinates (haversine).
export function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.min(1, Math.sqrt(s)))
}
