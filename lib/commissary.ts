// Commissary pickup address — COURIER ONLY.
//
// Some restaurants prepare their THIRD-PARTY delivery orders somewhere other
// than the storefront a customer sees. Gracious Bakery & Cafe prepares both
// locations' third-party orders at a shared commissary on Earhart Blvd, so a
// dlivrd courier sent to either storefront would find no food.
//
// ── THE SAFETY PROPERTY ────────────────────────────────────────────────────
// This address has exactly ONE reader: the pickup task in
// lib/expedite.ts's buildDeliveryPayload, which only ever runs for an order
// dispatchExpediteForOrder has already claimed as
// `order_type = 'DELIVERY' AND delivery_type = 'THIRD_PARTY_DELIVERY'`, and
// which independently re-checks that the order's own menu says THIRD_PARTY.
//
// It is NEVER written into disco_orders.restaurant_address or
// disco_restaurant_cache.address. Those two are what the order popout, the
// confirmation and reminder emails, and the order PDF read — and none of them
// branches on order type. A commissary leaking into either would tell a PICKUP
// customer to collect from an address that does not serve customers. Keeping it
// in its own columns is what makes that impossible rather than merely unlikely.
//
// ── COORDINATES ARE REQUIRED ───────────────────────────────────────────────
// The Expedite pickup task sends latitude/longitude, not just a string, so a
// commissary without coordinates is not dispatchable — readCommissaryPickup
// returns null in that case and dispatch falls back to the restaurant's own
// address, which is the safe direction (it is today's behaviour). Geocoding runs
// ONCE, here, at save — never on the dispatch path.
import { sql } from './db'
import { geocodeAddress } from './geocode'

export interface CommissaryPickup {
  name: string
  street1: string
  street2?: string
  city: string
  state: string
  zip: string
  lat: number
  lng: number
}

export interface SetCommissaryInput {
  name: string
  addressLine1: string
  addressLine2?: string | null
  city: string
  state: string
  zipcode: string
  /** Skip geocoding and use these. Only for a coordinate verified by hand. */
  lat?: number
  lng?: number
}

export interface SetCommissaryResult {
  ok: boolean
  restaurantReference: string
  lat: number | null
  lng: number | null
  geocodedFrom: string
  reason?: string
}

/**
 * Set (or replace) a restaurant's commissary pickup address, geocoding it once.
 *
 * Refuses to write when geocoding produces no coordinates: a commissary row
 * without them is not dispatchable, and a half-written row is worse than none
 * because it looks configured. Never partially applies.
 */
export async function setCommissaryAddress(
  restaurantReference: string,
  input: SetCommissaryInput,
): Promise<SetCommissaryResult> {
  const full = [input.addressLine1, input.city, `${input.state} ${input.zipcode}`.trim()]
    .map(s => String(s || '').trim()).filter(Boolean).join(', ')

  let lat = input.lat ?? null
  let lng = input.lng ?? null
  if (lat == null || lng == null) {
    const g = await geocodeAddress(full)
    lat = g.lat
    lng = g.lng
  }
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      ok: false, restaurantReference, lat: null, lng: null, geocodedFrom: full,
      reason: `Could not geocode "${full}" — refusing to write a commissary with no coordinates, since the Expedite pickup task needs them.`,
    }
  }

  await sql`
    INSERT INTO disco_restaurant_overrides (
      restaurant_reference, commissary_name, commissary_address_line1, commissary_address_line2,
      commissary_city, commissary_state, commissary_zipcode, commissary_lat, commissary_lng, updated_at
    ) VALUES (
      ${restaurantReference}, ${input.name}, ${input.addressLine1}, ${input.addressLine2 || null},
      ${input.city}, ${String(input.state || '').toUpperCase()}, ${input.zipcode}, ${lat}, ${lng}, NOW()
    )
    ON CONFLICT (restaurant_reference) DO UPDATE SET
      commissary_name = EXCLUDED.commissary_name,
      commissary_address_line1 = EXCLUDED.commissary_address_line1,
      commissary_address_line2 = EXCLUDED.commissary_address_line2,
      commissary_city = EXCLUDED.commissary_city,
      commissary_state = EXCLUDED.commissary_state,
      commissary_zipcode = EXCLUDED.commissary_zipcode,
      commissary_lat = EXCLUDED.commissary_lat,
      commissary_lng = EXCLUDED.commissary_lng,
      updated_at = NOW()
  `
  return { ok: true, restaurantReference, lat, lng, geocodedFrom: full }
}

/** Remove a commissary, restoring restaurant-address pickup. */
export async function clearCommissaryAddress(restaurantReference: string): Promise<void> {
  await sql`
    UPDATE disco_restaurant_overrides SET
      commissary_name = NULL, commissary_address_line1 = NULL, commissary_address_line2 = NULL,
      commissary_city = NULL, commissary_state = NULL, commissary_zipcode = NULL,
      commissary_lat = NULL, commissary_lng = NULL, updated_at = NOW()
    WHERE restaurant_reference = ${restaurantReference}
  `
}

/**
 * The commissary pickup for this restaurant, or NULL when there isn't a complete,
 * dispatchable one. Callers MUST fall back to the restaurant's own address on
 * null — that is today's behaviour and the safe direction.
 *
 * Requires a street line AND both coordinates. A row missing either is treated
 * as absent rather than partially honoured: sending a courier to a commissary
 * street with the restaurant's coordinates (or the reverse) would be worse than
 * either address on its own.
 *
 * Never throws — a lookup failure must not block a dispatch.
 */
export async function readCommissaryPickup(restaurantReference: string): Promise<CommissaryPickup | null> {
  const rows = (await sql`
    SELECT commissary_name AS name, commissary_address_line1 AS street1, commissary_address_line2 AS street2,
           commissary_city AS city, commissary_state AS state, commissary_zipcode AS zip,
           commissary_lat AS lat, commissary_lng AS lng
    FROM disco_restaurant_overrides WHERE restaurant_reference = ${restaurantReference} LIMIT 1
  `.catch(() => [])) as Array<Record<string, unknown>>
  const r = rows[0]
  if (!r) return null
  const street1 = String(r.street1 ?? '').trim()
  const lat = r.lat != null ? Number(r.lat) : null
  const lng = r.lng != null ? Number(r.lng) : null
  if (!street1 || lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return {
    name: String(r.name ?? '').trim() || street1,
    street1,
    street2: String(r.street2 ?? '').trim() || undefined,
    city: String(r.city ?? '').trim(),
    state: String(r.state ?? '').trim().toUpperCase(),
    zip: String(r.zip ?? '').trim(),
    lat, lng,
  }
}
