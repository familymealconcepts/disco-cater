// Expedite (formerly dlivrd) third-party delivery integration.
//
// Every function is best-effort: it never throws — it logs and returns a result
// object. Delivery is an optional add-on, so a failure must never break the
// order/payment/edit/void flow that calls it.
//
// Auth (per Expedite's webhook scheme) — every POST sends:
//   X-Expedite-Token      = EXPEDITE_TOKEN
//   X-Expedite-Event      = the event name (e.g. "delivery_created")
//   X-Expedite-Signature  = "<timestamp>.<HMAC-SHA256(EXPEDITE_SECRET, "<timestamp>.<body>")>"
//
// REQUIRED ENV (Vercel): EXPEDITE_TOKEN, EXPEDITE_SECRET. When either is missing
// we skip silently (logged) — the integration is optional.

import { createHmac } from 'crypto'
import { sql } from './db'
import { sanitizePhone } from './utils/phone'

export const BASE_URL = 'https://api.dlivrd.app/batch/deliveries'

// Restaurants have no per-location timezone stored yet; default to Eastern, which
// matches the rest of the portal (RESTAURANT_TZ_DEFAULT).
const DEFAULT_TZ = 'America/New_York'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExpediteTask {
  type: 'pickup' | 'dropoff'
  event_at: string // ISO8601 UTC
  timezone_identifier: string // IANA e.g. 'America/New_York'
  location_name: string
  recipient_name: string
  phone: string // with country code e.g. +17321234567
  instructions?: string
  street1: string
  street2?: string
  city: string
  state: string
  zip: string
  latitude: number
  longitude: number
  canceled: boolean
  external_id: string // 'p0' for pickup, 'd0' for dropoff
  items_count: number
  items: Array<{ name: string; count: number; descriptions?: string; value: number }> // value in cents
}

export interface ExpediteOrder {
  external_delivery_id: string
  order: {
    subtotal: number // dollars
    tip_cents: number // cents
    total_items_count: number
    client_name: string
    order_fulfillment_method: 'catering'
  }
  tasks: [ExpediteTask, ExpediteTask] // [pickup, dropoff]
}

// Neon row shapes the payload builder reads from.
export interface DiscoOrder {
  reference: string
  fm_order_reference: string | null
  order_date: string // 'YYYY-MM-DD'
  order_time: string // 'HH:MM[:SS]'
  customer_first_name: string | null
  customer_last_name: string | null
  customer_phone: string | null
  delivery_address_line1: string | null
  delivery_address_line2: string | null
  delivery_city: string | null
  delivery_state: string | null
  delivery_zip: string | null
  delivery_lat: string | number | null
  delivery_lng: string | number | null
  subtotal: string | number | null
  tips: string | number | null
}

export interface RestaurantCacheRow {
  name: string | null
  address: string | null
  lat: string | number | null
  lng: string | number | null
  phone: string | null
}

export interface OrderItem {
  name: string
  quantity: string | number
  price_per_unit: string | number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

// Auth headers for a given JSON body. Caller adds X-Expedite-Event.
export function buildExpediteHeaders(body: object): Record<string, string> {
  const token = process.env.EXPEDITE_TOKEN || ''
  const secret = process.env.EXPEDITE_SECRET || ''
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signed = `${timestamp}.${JSON.stringify(body)}`
  const signature = `${timestamp}.${createHmac('sha256', secret).update(signed).digest('hex')}`
  return {
    'Content-Type': 'application/json',
    'X-Expedite-Token': token,
    'X-Expedite-Signature': signature,
  }
}

// Phone with US country code, or '' when there are no digits.
function phoneWithCountryCode(raw: string | null | undefined): string {
  const digits = sanitizePhone(raw)
  if (!digits) return ''
  // Already 11 digits starting with 1 → just prefix '+'. Otherwise assume US.
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+1${digits}`
}

// Best-effort parse of the cache's single-line address into street/city/state/zip.
// "123 Main St, Nashville, TN 37201" → { street1, city, state, zip }.
function parseAddress(address: string | null): { street1: string; city: string; state: string; zip: string } {
  const out = { street1: '', city: '', state: '', zip: '' }
  if (!address) return out
  const parts = address.split(',').map(p => p.trim()).filter(Boolean)
  out.street1 = parts[0] || address
  if (parts.length >= 2) out.city = parts[1]
  const stateZip = parts[2] || ''
  const m = /([A-Za-z]{2})\s*(\d{5})?/.exec(stateZip)
  if (m) { out.state = m[1].toUpperCase(); out.zip = m[2] || '' }
  return out
}

// Convert a wall-clock date+time in `tz` to a UTC ISO8601 string. DST-correct via
// the Intl offset trick. Never throws — falls back to a naive UTC interpretation.
function wallTimeToUtcIso(dateStr: string, timeStr: string, tz: string): string {
  try {
    const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''))
    const tm = /^(\d{1,2}):(\d{2})/.exec(String(timeStr || ''))
    if (!dm) return new Date().toISOString()
    const y = +dm[1], mo = +dm[2], d = +dm[3]
    const h = tm ? +tm[1] : 0, mi = tm ? +tm[2] : 0
    // Instant if the wall time were UTC.
    const asUtc = Date.UTC(y, mo - 1, d, h, mi)
    // What that instant reads as in tz → derive the offset, then correct.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(asUtc))
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value || '0')
    let hh = get('hour'); if (hh === 24) hh = 0
    const tzLocal = Date.UTC(get('year'), get('month') - 1, get('day'), hh, get('minute'), get('second'))
    const offset = tzLocal - asUtc
    return new Date(asUtc - offset).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

// ── Payload builder ──────────────────────────────────────────────────────────

export function buildDeliveryPayload(order: DiscoOrder, restaurantCache: RestaurantCacheRow, items: OrderItem[]): ExpediteOrder {
  const tz = DEFAULT_TZ
  const pickupIso = wallTimeToUtcIso(order.order_date, order.order_time, tz)
  const dropoffIso = new Date(new Date(pickupIso).getTime() + 30 * 60 * 1000).toISOString()

  const taskItems = (items || []).map(it => ({
    name: it.name || 'Item',
    count: Math.max(1, Math.trunc(num(it.quantity) || 1)),
    value: Math.round(num(it.price_per_unit) * 100), // cents
  }))
  const itemsCount = taskItems.reduce((a, it) => a + it.count, 0)

  const customerName = `${order.customer_first_name || ''} ${order.customer_last_name || ''}`.trim() || 'Customer'
  const restaurantName = restaurantCache.name || 'Restaurant'
  const pickupAddr = parseAddress(restaurantCache.address)

  // Pickup phone: the FM restaurant address phone; '0000000000' fallback.
  const pickupPhone = phoneWithCountryCode(restaurantCache.phone) || '0000000000'
  const dropoffPhone = phoneWithCountryCode(order.customer_phone) || '0000000000'

  const pickup: ExpediteTask = {
    type: 'pickup',
    event_at: pickupIso,
    timezone_identifier: tz,
    location_name: restaurantName,
    recipient_name: restaurantName,
    phone: pickupPhone,
    street1: pickupAddr.street1,
    city: pickupAddr.city,
    state: pickupAddr.state,
    zip: pickupAddr.zip,
    latitude: num(restaurantCache.lat),
    longitude: num(restaurantCache.lng),
    canceled: false,
    external_id: 'p0',
    items_count: itemsCount,
    items: taskItems,
  }

  const dropoff: ExpediteTask = {
    type: 'dropoff',
    event_at: dropoffIso,
    timezone_identifier: tz,
    location_name: customerName,
    recipient_name: customerName,
    phone: dropoffPhone,
    street1: order.delivery_address_line1 || '',
    street2: order.delivery_address_line2 || undefined,
    city: order.delivery_city || '',
    state: (order.delivery_state || '').toUpperCase(),
    zip: order.delivery_zip || '',
    // Geocoded at placement (/api/order/place); 0 only when geocoding was
    // unavailable, in which case Expedite falls back to geocoding the address.
    latitude: num(order.delivery_lat),
    longitude: num(order.delivery_lng),
    canceled: false,
    external_id: 'd0',
    items_count: itemsCount,
    items: taskItems,
  }

  return {
    external_delivery_id: order.fm_order_reference || order.reference,
    order: {
      subtotal: num(order.subtotal),
      tip_cents: Math.round(num(order.tips) * 100),
      total_items_count: itemsCount,
      client_name: customerName,
      order_fulfillment_method: 'catering',
    },
    tasks: [pickup, dropoff],
  }
}

// ── HTTP calls (best-effort) ─────────────────────────────────────────────────

function configured(): boolean {
  return !!(process.env.EXPEDITE_TOKEN && process.env.EXPEDITE_SECRET)
}

async function post(event: string, payload: object): Promise<{ ok: boolean; status: number; body: string }> {
  const headers = { ...buildExpediteHeaders(payload), 'X-Expedite-Event': event }
  const res = await fetch(BASE_URL, { method: 'POST', headers, body: JSON.stringify(payload) })
  const body = await res.text().catch(() => '')
  return { ok: res.ok, status: res.status, body }
}

export async function createDelivery(payload: ExpediteOrder): Promise<{ success: boolean; delivery_fee?: number; error?: string }> {
  if (!configured()) { console.log('[expedite] not configured — skipping createDelivery'); return { success: false, error: 'not configured' } }
  try {
    const { ok, status, body } = await post('delivery_created', payload)
    if (!ok) {
      console.error(`[expedite] createDelivery failed ${status}: ${body.slice(0, 300)}`)
      return { success: false, error: `expedite ${status}` }
    }
    let delivery_fee: number | undefined
    try {
      const data = body ? JSON.parse(body) : {}
      const fee = data?.delivery_fee ?? data?.deliveryFee ?? data?.fee
      if (fee != null) delivery_fee = num(fee)
    } catch { /* non-JSON ok */ }
    console.log(`[expedite] createDelivery ok for ${payload.external_delivery_id} (fee=${delivery_fee ?? 'n/a'})`)
    return { success: true, delivery_fee }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[expedite] createDelivery error:', error)
    return { success: false, error }
  }
}

export async function modifyDelivery(payload: ExpediteOrder): Promise<{ success: boolean; error?: string }> {
  if (!configured()) { console.log('[expedite] not configured — skipping modifyDelivery'); return { success: false, error: 'not configured' } }
  try {
    const { ok, status, body } = await post('delivery_modified', payload)
    if (!ok) {
      console.error(`[expedite] modifyDelivery failed ${status}: ${body.slice(0, 300)}`)
      return { success: false, error: `expedite ${status}` }
    }
    console.log(`[expedite] modifyDelivery ok for ${payload.external_delivery_id}`)
    return { success: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[expedite] modifyDelivery error:', error)
    return { success: false, error }
  }
}

export async function cancelDelivery(external_delivery_id: string): Promise<{ success: boolean; error?: string }> {
  if (!configured()) { console.log('[expedite] not configured — skipping cancelDelivery'); return { success: false, error: 'not configured' } }
  if (!external_delivery_id) return { success: false, error: 'no external_delivery_id' }
  const payload = {
    external_delivery_id,
    tasks: [
      { type: 'pickup', canceled: true, external_id: 'p0' },
      { type: 'dropoff', canceled: true, external_id: 'd0' },
    ],
  }
  try {
    const { ok, status, body } = await post('delivery_cancelled', payload)
    if (!ok) {
      console.error(`[expedite] cancelDelivery failed ${status}: ${body.slice(0, 300)}`)
      return { success: false, error: `expedite ${status}` }
    }
    console.log(`[expedite] cancelDelivery ok for ${external_delivery_id}`)
    return { success: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[expedite] cancelDelivery error:', error)
    return { success: false, error }
  }
}

// ── Convenience: load the three Neon inputs and build the payload ────────────
// Looks up an order by its Disco reference or FM reference, plus its restaurant
// cache row and items. Returns null when the order/restaurant isn't found.
export async function buildPayloadFromNeon(orderRef: string): Promise<ExpediteOrder | null> {
  try {
    const orderRows = (await sql`
      SELECT reference, fm_order_reference, restaurant_reference,
             to_char(order_date,'YYYY-MM-DD') AS order_date, order_time::text AS order_time,
             customer_first_name, customer_last_name, customer_phone,
             delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
             delivery_lat, delivery_lng, subtotal, tips, id
      FROM disco_orders
      WHERE reference = ${orderRef}::uuid OR fm_order_reference = ${orderRef}::uuid
      LIMIT 1
    `.catch(() => [])) as Array<DiscoOrder & { id: number; restaurant_reference: string }>
    const order = orderRows[0]
    if (!order) return null

    const cacheRows = (await sql`
      SELECT name, address, lat, lng, phone FROM disco_restaurant_cache
      WHERE restaurant_reference = ${order.restaurant_reference}
      LIMIT 1
    `.catch(() => [])) as RestaurantCacheRow[]
    const cache = cacheRows[0] || { name: null, address: null, lat: null, lng: null, phone: null }

    const itemRows = (await sql`
      SELECT name, quantity, price_per_unit FROM disco_order_items
      WHERE order_id = ${order.id} ORDER BY id
    `.catch(() => [])) as OrderItem[]

    return buildDeliveryPayload(order, cache, itemRows)
  } catch (err) {
    console.error('[expedite] buildPayloadFromNeon failed:', err instanceof Error ? err.message : err)
    return null
  }
}
