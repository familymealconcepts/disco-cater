// Native (zero-FM) delivery-address validation for Disco-native restaurants.
// Geocodes the delivery address, measures distance to the restaurant, and (once
// Stage 6 delivery settings are authored) enforces the delivery radius and computes
// the fee. Until then it is permissive with a $0 fee — the authoritative charge is
// computed server-side by lib/pricing/native-order at place time regardless.

import { sql } from '../db'
import { geocodeAddress, haversineMiles, type LatLng } from '../geocode'
import { computeOwnDeliveryFee, computeThirdPartyDeliveryFee, type DeliverySettings } from '../menu-settings'
import type { Fulfillment } from '../pricing/native-order'

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
  method: 'OWN_DELIVERY' | 'THIRD_PARTY'
  fulfillment: Fulfillment
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
  subtotal = 0,
  geocoder: (addr: string) => Promise<LatLng> = geocodeAddress,
): Promise<NativeDeliveryResult> {
  // Restaurant coordinates + the primary menu's delivery settings, from Neon (no FM).
  const rows = (await sql`
    SELECT lat, lng FROM disco_restaurant_cache WHERE restaurant_reference = ${restaurantReference} LIMIT 1
  `.catch(() => [])) as { lat: number | string | null; lng: number | string | null }[]
  const rLat = rows[0]?.lat != null ? Number(rows[0].lat) : null
  const rLng = rows[0]?.lng != null ? Number(rows[0].lng) : null
  const menuRows = (await sql`
    SELECT delivery_settings FROM disco_menus
    WHERE restaurant_reference = ${restaurantReference}::uuid AND visible = true AND archived = false
    ORDER BY position, id LIMIT 1
  `.catch(() => [])) as { delivery_settings: DeliverySettings | null }[]
  const del = menuRows[0]?.delivery_settings || null
  const method: 'OWN_DELIVERY' | 'THIRD_PARTY' = del?.method === 'OWN_DELIVERY' ? 'OWN_DELIVERY' : 'THIRD_PARTY'
  const fulfillment: Fulfillment = method === 'OWN_DELIVERY' ? 'OWN_DELIVERY' : 'THIRD_PARTY_DELIVERY'

  // Customer coordinates: trust client-provided (Mapbox autocomplete) when present,
  // else geocode the typed address.
  let cLat = typeof address.latitude === 'number' ? address.latitude : null
  let cLng = typeof address.longitude === 'number' ? address.longitude : null
  if (cLat == null || cLng == null) {
    const geo = await geocoder(fullAddress(address))
    cLat = geo.lat
    cLng = geo.lng
  }
  const geocoded = cLat != null && cLng != null
  const distanceMiles = rLat != null && rLng != null && cLat != null && cLng != null
    ? Math.round(haversineMiles(rLat, rLng, cLat, cLng) * 100) / 100
    : null

  // OWN_DELIVERY: enforce the radius tiers + compute the fee (restaurant keeps it).
  // THIRD_PARTY: Disco dispatches a courier — serviceable wherever we can geocode;
  // the customer pays a flat 15% of subtotal capped at $85 (Disco keeps it, pays the
  // courier — no live quote).
  let deliveryFee = 0
  let serviceable = true
  if (method === 'OWN_DELIVERY' && del?.own && distanceMiles != null) {
    const r = computeOwnDeliveryFee(del.own, distanceMiles, subtotal)
    serviceable = r.serviceable
    deliveryFee = r.fee
  } else if (method === 'THIRD_PARTY') {
    deliveryFee = computeThirdPartyDeliveryFee(subtotal)
  }

  return {
    valid: geocoded && serviceable,
    deliveryFee,
    method,
    fulfillment,
    distanceMiles,
    latitude: cLat,
    longitude: cLng,
    message: !geocoded
      ? 'We could not locate that address — please check it and try again.'
      : !serviceable
        ? 'That address is outside this restaurant’s delivery area.'
        : undefined,
  }
}
