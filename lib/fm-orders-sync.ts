// FM → Neon order sync. Data flows one way: FM is read-only, Neon (disco_orders)
// is the source of truth for the restaurant portal. Pulls a restaurant's orders
// from FM with the SUPER_ADMIN service JWT and upserts them into disco_orders
// (+ disco_order_items), keyed on fm_order_reference.
//
// Reconciliation rules (so the sync never clobbers Disco-owned state):
//   • A row that is Disco-native (source_of_order='DISCO') is never touched.
//   • A row that has been natively edited (edit_count>0 or a pending edit) keeps
//     its Disco money/date/items — only its lifecycle order_status is refreshed.
//   • An un-edited FM-origin row is fully refreshed from FM.

import { sql } from './db'
import { getFmServiceAuthHeader } from './fm-service-auth'
import { loadFmOrderDetails, parseFmOrder, fmDateToIso, isUuid } from './order-edit'
import { fmFetch } from './fm-fetch'
import { dispatchOrderConfirmations } from './order-notifications'
import { alertOps } from './ops-alert'

// A backfilled order is worth confirming only if its pickup is still upcoming —
// a full-cycle sync also inserts historical orders, which must NOT trigger emails.
function isUpcomingIso(iso: string | null | undefined): boolean {
  if (!iso) return false
  const today = new Date().toISOString().slice(0, 10) // UTC day is fine for an "not weeks old" gate
  return iso >= today
}

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// disco_orders.order_status CHECK set (001_disco_orders.sql, widened for sync).
const ALLOWED_STATUS = new Set([
  'CART', 'RESERVED', 'DUE', 'COMPLETED', 'CANCELED', 'CANCELLED', 'REFUND', 'REFUNDED',
  'PARTIAL_REFUND', 'EXPIRED', 'VOID', 'VOIDED', 'UNPAID', 'PAID', 'PAYMENT_FAILED', 'REOPEN',
])

function n(v: unknown): number { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : 0 }
function s(v: unknown): string { return typeof v === 'string' ? v : (v == null ? '' : String(v)) }

export interface SyncResult {
  restaurantReference: string
  fetched: number
  inserted: number
  updated: number
  skipped: number
  error?: string
}

// One normalized FM order, read defensively across the two FM list DTOs
// (OrderPublicResponseDto from the admin endpoint vs OrderInfoResponseDto).
interface NormalizedFmOrder {
  fmRef: string
  orderNumber: string
  status: string
  orderType: 'PICKUP' | 'DELIVERY'
  deliveryType: string | null
  dateIso: string
  time: string
  email: string
  firstName: string
  lastName: string
  phone: string | null
  subtotal: number | null
  total: number | null
  fee: number | null
  tips: number
  tipsType: string
  source: 'DISCO' | 'FAMILYMEAL'
  restaurantName: string | null
  seenByAdmin: boolean
  note: string | null
}

function normalizeFmOrder(o: Record<string, unknown>): NormalizedFmOrder | null {
  const fmRef = s(o.orderReference) || s(o.reference)
  if (!isUuid(fmRef)) return null

  // Normalize FM's singular 'VOID' to Disco's canonical 'VOIDED' so Neon uses one
  // value everywhere.
  const statusRaw0 = (s(o.orderStatus) || s(o.status)).toUpperCase()
  const statusRaw = statusRaw0 === 'VOID' ? 'VOIDED' : statusRaw0
  const status = ALLOWED_STATUS.has(statusRaw) ? statusRaw : 'DUE'

  const deliveryType = s(o.deliveryType) || null
  const orderType: 'PICKUP' | 'DELIVERY' =
    (s(o.orderType).toUpperCase() === 'DELIVERY' || (deliveryType || '').toUpperCase().includes('DELIVERY')) ? 'DELIVERY' : 'PICKUP'

  const sourceRaw = (s(o.sourceoforder) || s(o.sourceOfOrder)).toUpperCase()
  const source: 'DISCO' | 'FAMILYMEAL' = sourceRaw === 'DISCO' ? 'DISCO' : 'FAMILYMEAL'

  const total = (o.total != null || o.transactionsTotal != null) ? n(o.total ?? o.transactionsTotal) : null
  const subtotal = o.subtotal != null ? n(o.subtotal) : null
  const fee = (o.fee != null || o.fees != null) ? n(o.fee ?? o.fees) : null

  return {
    fmRef,
    orderNumber: s(o.orderNumber) || s(o.orderNo),
    status,
    orderType,
    deliveryType,
    dateIso: fmDateToIso(s(o.orderDate)),
    time: s(o.orderTime),
    email: s(o.userEmail) || s(o.email) || s(o.customerEmail),
    firstName: s(o.firstName),
    lastName: s(o.lastName),
    phone: s(o.phoneNumber) || s(o.phone) || null,
    subtotal,
    total,
    fee,
    tips: n(o.tips),
    tipsType: s(o.tipsType) || 'PERCENTAGE',
    source,
    restaurantName: s(o.restaurantName) || null,
    seenByAdmin: o.orderSeenByAdmin === true || o.seenByAdmin === true,
    note: s(o.note) || null,
  }
}

// Replace disco_order_items for an order from FM's per-order details. Best-effort.
async function syncOrderItems(orderId: number, fmRef: string): Promise<void> {
  const details = await loadFmOrderDetails(fmRef)
  if (!details) return
  const items = parseFmOrder(details).items
  if (!items.length) return
  // Atomic replace: DELETE + all INSERTs in one transaction, so a failed insert
  // can never leave the order with missing items (I4).
  const stmts = [sql`DELETE FROM disco_order_items WHERE order_id = ${orderId}`]
  for (const it of items) {
    const unit = n(it.price)
    const qty = Math.max(1, Math.trunc(n(it.count) || 1))
    const serves = it.serves != null ? (parseInt(String(it.serves).match(/\d+/)?.[0] || '', 10) || null) : null
    stmts.push(sql`
      INSERT INTO disco_order_items (order_id, meal_package_reference, name, quantity, price_per_unit, total_price, serves)
      VALUES (${orderId}, ${it.reference || null}, ${it.name || it.reference || 'Item'}, ${qty}, ${unit}, ${Math.round(unit * qty * 100) / 100}, ${serves})
    `)
  }
  await sql.transaction(stmts).catch(e => console.error('[fm-orders-sync] items replace failed:', e instanceof Error ? e.message : e))
}

interface ExistingRow { id: number; source_of_order: string; edit_count: number | null; edit_status: string | null }

// Upsert a single normalized FM order. Returns 'inserted' | 'updated' | 'skipped'.
async function upsertOne(o: NormalizedFmOrder, restaurantReference: string, withItems: boolean): Promise<'inserted' | 'updated' | 'skipped'> {
  // NOT-NULL columns without a default: bail clearly rather than hit a constraint.
  if (!o.email || !o.orderNumber || !o.dateIso || !o.time) return 'skipped'

  const existing = (await sql`
    SELECT id, source_of_order, COALESCE(edit_count,0) AS edit_count, edit_status
    FROM disco_orders WHERE fm_order_reference = ${o.fmRef}::uuid LIMIT 1
  `.catch(() => [])) as ExistingRow[]
  const row = existing[0]

  if (!row) {
    let inserted: { id: number }[] = []
    try {
      inserted = (await sql`
        INSERT INTO disco_orders (
          fm_order_reference, order_number, order_status, order_type, delivery_type, source_of_order,
          restaurant_reference, restaurant_name, customer_email, customer_first_name, customer_last_name, customer_phone,
          order_date, order_time, subtotal, total, fee, tips, tips_type, note, seen_by_admin, created_at, updated_at
        ) VALUES (
          ${o.fmRef}::uuid, ${o.orderNumber}::bigint, ${o.status}, ${o.orderType}, ${o.deliveryType}, ${o.source},
          ${restaurantReference}::uuid, ${o.restaurantName}, ${o.email}, ${o.firstName || null}, ${o.lastName || null}, ${o.phone},
          ${o.dateIso}::date, ${o.time}::time, ${o.subtotal}, ${o.total}, ${o.fee}, ${o.tips}, ${o.tipsType}, ${o.note}, ${o.seenByAdmin}, NOW(), NOW()
        )
        RETURNING id
      `) as { id: number }[]
    } catch (e) {
      // order_number UNIQUE collision or a bad cast → skip this order. Alert so a
      // silently-dropped order is visible rather than lost in the skip counter.
      await alertOps('fm-orders-sync: order insert skipped (dropped)', {
        orderNumber: o.orderNumber ?? null, restaurantReference,
        error: e instanceof Error ? e.message : String(e),
      })
      return 'skipped'
    }
    if (withItems && inserted[0]?.id) await syncOrderItems(inserted[0].id, o.fmRef)

    // Backfill notification: this DISCO order was pulled by the sync, meaning the
    // real-time mirror missed it (an already-mirrored DISCO order has an existing
    // row and is skipped below). Fire Disco's confirmation for UPCOMING orders only
    // (idempotent via claimConfirmationSend, so a later real-time retry can't double
    // it). FAMILYMEAL-source orders are excluded — FamilyMeal notifies those itself.
    if (inserted[0]?.id && o.source === 'DISCO' && isUpcomingIso(o.dateIso)) {
      try {
        if (!withItems) await syncOrderItems(inserted[0].id, o.fmRef) // ensure the email has line items
        await dispatchOrderConfirmations(inserted[0].id, 'FM_SYNC_BACKFILL')
      } catch (e) {
        await alertOps('fm-orders-sync: backfill confirmation failed', {
          orderNumber: o.orderNumber ?? null, error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    return 'inserted'
  }

  // Disco-native rows are owned entirely by Disco — never touched by the sync.
  if (row.source_of_order === 'DISCO') return 'skipped'

  const nativelyEdited = (row.edit_count ?? 0) > 0 || (row.edit_status != null)
  if (nativelyEdited) {
    // Only refresh lifecycle status; keep the Disco-edited money/date/items.
    await sql`UPDATE disco_orders SET order_status = ${o.status}, seen_by_admin = ${o.seenByAdmin}, updated_at = NOW() WHERE id = ${row.id}`
      .catch(e => console.error('[fm-orders-sync] status update:', e instanceof Error ? e.message : e))
    return 'updated'
  }

  // Un-edited FM-origin row → full refresh from FM.
  await sql`
    UPDATE disco_orders SET
      order_status = ${o.status}, order_type = ${o.orderType}, delivery_type = ${o.deliveryType},
      restaurant_name = COALESCE(${o.restaurantName}, restaurant_name),
      customer_first_name = ${o.firstName || null}, customer_last_name = ${o.lastName || null},
      customer_phone = COALESCE(${o.phone}, customer_phone),
      order_date = ${o.dateIso}::date, order_time = ${o.time}::time,
      subtotal = COALESCE(${o.subtotal}, subtotal), total = COALESCE(${o.total}, total), fee = COALESCE(${o.fee}, fee),
      tips = ${o.tips}, tips_type = ${o.tipsType}, note = COALESCE(${o.note}, note),
      seen_by_admin = ${o.seenByAdmin}, updated_at = NOW()
    WHERE id = ${row.id}
  `.catch(e => console.error('[fm-orders-sync] update:', e instanceof Error ? e.message : e))
  if (withItems) await syncOrderItems(row.id, o.fmRef)
  return 'updated'
}

// Fetch one page of a restaurant's FM orders. Tries the documented public-api v2
// endpoint first, falling back to the admin endpoint. Returns the raw order array.
async function fetchFmOrdersPage(restaurantReference: string, auth: Record<string, string>, page: number, size: number): Promise<Record<string, unknown>[] | null> {
  const qs = `page=${page}&size=${size}&sort=orderDate,desc`
  const urls = [
    `${FM}/public-api/v2/restaurants/${restaurantReference}/orders?${qs}`,
    `${FM}/api/admin/restaurants/${restaurantReference}/orders?${qs}`,
  ]
  for (const url of urls) {
    try {
      const res = await fmFetch(url, { headers: { ...auth, Accept: 'application/json' }, cache: 'no-store' })
      if (!res.ok) continue
      const data = await res.json().catch(() => null)
      if (Array.isArray(data)) return data as Record<string, unknown>[]
      if (Array.isArray((data as Record<string, unknown>)?.content)) return (data as { content: Record<string, unknown>[] }).content
      return []
    } catch { /* try next url */ }
  }
  return null
}

// Sync one restaurant's FM orders into Neon. `maxPages` bounds the pull (most
// recent first); `withItems` also pulls per-order line items (slower).
export async function syncRestaurantOrders(
  restaurantReference: string,
  opts: { withItems?: boolean; pageSize?: number; maxPages?: number } = {},
): Promise<SyncResult> {
  const result: SyncResult = { restaurantReference, fetched: 0, inserted: 0, updated: 0, skipped: 0 }
  if (!isUuid(restaurantReference)) { result.error = 'restaurantReference is not a UUID'; return result }

  const pageSize = opts.pageSize ?? 100
  const maxPages = opts.maxPages ?? 5
  const withItems = opts.withItems ?? false

  let auth: Record<string, string>
  try { auth = await getFmServiceAuthHeader() } catch (e) { result.error = `service auth: ${e instanceof Error ? e.message : e}`; return result }

  for (let page = 0; page < maxPages; page++) {
    const orders = await fetchFmOrdersPage(restaurantReference, auth, page, pageSize)
    if (orders === null) { if (page === 0) result.error = 'FM orders fetch failed'; break }
    if (!orders.length) break
    result.fetched += orders.length
    for (const raw of orders) {
      const norm = normalizeFmOrder(raw)
      if (!norm) { result.skipped++; continue }
      try {
        const outcome = await upsertOne(norm, restaurantReference, withItems)
        result[outcome]++
      } catch (e) {
        console.error('[fm-orders-sync] upsert error:', e instanceof Error ? e.message : e)
        result.skipped++
      }
    }
    if (orders.length < pageSize) break // last page
  }
  return result
}

// Sync a SINGLE FM order into Neon by its FM reference (e.g. before an admin
// transfer of an order that was never synced). Loads FM /details, normalizes, and
// upserts into disco_orders (+ items). Returns the order's restaurant reference.
export async function syncOneFmOrder(fmRef: string, withItems = true): Promise<{ ok: boolean; restaurantReference?: string }> {
  if (!isUuid(fmRef)) return { ok: false }
  const details = await loadFmOrderDetails(fmRef)
  if (!details) return { ok: false }
  const p = parseFmOrder(details)
  const restaurantReference = p.restaurantRef || ''
  if (!isUuid(restaurantReference)) return { ok: false }
  const norm = normalizeFmOrder(p.order as Record<string, unknown>)
  if (!norm) return { ok: false }
  try {
    await upsertOne(norm, restaurantReference, withItems)
    return { ok: true, restaurantReference }
  } catch (e) {
    console.error('[fm-orders-sync] syncOneFmOrder failed:', e instanceof Error ? e.message : e)
    return { ok: false }
  }
}

// Sync many restaurants (super-admin / cron). Pulls candidate restaurant UUIDs
// from the restaurant cache. Bounded by limit/offset for batching.
export async function syncAllRestaurantOrders(
  opts: { withItems?: boolean; limit?: number; offset?: number; maxPages?: number } = {},
): Promise<{ restaurants: number; results: SyncResult[] }> {
  const limit = Math.min(opts.limit ?? 50, 200)
  const offset = opts.offset ?? 0
  const rows = (await sql`
    SELECT restaurant_reference FROM disco_restaurant_cache
    ORDER BY restaurant_reference LIMIT ${limit} OFFSET ${offset}
  `.catch(() => [])) as { restaurant_reference: string }[]

  const refs = rows.map(r => r.restaurant_reference).filter(isUuid)
  const results: SyncResult[] = []
  for (const ref of refs) {
    results.push(await syncRestaurantOrders(ref, { withItems: opts.withItems ?? false, maxPages: opts.maxPages ?? 3 }))
  }
  return { restaurants: refs.length, results }
}
