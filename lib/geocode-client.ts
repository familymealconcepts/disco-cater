// Browser-side geocoding for the customer search boxes (homepage hero search and
// the /fullmap location filter) — turns whatever the diner TYPED ("Austin, TX",
// "78701", "Seattle") into a lat/lng without them having to click an
// autocomplete suggestion.
//
// Order of attempts, most robust first:
//   1. Mapbox forward geocoding (NEXT_PUBLIC_MAPBOX_TOKEN — already provisioned
//      and used by the map itself; a plain HTTPS call, no script to wait for).
//   2. Google Places: AutocompleteService prediction → PlacesService details.
//      The browser key is authorised for Places (the dropdown works), so this
//      covers a Mapbox outage without any Google Cloud change.
//   3. Google Geocoder — currently returns "This API key is not authorized"
//      because the Geocoding API is not enabled for the browser key. Kept as a
//      last resort so it starts contributing the moment it is enabled.
//   4. OpenStreetMap Nominatim — what /fullmap used before; free, rate-limited.
//
// Every step is best-effort: a failure falls through to the next one, and the
// function resolves null (never throws) when nothing found the place.

export interface GeocodeHit { lat: number; lng: number; label: string }

const US_TYPES = 'postcode,place,locality,neighborhood,address,region,district'

function valid(lat: unknown, lng: unknown): boolean {
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
}

async function viaMapbox(q: string): Promise<GeocodeHit | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  if (!token) return null
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${token}&limit=1&country=US&types=${US_TYPES}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const f = data?.features?.[0]
    const c = f?.center
    if (Array.isArray(c) && valid(c[1], c[0])) return { lat: c[1], lng: c[0], label: f.place_name || q }
  } catch { /* fall through */ }
  return null
}

function googlePlaces(): any | null {
  const g = typeof window !== 'undefined' ? (window as any).google : null
  return g?.maps?.places ? g : null
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>(resolve => setTimeout(() => resolve(null), ms))])
}

async function viaGooglePlaces(q: string): Promise<GeocodeHit | null> {
  const g = googlePlaces()
  if (!g) return null
  try {
    const prediction = await withTimeout(new Promise<any>(resolve => {
      new g.maps.places.AutocompleteService().getPlacePredictions(
        { input: q, componentRestrictions: { country: 'us' }, types: ['geocode'] },
        (preds: any[] | null, status: string) => resolve(status === 'OK' && preds?.[0] ? preds[0] : null),
      )
    }), 5000)
    if (!prediction?.place_id) return null
    const place = await withTimeout(new Promise<any>(resolve => {
      new g.maps.places.PlacesService(document.createElement('div')).getDetails(
        { placeId: prediction.place_id, fields: ['geometry', 'formatted_address'] },
        (p: any, status: string) => resolve(status === 'OK' ? p : null),
      )
    }), 5000)
    const loc = place?.geometry?.location
    if (loc && valid(loc.lat(), loc.lng())) {
      return { lat: loc.lat(), lng: loc.lng(), label: place.formatted_address || prediction.description || q }
    }
  } catch { /* fall through */ }
  return null
}

async function viaGoogleGeocoder(q: string): Promise<GeocodeHit | null> {
  const g = typeof window !== 'undefined' ? (window as any).google : null
  if (!g?.maps?.Geocoder) return null
  try {
    return await withTimeout(new Promise<GeocodeHit | null>(resolve => {
      new g.maps.Geocoder().geocode({ address: q, region: 'us' }, (results: any[] | null, status: string) => {
        const r = status === 'OK' ? results?.[0] : null
        const loc = r?.geometry?.location
        resolve(loc && valid(loc.lat(), loc.lng()) ? { lat: loc.lat(), lng: loc.lng(), label: r.formatted_address || q } : null)
      })
    }), 5000)
  } catch { return null }
}

async function viaNominatim(q: string): Promise<GeocodeHit | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=us`,
      { headers: { 'Accept-Language': 'en' } },
    )
    if (!res.ok) return null
    const data = await res.json()
    const hit = data?.[0]
    const lat = parseFloat(hit?.lat), lng = parseFloat(hit?.lon)
    if (valid(lat, lng)) return { lat, lng, label: hit.display_name || q }
  } catch { /* fall through */ }
  return null
}

export async function geocodeTypedLocation(query: string): Promise<GeocodeHit | null> {
  const q = query.trim()
  if (!q) return null
  for (const attempt of [viaMapbox, viaGooglePlaces, viaGoogleGeocoder, viaNominatim]) {
    const hit = await attempt(q)
    if (hit) return hit
  }
  return null
}

// ── Cuisine-only queries ─────────────────────────────────────────────────────
// Geocoders happily resolve "Italian" to Italian Village, Columbus OH and "BBQ"
// to Bbq Lane, Michigan — so a query that is a cuisine/food word must be
// recognised BEFORE geocoding and sent to the map as a restaurant search.
const FOOD_WORDS = [
  'american', 'asian', 'bagels', 'bakery', 'bbq', 'barbecue', 'breakfast', 'brunch', 'burgers', 'burger',
  'cajun', 'caribbean', 'chinese', 'coffee', 'deli', 'desserts', 'dessert', 'ethiopian', 'french', 'greek',
  'halal', 'healthy', 'indian', 'italian', 'japanese', 'korean', 'kosher', 'latin', 'lebanese', 'mediterranean',
  'mexican', 'middle eastern', 'pizza', 'ramen', 'salad', 'salads', 'sandwiches', 'sandwich', 'seafood',
  'soul food', 'southern', 'spanish', 'steak', 'sushi', 'tacos', 'taco', 'thai', 'vegan', 'vegetarian',
  'vietnamese', 'wings', 'catering',
]

export function isCuisineQuery(query: string, extraCuisines: string[] = []): boolean {
  const q = query.trim().toLowerCase().replace(/\s+food$/, '').replace(/\s+/g, ' ')
  if (!q) return false
  return FOOD_WORDS.includes(q) || extraCuisines.some(c => c.trim().toLowerCase() === q)
}
