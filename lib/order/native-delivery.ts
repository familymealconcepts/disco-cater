// Native (zero-FM) delivery-address validation for Disco-native restaurants.
// Geocodes the delivery address, measures distance to the restaurant, and (once
// Stage 6 delivery settings are authored) enforces the delivery radius and computes
// the fee. Until then it is permissive with a $0 fee — the authoritative charge is
// computed server-side by lib/pricing/native-order at place time regardless.

import { sql } from '../db'
import { geocodeAddress, haversineMiles, type LatLng } from '../geocode'

export interface NativeDeliveryAddress {
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  zip?: string
  zipcode?: string
  latitude?: number
  longitude?: number
}

export interface NativeDeliveryResult {
  valid: boolean
  deliveryFee: number
  distanceMiles: number | null
  latitude: number | null
  longitude: number | null
  message?: string
}

function fullAddress(a: NativeDeliveryAddress): string {
  return [a.addressLine1, a.addressLine2, a.city, a.state, a.zip || a.zipcode].filter(Boolean).join(', ')
}

// Validate a delivery address for a Disco-native restaurant. `geocoder` is
// injectable for testing; production uses the Google geocoder.
export async function validateNativeDelivery(
  restaurantReference: string,
  address: NativeDeliveryAddress,
  geocoder: (addr: string) => Promise<LatLng> = geocodeAddress,
): Promise<NativeDeliveryResult> {
  // Restaurant coordinates from Neon (no FM).
  const rows = (await sql`
    SELECT lat, lng FROM disco_restaurant_cache WHERE restaurant_reference = ${restaurantReference} LIMIT 1
  `.catch(() => [])) as { lat: number | string | null; lng: number | string | null }[]
  const rLat = rows[0]?.lat != null ? Number(rows[0].lat) : null
  const rLng = rows[0]?.lng != null ? Number(rows[0].lng) : null

  // Customer coordinates: trust client-provided (Mapbox autocomplete) when present,
  // else geocode the typed address.
  let cLat = typeof address.latitude === 'number' ? address.latitude : null
  let cLng = typeof address.longitude === 'number' ? address.longitude : null
  if (cLat == null || cLng == null) {
    const geo = await geocoder(fullAddress(address))
    cLat = geo.lat
    cLng = geo.lng
  }

  const distanceMiles = rLat != null && rLng != null && cLat != null && cLng != null
    ? Math.round(haversineMiles(rLat, rLng, cLat, cLng) * 100) / 100
    : null

  // Delivery radius + fee come from native menu delivery settings (Stage 6). Until
  // authored, delivery is permissive with a $0 fee.
  // TODO(Stage 6): read own-delivery radius + fee ($/%) from Neon and enforce here.
  const radiusMiles: number | null = null
  const deliveryFee = 0

  const geocoded = cLat != null && cLng != null
  const withinRadius = radiusMiles == null || (distanceMiles != null && distanceMiles <= radiusMiles)

  return {
    valid: geocoded && withinRadius,
    deliveryFee,
    distanceMiles,
    latitude: cLat,
    longitude: cLng,
    message: !geocoded
      ? 'We could not locate that address — please check it and try again.'
      : !withinRadius
        ? 'That address is outside this restaurant’s delivery area.'
        : undefined,
  }
}
