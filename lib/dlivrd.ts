// dlivrd (Expedite) delivery integration — best-effort, never throws.
//
// Used when an order's pickup location changes (e.g. a SUPER_ADMIN transfers an
// order to another restaurant). We notify dlivrd so the courier picks up from
// the new restaurant. dlivrd identifies a delivery by external_delivery_id,
// which for us is the order's fm_order_reference.
//
// Auth (per dlivrd's Expedite webhook scheme):
//   X-Expedite-Token      = EXPEDITE_TOKEN
//   X-Expedite-Event      = the event name (e.g. "delivery_modified")
//   X-Expedite-Signature  = "<timestamp>.<HMAC-SHA256(EXPEDITE_SECRET, "<timestamp>.<body>")>"
//
// REQUIRED ENV (set in Vercel): EXPEDITE_TOKEN, EXPEDITE_SECRET. When either is
// missing we skip silently (logged) — the integration is optional.

import { createHmac } from 'crypto'

const DLIVRD_URL = 'https://api.dlivrd.app/batch/deliveries'

export interface DlivrdPickupUpdate {
  /** The dlivrd delivery id — our fm_order_reference. */
  externalDeliveryId: string
  /** New pickup (restaurant) location, from disco_restaurant_cache. */
  address: string | null
  lat: number | null
  lng: number | null
  businessName: string | null
}

export type DlivrdResult =
  | { status: 'skipped'; reason: string }
  | { status: 'sent'; httpStatus: number }
  | { status: 'error'; error: string }

// Sends a `delivery_modified` event updating the pickup task to the new
// restaurant address. Returns a result object; never throws.
export async function sendDlivrdDeliveryModified(update: DlivrdPickupUpdate): Promise<DlivrdResult> {
  const token = process.env.EXPEDITE_TOKEN
  const secret = process.env.EXPEDITE_SECRET

  if (!token || !secret) {
    console.log('[dlivrd] EXPEDITE not configured — skipping dlivrd update')
    return { status: 'skipped', reason: 'EXPEDITE not configured' }
  }
  if (!update.externalDeliveryId) {
    console.log('[dlivrd] no external_delivery_id (fm_order_reference) — skipping dlivrd update')
    return { status: 'skipped', reason: 'no external_delivery_id' }
  }

  // delivery_modified payload — update the pickup task location only. Other
  // order details (dropoff, timing) are unchanged by a transfer.
  const payload = {
    event: 'delivery_modified',
    external_delivery_id: update.externalDeliveryId,
    pickup: {
      business_name: update.businessName ?? undefined,
      address: update.address ?? undefined,
      latitude: update.lat ?? undefined,
      longitude: update.lng ?? undefined,
    },
  }

  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = `${timestamp}.${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`

  try {
    const res = await fetch(DLIVRD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Expedite-Token': token,
        'X-Expedite-Event': 'delivery_modified',
        'X-Expedite-Signature': signature,
      },
      body,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      console.error(`[dlivrd] delivery_modified failed: ${res.status} ${raw.slice(0, 300)}`)
      return { status: 'error', error: `dlivrd ${res.status}` }
    }
    console.log(`[dlivrd] delivery_modified sent for ${update.externalDeliveryId} (${res.status})`)
    return { status: 'sent', httpStatus: res.status }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[dlivrd] delivery_modified error:', error)
    return { status: 'error', error }
  }
}
