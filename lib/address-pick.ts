/**
 * GOOGLE ADDRESS SEARCH → A RESTAURANT'S ADDRESS (Peter, 10 Nov 2026).
 *
 * Restaurant portal → Account → Profile and Super Admin's restaurant edit form
 * search addresses with Google Places Autocomplete (US, street addresses only).
 * Picking a result fills line 1 / city / state / zip and carries the result's
 * latitude/longitude to the server, where saveRestaurantAddress() — still the
 * ONE writer (lib/restaurant-address.ts) — stores them instead of geocoding.
 *
 * The pick travels as `addressPick: { lat, lng, address }`, where `address` is
 * the text the form held at the moment of the pick. The server only honours the
 * coordinates while the submitted address still matches that text, so a pick
 * followed by hand edits falls back to today's geocode of what was typed.
 * Address line 2 (suite/unit) is never part of the search and never part of the
 * match: it stays free text.
 *
 * Pure and client-safe (no db import) so both the browser component and the
 * routes use the same parsing and matching.
 */

export interface PickedPlace {
  line1: string
  city: string
  state: string
  zipcode: string
  lat: number
  lng: number
}

export interface AddressPick { lat: number; lng: number; address: string }

type Component = { long_name: string; short_name: string; types: string[] }
type LatLngLike = { lat: number | (() => number); lng: number | (() => number) }
export interface PlaceResultLike {
  address_components?: Component[]
  geometry?: { location?: LatLngLike | null } | null
}

const num = (v: number | (() => number) | undefined): number => (typeof v === 'function' ? v() : Number(v))

/** A Places result → the parts the address form holds. Null when it isn't a street address with a pin. */
export function placeToAddressParts(place: PlaceResultLike | null | undefined): PickedPlace | null {
  const loc = place?.geometry?.location
  if (!place?.address_components || !loc) return null
  const lat = num(loc.lat), lng = num(loc.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const c = (t: string, short = false) => { const x = place.address_components!.find(a => a.types.includes(t)); return x ? (short ? x.short_name : x.long_name) : '' }
  const line1 = [c('street_number'), c('route', true)].filter(Boolean).join(' ').trim()
  if (!line1) return null
  const city = c('locality') || c('sublocality') || c('sublocality_level_1') || c('postal_town') || c('administrative_area_level_3') || c('neighborhood')
  return { line1, city, state: c('administrative_area_level_1', true).toUpperCase(), zipcode: c('postal_code'), lat, lng }
}

/** "Street, City, ST ZIP" — the one-line form the Profile box shows after a pick. */
export function pickedOneLine(p: Pick<PickedPlace, 'line1' | 'city' | 'state' | 'zipcode'>): string {
  const tail = [p.state, p.zipcode].filter(Boolean).join(' ')
  return [p.line1, p.city, tail].map(s => (s || '').trim()).filter(Boolean).join(', ')
}

const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * The coordinates to save, or null to geocode as today. Honoured only when the
 * pick is well-formed, inside lat/lng bounds, and `currentAddress` (what is being
 * saved now) is still the text that was picked.
 */
export function pickedCoords(pick: unknown, currentAddress: string): { lat: number; lng: number } | null {
  if (!pick || typeof pick !== 'object') return null
  const p = pick as Record<string, unknown>
  const lat = typeof p.lat === 'number' ? p.lat : Number.NaN
  const lng = typeof p.lng === 'number' ? p.lng : Number.NaN
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  if (!norm(currentAddress) || norm(p.address) !== norm(currentAddress)) return null
  return { lat, lng }
}
