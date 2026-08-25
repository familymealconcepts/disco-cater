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
import { alertOps } from './ops-alert'
import { fulfillmentDateTime } from './order/fulfillment-time'

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
  order_time: string // 'HH:MM[:SS]' — the customer's requested DROP-OFF time
  // Needed so the pickup time comes from the shared ready-by authority rather
  // than being assumed. dispatchExpediteForOrder only ever claims
  // THIRD_PARTY_DELIVERY rows, but passing the real value keeps this honest if
  // buildDeliveryPayload is ever reached another way.
  delivery_type: string | null
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
  // Structured address parts + IANA timezone (populated from FM on cache refresh).
  // Preferred over parsing the single-line `address`; parse is the fallback only.
  address_line1?: string | null
  address_line2?: string | null
  city?: string | null
  state?: string | null
  zipcode?: string | null
  timezone?: string | null
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
  // Use the restaurant's actual configured IANA timezone; fall back to Eastern only
  // when it isn't set (legacy rows not yet refreshed).
  const tz = (restaurantCache.timezone && String(restaurantCache.timezone).trim()) || DEFAULT_TZ
  // order_time is the customer's requested DROP-OFF time. It used to be fed in
  // as the PICKUP time and drop-off derived as pickup + 30, which booked the
  // courier 30 minutes late at both ends (order 900000093: collect 12:45,
  // deliver 1:15, for a 12:45 request). Drop-off is now the requested time
  // itself, and pickup is the shared ready-by value — the same number the
  // restaurant sees in its "Ready By" block, so the kitchen deadline and the
  // courier's collection time cannot drift apart again.
  //
  // wallTimeToUtcIso is untouched: it derives the real UTC offset from the
  // restaurant's IANA zone and the payload still carries timezone_identifier.
  // The defect was offset semantics, not timezone handling.
  const readyBy = fulfillmentDateTime(order.delivery_type, order.order_date, order.order_time)
  const pickupIso = wallTimeToUtcIso(readyBy?.date ?? order.order_date, readyBy?.time ?? order.order_time, tz)
  const dropoffIso = wallTimeToUtcIso(order.order_date, order.order_time, tz)

  const taskItems = (items || []).map(it => ({
    name: it.name || 'Item',
    count: Math.max(1, Math.trunc(num(it.quantity) || 1)),
    value: Math.round(num(it.price_per_unit) * 100), // cents
  }))
  const itemsCount = taskItems.reduce((a, it) => a + it.count, 0)

  const customerName = `${order.customer_first_name || ''} ${order.customer_last_name || ''}`.trim() || 'Customer'
  const restaurantName = restaurantCache.name || 'Restaurant'
  // Prefer the STRUCTURED address parts; only fall back to parsing the single-line
  // `address` when the structured street line is absent (never rely on the format).
  const structuredStreet = restaurantCache.address_line1 && String(restaurantCache.address_line1).trim()
  const pickupAddr = structuredStreet
    ? { street1: String(restaurantCache.address_line1), city: String(restaurantCache.city || ''), state: String(restaurantCache.state || '').toUpperCase(), zip: String(restaurantCache.zipcode || '') }
    : parseAddress(restaurantCache.address)
  const pickupStreet2 = structuredStreet && restaurantCache.address_line2 ? String(restaurantCache.address_line2) : undefined

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
    street2: pickupStreet2,
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

// Every field a caller might want out of a dispatch attempt, INCLUDING the raw
// body. The old signature returned only { success, delivery_fee }, which is why
// order 900000093 has a real Expedite booking (D6EP4-CEJA3) and NULL status and
// fee on our side — the response was parsed for one number and discarded.
export interface ExpediteCreateResult {
  success: boolean
  error?: string
  httpStatus?: number
  /** Verbatim response body — stored, because we do not yet know its shape. */
  body?: string
  /** Parsed body when it is JSON at all. */
  json?: Record<string, unknown>
  /** Expedite's own delivery id if the response carries one under any known key. */
  providerDeliveryId?: string
  /** A courier status if the response carries one. */
  status?: string
  delivery_fee?: number
}

// Keys checked for Expedite's own delivery id and status. A batch endpoint may
// nest per-item results, so the top level AND the first element of a plausible
// array wrapper are both probed. Deliberately broad: the cost of an extra key is
// nothing, and the cost of missing the one they actually use is another release
// of NULL columns.
function pick(o: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!o) return undefined
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return undefined
}
const ID_KEYS = ['delivery_id', 'deliveryId', 'id', 'reference', 'order_id', 'orderId', 'order_number', 'orderNumber', 'tracking_id', 'external_id']
const STATUS_KEYS = ['status', 'delivery_status', 'deliveryStatus', 'state']

export async function createDelivery(payload: ExpediteOrder): Promise<ExpediteCreateResult> {
  if (!configured()) { console.log('[expedite] not configured — skipping createDelivery'); return { success: false, error: 'not configured' } }
  try {
    const { ok, status, body } = await post('delivery_created', payload)
    let json: Record<string, unknown> | undefined
    try { json = body ? JSON.parse(body) as Record<string, unknown> : undefined } catch { /* non-JSON is fine and is itself worth recording */ }

    if (!ok) {
      console.error(`[expedite] createDelivery failed ${status}: ${body.slice(0, 300)}`)
      return { success: false, error: `expedite ${status}`, httpStatus: status, body, json }
    }

    // A batch endpoint may wrap per-item results; probe the first element of any
    // array-ish container as well as the top level.
    const containers: (Record<string, unknown> | undefined)[] = [json]
    for (const key of ['deliveries', 'data', 'results', 'items', 'orders']) {
      const v = json?.[key]
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') containers.push(v[0] as Record<string, unknown>)
      else if (v && typeof v === 'object') containers.push(v as Record<string, unknown>)
    }
    let providerDeliveryId: string | undefined
    let courierStatus: string | undefined
    let delivery_fee: number | undefined
    for (const c of containers) {
      providerDeliveryId ??= pick(c, ID_KEYS)
      courierStatus ??= pick(c, STATUS_KEYS)
      if (delivery_fee == null) {
        const fee = c?.delivery_fee ?? c?.deliveryFee ?? c?.fee
        if (fee != null) delivery_fee = num(fee)
      }
    }
    // Never mistake OUR OWN reference echoed back for Expedite's id.
    if (providerDeliveryId && providerDeliveryId === payload.external_delivery_id) providerDeliveryId = undefined

    console.log(`[expedite] createDelivery ok for ${payload.external_delivery_id} (status=${courierStatus ?? 'n/a'} providerId=${providerDeliveryId ?? 'n/a'} fee=${delivery_fee ?? 'n/a'}) body=${body.slice(0, 400)}`)
    return { success: true, httpStatus: status, body, json, providerDeliveryId, status: courierStatus, delivery_fee }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[expedite] createDelivery error:', error)
    return { success: false, error }
  }
}

// Persist one dispatch attempt. Best-effort: a bookkeeping failure must never
// undo a courier that has actually been booked.
async function recordExpediteAttempt(row: {
  orderReference: string; orderId: number; event: string; externalDeliveryId: string
  result: ExpediteCreateResult; requestPayload: ExpediteOrder
}): Promise<void> {
  try {
    await sql`
      INSERT INTO disco_expedite_deliveries
        (order_reference, order_id, event, external_delivery_id, provider_delivery_id,
         http_status, ok, request_payload, response_body, response_json, parsed_status, parsed_fee)
      VALUES (${row.orderReference}::uuid, ${row.orderId}, ${row.event}, ${row.externalDeliveryId},
              ${row.result.providerDeliveryId ?? null}, ${row.result.httpStatus ?? null}, ${row.result.success},
              ${JSON.stringify(row.requestPayload)}::jsonb, ${row.result.body ?? null},
              ${row.result.json ? JSON.stringify(row.result.json) : null}::jsonb,
              ${row.result.status ?? null}, ${row.result.delivery_fee ?? null})
    `
  } catch (e) {
    console.error('[expedite] could not record dispatch attempt:', e instanceof Error ? e.message : e)
  }
}

// Native third-party-delivery courier dispatch is OFF by default — dispatching a
// courier spends real money. Enable with EXPEDITE_NATIVE_DISPATCH_ENABLED=true
// once the fee economics are signed off. (createDelivery is also gated on the
// Expedite creds via configured(), so both must be present to spend.)
export function nativeDispatchEnabled(): boolean {
  const v = (process.env.EXPEDITE_NATIVE_DISPATCH_ENABLED || '').toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

// Dispatch a courier for a completed Disco-native order. Gated strictly on
// THIRD_PARTY_DELIVERY (never OWN_DELIVERY or PICKUP), and idempotent against
// Stripe-webhook retries via an atomic claim on expedite_delivery_id: exactly one
// caller flips NULL → 'PENDING', dispatches, then writes the real id (or resets to
// NULL on failure so a retry can try again). Best-effort — never throws.
//
// menu_reference cross-check: delivery_type is set once at placement from
// whichever menu the cart actually came from (see priceNativeCart in
// native-checkout.ts) — by the time this runs it SHOULD already agree with
// that menu's real delivery_settings.method. This re-checks it directly
// anyway, since delivery_type is exactly the field that was wrong in both real
// incidents (Winkin' Rooster, DeCheco's - Munroe Falls) before menu_reference
// existed to check against. When menu_reference is NULL (an order placed
// before this shipped), there's nothing to cross-check — trust delivery_type
// alone, same as before.
export async function dispatchExpediteForOrder(orderId: number): Promise<void> {
  try {
    if (!configured()) return // no Expedite creds → no-op
    const claim = (await sql`
      UPDATE disco_orders SET expedite_delivery_id = 'PENDING', updated_at = NOW()
      WHERE id = ${orderId}
        AND expedite_delivery_id IS NULL
        AND order_type = 'DELIVERY'
        AND delivery_type = 'THIRD_PARTY_DELIVERY'
      RETURNING reference, restaurant_reference, menu_reference
    `.catch(() => [])) as { reference: string; restaurant_reference: string; menu_reference: string | null }[]
    if (!claim.length) return // not eligible (pickup/own-delivery) or already dispatched
    const { reference, restaurant_reference: restaurantReference, menu_reference: menuReference } = claim[0]

    if (menuReference) {
      const menuRows = (await sql`
        SELECT delivery_settings FROM disco_menus
        WHERE restaurant_reference = ${restaurantReference}::uuid AND reference = ${menuReference}::uuid
        LIMIT 1
      `.catch(() => [])) as { delivery_settings: { method?: string } | null }[]
      const menuMethod = menuRows[0]?.delivery_settings?.method
      if (menuMethod && menuMethod !== 'THIRD_PARTY') {
        // delivery_type said THIRD_PARTY_DELIVERY but the order's own menu says
        // otherwise — refuse to dispatch and surface it loudly, this is exactly
        // the disagreement that caused both real incidents.
        await sql`UPDATE disco_orders SET expedite_delivery_id = NULL WHERE id = ${orderId} AND expedite_delivery_id = 'PENDING'`.catch(() => {})
        await alertOps('expedite: refused to dispatch — order.delivery_type says THIRD_PARTY but its own menu says otherwise', {
          orderId, reference, menuReference, menuMethod,
        })
        return
      }
    }

    const payload = await buildPayloadFromNeon(reference)
    if (!payload) {
      await sql`UPDATE disco_orders SET expedite_delivery_id = NULL WHERE id = ${orderId} AND expedite_delivery_id = 'PENDING'`.catch(() => {})
      await alertOps('expedite: could not build native delivery payload — courier not dispatched', { orderId, reference })
      return
    }
    const result = await createDelivery(payload)
    // Recorded for BOTH outcomes, before the branch — a failed attempt is the one
    // most worth being able to read afterwards.
    await recordExpediteAttempt({ orderReference: reference, orderId, event: 'delivery_created',
      externalDeliveryId: payload.external_delivery_id, result, requestPayload: payload })
    if (result.success) {
      await sql`
        UPDATE disco_orders
        SET expedite_delivery_id = ${payload.external_delivery_id},
            expedite_provider_delivery_id = ${result.providerDeliveryId ?? null},
            expedite_status = COALESCE(${result.status ?? null}, expedite_status),
            expedite_delivery_fee = ${result.delivery_fee ?? null}, updated_at = NOW()
        WHERE id = ${orderId}
      `.catch(e => console.error('[expedite] native row update failed:', e instanceof Error ? e.message : e))
      console.log('[expedite] native delivery dispatched for', reference)
    } else {
      // Reset the claim so a later retry can re-dispatch, and make it loud — a paid
      // order with no courier is a fulfillment failure.
      await sql`UPDATE disco_orders SET expedite_delivery_id = NULL WHERE id = ${orderId} AND expedite_delivery_id = 'PENDING'`.catch(() => {})
      await alertOps('expedite: native delivery dispatch FAILED (paid order, no courier)', { orderId, reference, error: result.error })
    }
  } catch (e) {
    console.error('[expedite] dispatchExpediteForOrder error:', e instanceof Error ? e.message : e)
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
             to_char(order_date,'YYYY-MM-DD') AS order_date, order_time::text AS order_time, delivery_type,
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
      SELECT name, address, address_line1, address_line2, city, state, zipcode, timezone, lat, lng, phone
      FROM disco_restaurant_cache
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
