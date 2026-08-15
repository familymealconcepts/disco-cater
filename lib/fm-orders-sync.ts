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
import { isKnownFmDuplicateOrderNumber } from './known-fm-order-duplicates'
import { buildSaleTransactionFields } from './order/fm-sale-transaction'
import { fetchAllFmRestaurants } from './restaurant-cache'

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

// Must match the disco_orders_delivery_type_check constraint. An unrecognized FM
// value is stored as NULL (which the CHECK allows) rather than failing the insert
// and silently dropping the order — the exact class of bug that hid DoorDash orders.
const ALLOWED_DELIVERY_TYPES = new Set([
  'NASH_DELIVERY', 'OWN_DELIVERY', 'DOORDASH', 'SHIPDAY', 'THIRD_PARTY',
  'THIRD_PARTY_DELIVERY', 'PICKUP', 'DLIVRD', 'DOOR_DASH_DELIVERY', 'DLIVRD_DELIVERY',
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
  deliveryInstructions: string | null
  placedAt: string | null
}

// FM's real order-placement instant — OrderPublicResponseDto.createdDate
// (ZonedDateTime) or OrderInfoResponseDto.orderCreatedDate (Date), confirmed from
// FM's own Java DTOs. Both serialize to an ISO-parseable string; disco_orders.
// created_at is Neon SYNC time, not this — see placed_at's migration comment.
function parsePlacedAt(v: unknown): string | null {
  if (v == null) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function normalizeFmOrder(o: Record<string, unknown>): NormalizedFmOrder | null {
  const fmRef = s(o.orderReference) || s(o.reference)
  if (!isUuid(fmRef)) return null

  // Normalize FM's singular 'VOID' to Disco's canonical 'VOIDED' so Neon uses one
  // value everywhere.
  const statusRaw0 = (s(o.orderStatus) || s(o.status)).toUpperCase()
  const statusRaw = statusRaw0 === 'VOID' ? 'VOIDED' : statusRaw0
  const status = ALLOWED_STATUS.has(statusRaw) ? statusRaw : 'DUE'

  const rawDeliveryType = s(o.deliveryType) || null
  // Derive PICKUP vs DELIVERY from the RAW value (before coercion) so an
  // unrecognized delivery value still classifies the order correctly.
  const orderType: 'PICKUP' | 'DELIVERY' =
    (s(o.orderType).toUpperCase() === 'DELIVERY' || (rawDeliveryType || '').toUpperCase().includes('DELIVERY')) ? 'DELIVERY' : 'PICKUP'
  // Store only constraint-valid values; anything else → NULL (never drops the order).
  const deliveryType = rawDeliveryType && ALLOWED_DELIVERY_TYPES.has(rawDeliveryType) ? rawDeliveryType : null

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
    // Mirror FM's true delivery instructions (distinct from the general note).
    deliveryInstructions: s(o.dinerDeliveryInstructions) || s(o.deliveryInstructions) || null,
    placedAt: parsePlacedAt(o.createdDate ?? o.orderCreatedDate),
  }
}

// Replace disco_order_items + write disco_sale_transactions for an order from a
// SINGLE loadFmOrderDetails fetch (shared, not fetched twice) — items/add-ons and
// the financial-breakdown row both come from the same FM response.
//
// The transaction row is written ONLY when items were too — was unconditional,
// which produced 69 real orders with a disco_sale_transactions row and zero
// disco_order_items (syncOrderItemsFromDetails bails on an empty items array;
// syncSaleTransactionFromDetails didn't check that at all). Most of those 69
// turned out to have real items after all — orderClassics, a second FM item
// catalog parseFmOrder never read (see its own comment) — so this mostly self-
// corrects now that both catalogs are parsed. For the remainder — confirmed via
// a live audit to be orders in a terminal state (CANCELED/EXPIRED) where FM's
// /details response genuinely omits the original cart under any known field —
// writing neither is the honest choice: the popout's own completeness check
// (items.length === 0) still falls back to a live FM call for these, same as
// before this fix existed, rather than recording financial data with no way to
// show what was actually ordered.
export async function syncOrderDetail(orderId: number, fmRef: string): Promise<void> {
  const details = await loadFmOrderDetails(fmRef)
  if (!details) return
  const itemsWritten = await syncOrderItemsFromDetails(orderId, details)
  if (!itemsWritten) {
    console.warn(`[fm-orders-sync] order ${orderId} (fm ${fmRef}): FM's response has no items under any known field (meal packages or classics) — skipping the transaction write too, not just items.`)
    return
  }
  await syncSaleTransactionFromDetails(orderId, details)
}

// Replace disco_order_items for an order from FM's per-order details. Returns
// whether items now genuinely exist for this order (false when FM's response
// had none under any known field, or the write itself failed) — syncOrderDetail
// uses this to decide whether the transaction row should be written at all.
async function syncOrderItemsFromDetails(orderId: number, details: Record<string, unknown>): Promise<boolean> {
  const items = parseFmOrder(details).items
  if (!items.length) return false
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
  let itemsOk = true
  await sql.transaction(stmts).catch(e => {
    console.error('[fm-orders-sync] items replace failed:', e instanceof Error ? e.message : e)
    itemsOk = false
  })
  if (!itemsOk) return false

  // Mirror per-item add-ons when FM supplies them (parseFmOrder items carry an
  // `addOns` array). Best-effort + a no-op when absent — an add-on failure
  // doesn't invalidate the items themselves, so this doesn't affect the return
  // value. Item ids are re-loaded in insert order (ORDER BY id) so they line up
  // with the parsed items 1:1.
  const anyAddOns = items.some((it) => Array.isArray((it as { addOns?: unknown }).addOns) && ((it as { addOns?: unknown[] }).addOns?.length ?? 0) > 0)
  if (anyAddOns) {
    try {
      const idRows = (await sql`SELECT id FROM disco_order_items WHERE order_id = ${orderId} ORDER BY id`) as { id: number }[]
      const addStmts = [sql`DELETE FROM disco_order_item_addons WHERE order_item_id IN (SELECT id FROM disco_order_items WHERE order_id = ${orderId})`]
      for (let i = 0; i < idRows.length && i < items.length; i++) {
        const addOns = (items[i] as { addOns?: { name?: string; price?: number; count?: number; quantity?: number }[] }).addOns || []
        for (const a of addOns) {
          addStmts.push(sql`
            INSERT INTO disco_order_item_addons (order_item_id, name, price, quantity)
            VALUES (${idRows[i].id}, ${a.name || 'Add-on'}, ${n(a.price)}, ${Math.max(1, Math.trunc(n(a.count ?? a.quantity) || 1))})
          `)
        }
      }
      await sql.transaction(addStmts)
    } catch (e) { console.error('[fm-orders-sync] add-on mirror failed:', e instanceof Error ? e.message : e) }
  }
  return true
}

// Write disco_sale_transactions for an order from FM's per-order details — the
// same reconstruction the snapshot-based backfill performs (scripts/
// fm-order-backfill.ts), via the shared lib/order/fm-sale-transaction.ts, so
// this money math is defined exactly once regardless of which writer runs it.
//
// service_charge is written as NULL, not 0 — FM's API has no working path to
// the real applied service charge (paymentDetails is dead code on FM's own
// DTO, never set anywhere in their backend; the one endpoint that maps the
// real persisted value, GET /api/orders/list, 500s with a
// NonUniqueResultException for every restaurant tested). A confident-looking
// $0 would be worse than an honest unknown.
//
// tips_in_price is converted from FM's raw tips + tipsType via
// resolveTipsInPrice (not a residual from total — verified against 800 real
// historical orders, ~90% accurate; the ~10% miss is a pre-existing FM data
// quirk, not something any available field resolves).
async function syncSaleTransactionFromDetails(orderId: number, details: Record<string, unknown>): Promise<void> {
  const order = (((details?.data as Record<string, unknown>)?.order as Record<string, unknown>)
    ?? (details?.order as Record<string, unknown>)
    ?? details
    ?? {}) as Record<string, unknown>

  // A FM_BACKFILL row, when one exists, was reconstructed from the real fm_backup
  // snapshot (precomputed tips, real service_charge, stripe fee) — strictly more
  // trustworthy than this live, best-effort reconstruction. Never overwrite it.
  const existing = (await sql`
    SELECT source FROM disco_sale_transactions WHERE order_id = ${orderId} AND transaction_type = 'ORIGINAL' LIMIT 1
  `.catch(() => [])) as { source: string | null }[]
  if (existing[0]?.source === 'FM_BACKFILL') return

  const rawTips = n(order.tips)
  const fields = buildSaleTransactionFields({
    subtotal: n(order.subtotal), total: n(order.total) || n(order.transactionsTotal), fee: n(order.fee),
    stateTax: n(order.stateSalesTaxInPrice), localTax: n(order.localSalesTaxInPrice), otherTax: n(order.otherSalesTaxInPrice),
    ownDeliveryFee: n(order.ownDeliveryFee), thirdPartyDeliveryFee: n(order.thirdPartyDeliveryFee), doordashDeliveryFee: n(order.doordashDeliveryFee),
    thirdPartyDeliverySubsiding: null,
    thirdPartyDeliveryTips: n(order.thirdPartyDeliveryTipsInPrice), doordashTips: null,
    discount: n(order.discount),
    // Not exposed by this endpoint at all (unlike service_charge, which has a
    // dead field to point at — lead gen and Stripe fee have no field here,
    // dead or otherwise) — NULL, not 0.
    leadGenOne: null, leadGenTwo: null, stripeFee: null,
    serviceCharge: null,
    tipsInPrice: null, rawTips: rawTips > 0 ? rawTips : null, tipsType: s(order.tipsType) || null,
  })

  await sql`DELETE FROM disco_sale_transactions WHERE order_id = ${orderId} AND source = 'FM_SYNC'`
  await sql`
    INSERT INTO disco_sale_transactions (
      order_id, transaction_status, transaction_type, subtotal, total, fee, service_charge, stripe_fee,
      state_tax, local_tax, other_tax, tips_in_price, third_party_delivery_tips,
      own_delivery_fee, third_party_delivery_fee, third_party_delivery_subsiding, discount,
      lead_gen_one_disco_fee, lead_gen_two_disco_fee, source
    ) VALUES (
      ${orderId}, 'PAID', 'ORIGINAL', ${fields.subtotal}, ${fields.total}, ${fields.fee}, ${fields.serviceCharge}, ${fields.stripeFee},
      ${fields.stateTax}, ${fields.localTax}, ${fields.otherTax}, ${fields.tipsInPrice}, ${fields.thirdPartyDeliveryTips},
      ${fields.ownDeliveryFee}, ${fields.thirdPartyDeliveryFee}, ${fields.thirdPartyDeliverySubsiding}, ${fields.discount},
      ${fields.leadGenOne}, ${fields.leadGenTwo}, 'FM_SYNC'
    )
  `.catch(e => console.error('[fm-orders-sync] sale_transaction insert failed:', e instanceof Error ? e.message : e))
}

interface ExistingRow { id: number; source_of_order: string; edit_count: number | null; edit_status: string | null }

// Upsert a single normalized FM order. Returns 'inserted' | 'updated' | 'skipped'.
// Per-restaurant name/address/phone snapshot (from the cache), so each mirrored FM
// order freezes the restaurant's details at mirror time — the order stays viewable
// even if the restaurant is later renamed or deleted. Cached per restaurant within a
// sync process to avoid a per-order lookup.
const snapshotCache = new Map<string, { name: string | null; address: string | null; phone: string | null }>()
async function restaurantSnapshot(ref: string): Promise<{ name: string | null; address: string | null; phone: string | null }> {
  const hit = snapshotCache.get(ref)
  if (hit) return hit
  let snap = { name: null as string | null, address: null as string | null, phone: null as string | null }
  try {
    const rc = (await sql`SELECT name, address, phone FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as { name: string | null; address: string | null; phone: string | null }[]
    if (rc[0]) snap = { name: rc[0].name ?? null, address: rc[0].address ?? null, phone: rc[0].phone ?? null }
  } catch { /* best-effort */ }
  snapshotCache.set(ref, snap)
  return snap
}

async function upsertOne(o: NormalizedFmOrder, restaurantReference: string, withItems: boolean): Promise<'inserted' | 'updated' | 'skipped'> {
  // NOT-NULL columns without a default: bail clearly rather than hit a constraint.
  if (!o.email || !o.orderNumber || !o.dateIso || !o.time) return 'skipped'
  const snap = await restaurantSnapshot(restaurantReference)

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
          restaurant_reference, restaurant_name, restaurant_address, restaurant_phone,
          customer_email, customer_first_name, customer_last_name, customer_phone,
          order_date, order_time, subtotal, total, fee, tips, tips_type, note, delivery_instructions, seen_by_admin, placed_at, created_at, updated_at
        ) VALUES (
          ${o.fmRef}::uuid, ${o.orderNumber}::bigint, ${o.status}, ${o.orderType}, ${o.deliveryType}, ${o.source},
          ${restaurantReference}::uuid, ${o.restaurantName || snap.name}, ${snap.address}, ${snap.phone},
          ${o.email}, ${o.firstName || null}, ${o.lastName || null}, ${o.phone},
          ${o.dateIso}::date, ${o.time}::time, ${o.subtotal}, ${o.total}, ${o.fee}, ${o.tips}, ${o.tipsType}, ${o.note}, ${o.deliveryInstructions}, ${o.seenByAdmin}, ${o.placedAt}, NOW(), NOW()
        )
        RETURNING id
      `) as { id: number }[]
    } catch (e) {
      // order_number UNIQUE collision or a bad cast → skip this order.
      // Suppress the alert ONLY for a collision already confirmed (offline,
      // against fm_backup) to be a real FM-side duplicate order_number for
      // THIS restaurant AND order_number — disco_orders_restaurant_order_number_uq
      // rejecting it is correct, permanent, expected behavior that will recur
      // every rotation forever, not a new failure each time (see
      // lib/known-fm-order-duplicates.ts). Anything else — a different
      // restaurant, or an order_number not in that known set — still alerts;
      // that would be genuinely new information about a fresh collision.
      const known = isKnownFmDuplicateOrderNumber(restaurantReference, o.orderNumber)
      if (known) {
        console.log('[fm-orders-sync] order insert skipped — known FM-side duplicate order_number, not alerting:', {
          orderNumber: o.orderNumber, restaurantReference,
        })
      } else {
        // Alert so a silently-dropped order is visible rather than lost in
        // the skip counter.
        await alertOps('fm-orders-sync: order insert skipped (dropped)', {
          orderNumber: o.orderNumber ?? null, restaurantReference,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      return 'skipped'
    }
    if (withItems && inserted[0]?.id) await syncOrderDetail(inserted[0].id, o.fmRef)

    // Backfill notification: this DISCO order was pulled by the sync, meaning the
    // real-time mirror missed it (an already-mirrored DISCO order has an existing
    // row and is skipped below). Fire Disco's confirmation for UPCOMING orders only
    // (idempotent via claimConfirmationSend, so a later real-time retry can't double
    // it). FAMILYMEAL-source orders are excluded — FamilyMeal notifies those itself.
    if (inserted[0]?.id && o.source === 'DISCO' && isUpcomingIso(o.dateIso)) {
      try {
        if (!withItems) await syncOrderDetail(inserted[0].id, o.fmRef) // ensure the email has line items
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
      restaurant_name = COALESCE(restaurant_name, ${o.restaurantName}, ${snap.name}),
      restaurant_address = COALESCE(restaurant_address, ${snap.address}),
      restaurant_phone = COALESCE(restaurant_phone, ${snap.phone}),
      customer_first_name = ${o.firstName || null}, customer_last_name = ${o.lastName || null},
      customer_phone = COALESCE(${o.phone}, customer_phone),
      order_date = ${o.dateIso}::date, order_time = ${o.time}::time,
      subtotal = COALESCE(${o.subtotal}, subtotal), total = COALESCE(${o.total}, total), fee = COALESCE(${o.fee}, fee),
      tips = ${o.tips}, tips_type = ${o.tipsType}, note = COALESCE(${o.note}, note),
      delivery_instructions = COALESCE(${o.deliveryInstructions}, delivery_instructions),
      seen_by_admin = ${o.seenByAdmin}, placed_at = COALESCE(placed_at, ${o.placedAt}), updated_at = NOW()
    WHERE id = ${row.id}
  `.catch(e => console.error('[fm-orders-sync] update:', e instanceof Error ? e.message : e))
  if (withItems) await syncOrderDetail(row.id, o.fmRef)
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

// Cheap page=0,size=1 fetch just to read FM's totalElements for a restaurant —
// used to tell a genuinely-complete sync apart from a partial one (see
// syncNonCacheRestaurantOrders). Confirmed live: the admin endpoint returns
// {totalPages, pageSize, totalElements, content}; the public-api one 404s for
// at least some restaurants, so both URLs are tried like fetchFmOrdersPage.
async function fetchFmOrderTotalCount(restaurantReference: string, auth: Record<string, string>): Promise<number | null> {
  const urls = [
    `${FM}/public-api/v2/restaurants/${restaurantReference}/orders?page=0&size=1`,
    `${FM}/api/admin/restaurants/${restaurantReference}/orders?page=0&size=1`,
  ]
  for (const url of urls) {
    try {
      const res = await fmFetch(url, { headers: { ...auth, Accept: 'application/json' }, cache: 'no-store' })
      if (!res.ok) continue
      const data = await res.json().catch(() => null) as Record<string, unknown> | null
      if (data && typeof data.totalElements === 'number') return data.totalElements
    } catch { /* try next url */ }
  }
  return null
}

// Single source of truth for "is this restaurant's FM order history fully
// synced" — used by BOTH syncNonCacheRestaurantOrders and the hourly cron's
// reconciliation pass (syncAllRestaurantOrders's reconcile option) so there is
// exactly one definition of "complete," not two implementations that can
// silently drift apart from each other over time. Complete means Neon's count
// of FM-mirrored rows is >= FM's live total — >= rather than === because a
// restaurant can never legitimately exceed FM's count, but treating a rare
// exact-tie-or-over as "still incomplete" would retry it forever for no reason.
// Returns null (unknown) if the FM call fails — callers must treat unknown as
// "try again next run," never as proof of either complete or incomplete.
export async function checkFmSyncComplete(
  restaurantReference: string,
  neonCount: number,
  auth: Record<string, string>,
): Promise<{ complete: boolean; fmTotal: number } | null> {
  const fmTotal = await fetchFmOrderTotalCount(restaurantReference, auth)
  if (fmTotal == null) return null
  return { complete: neonCount >= fmTotal, fmTotal }
}

// Repairs "bare" FAMILYMEAL orders for one restaurant — a header row with no
// ORIGINAL disco_sale_transactions row at all (so no tax/fee breakdown, no
// items, no add-ons). Same count-comparison shape as checkFmSyncComplete, just
// applied to a different signal (bare-order count instead of missing-header
// count) — one pattern, two uses, not two implementations. This is the
// ongoing-writer half of the missing-detail gap; scripts/fm-order-backfill.ts
// is the historical half and can only ever reach pre-freeze orders (it matches
// against the frozen fm_backup snapshot). This function works from the live
// API instead, so it also covers every post-freeze order going forward.
//
// Bounded by `cap` per call — a restaurant with a large backlog (e.g. one the
// cache-independent cron just pulled in full with withItems:false, deliberately,
// to avoid that pull itself blowing its own time budget) self-heals over
// multiple calls rather than risking this one's. Cheap when there's no
// backlog: one COUNT query, nothing else.
export async function repairBareOrderDetail(
  restaurantReference: string,
  cap: number = 20,
): Promise<{ bareBefore: number; repaired: number }> {
  const countRows = (await sql`
    SELECT COUNT(*)::int AS n
    FROM disco_orders o
    LEFT JOIN disco_sale_transactions t ON t.order_id = o.id AND t.transaction_type = 'ORIGINAL'
    WHERE o.restaurant_reference = ${restaurantReference}::uuid
      AND o.source_of_order = 'FAMILYMEAL' AND o.fm_order_reference IS NOT NULL
      AND o.is_deleted = false AND t.id IS NULL
  `.catch(() => [])) as { n: number }[]
  const bareBefore = countRows[0]?.n ?? 0
  if (bareBefore === 0) return { bareBefore, repaired: 0 }

  const bareRows = (await sql`
    SELECT o.id, o.fm_order_reference::text AS fm_ref
    FROM disco_orders o
    LEFT JOIN disco_sale_transactions t ON t.order_id = o.id AND t.transaction_type = 'ORIGINAL'
    WHERE o.restaurant_reference = ${restaurantReference}::uuid
      AND o.source_of_order = 'FAMILYMEAL' AND o.fm_order_reference IS NOT NULL
      AND o.is_deleted = false AND t.id IS NULL
    ORDER BY o.placed_at DESC NULLS LAST
    LIMIT ${cap}
  `.catch(() => [])) as { id: number; fm_ref: string }[]

  let repaired = 0
  for (const r of bareRows) {
    try { await syncOrderDetail(r.id, r.fm_ref); repaired++ }
    catch (e) { console.error('[fm-orders-sync] bare-order repair failed:', r.id, e instanceof Error ? e.message : e) }
  }
  return { bareBefore, repaired }
}

// Sync one restaurant's FM orders into Neon. `maxPages` bounds the pull (most
// recent first, FM has no documented since-date filter on this endpoint so we
// can't ask it to skip old pages directly); `withItems` also pulls per-order
// line items (slower).
//
// `stopAtKnownDate: true` makes this a true incremental sync rather than a
// fixed "always just the newest page" pull — the ~100-order ceiling bug this
// replaced. Before paging, it reads the restaurant's current MAX(order_date)
// among already-mirrored FM-origin rows (fm_order_reference IS NOT NULL) as a
// high-water mark, then stops once an entire page's orders are all strictly
// older than that mark — everything past that point is guaranteed already
// covered by a prior sync. The boundary page itself is always fully
// processed (not skipped), so same-day status changes and genuinely-new
// same-day orders still get picked up. A restaurant with no prior mirrored
// orders has no mark, so this option is a no-op for it (falls back to the
// plain maxPages cap, same as a full backfill's first pass would).
export async function syncRestaurantOrders(
  restaurantReference: string,
  opts: { withItems?: boolean; pageSize?: number; maxPages?: number; stopAtKnownDate?: boolean } = {},
): Promise<SyncResult> {
  const result: SyncResult = { restaurantReference, fetched: 0, inserted: 0, updated: 0, skipped: 0 }
  if (!isUuid(restaurantReference)) { result.error = 'restaurantReference is not a UUID'; return result }

  const pageSize = opts.pageSize ?? 100
  const maxPages = opts.maxPages ?? 5
  const withItems = opts.withItems ?? false

  let auth: Record<string, string>
  try { auth = await getFmServiceAuthHeader() } catch (e) { result.error = `service auth: ${e instanceof Error ? e.message : e}`; return result }

  let highWaterMark: string | null = null
  if (opts.stopAtKnownDate) {
    const rows = (await sql`
      SELECT MAX(order_date)::text AS max_date FROM disco_orders
      WHERE restaurant_reference = ${restaurantReference}::uuid AND fm_order_reference IS NOT NULL
    `.catch(() => [])) as { max_date: string | null }[]
    highWaterMark = rows[0]?.max_date || null
  }

  for (let page = 0; page < maxPages; page++) {
    const orders = await fetchFmOrdersPage(restaurantReference, auth, page, pageSize)
    if (orders === null) { if (page === 0) result.error = 'FM orders fetch failed'; break }
    if (!orders.length) break
    result.fetched += orders.length
    let oldestDateOnPage: string | null = null
    for (const raw of orders) {
      const norm = normalizeFmOrder(raw)
      if (!norm) { result.skipped++; continue }
      if (norm.dateIso && (oldestDateOnPage === null || norm.dateIso < oldestDateOnPage)) oldestDateOnPage = norm.dateIso
      try {
        const outcome = await upsertOne(norm, restaurantReference, withItems)
        result[outcome]++
      } catch (e) {
        console.error('[fm-orders-sync] upsert error:', e instanceof Error ? e.message : e)
        result.skipped++
      }
    }
    if (orders.length < pageSize) break // last page
    if (highWaterMark && oldestDateOnPage && oldestDateOnPage < highWaterMark) break // reached already-synced territory
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
//
// `reconcile: true` adds the fix for the stopAtKnownDate blind spot: that
// option (used by the hourly cron for its normal incremental pass) stops
// paging as soon as it reaches order dates already covered by a prior sync —
// it has no way to detect a HOLE inside already-covered territory (exactly
// the shape of damage the old "~100 most recent orders" ceiling bug left
// behind for restaurants first synced before stopAtKnownDate existed). With
// reconcile on, each restaurant in the batch gets one extra cheap FM call
// (checkFmSyncComplete, shared with syncNonCacheRestaurantOrders) comparing
// Neon's count against FM's live total; on a mismatch, that restaurant's pull
// for this run is upgraded to a full non-incremental pass (stopAtKnownDate:
// false, maxPages:500) instead of the normal shallow one, and the mismatch is
// both logged and alerted — a mismatch found by a low-noise, otherwise-cheap
// sweep is worth surfacing, not silently absorbed as if the sweep's job is to
// hide problems rather than report them. Cost: one lightweight page=0,size=1
// FM call per restaurant per batch visit (e.g. 50/hour at the hourly cron's
// current BATCH), so a full 4,082-restaurant fleet sweep completes in ~82
// hourly runs (~3.4 days) — the expensive full pull only fires for the small
// minority that actually mismatch.
export async function syncAllRestaurantOrders(
  opts: { withItems?: boolean; limit?: number; offset?: number; maxPages?: number; stopAtKnownDate?: boolean; reconcile?: boolean } = {},
): Promise<{
  restaurants: number; results: SyncResult[]
  mismatches: { restaurantReference: string; neonCount: number; fmTotal: number }[]
  bareRepairs: { restaurantReference: string; bareBefore: number; repaired: number }[]
}> {
  const limit = Math.min(opts.limit ?? 50, 200)
  const offset = opts.offset ?? 0
  const rows = (await sql`
    SELECT restaurant_reference FROM disco_restaurant_cache
    ORDER BY restaurant_reference LIMIT ${limit} OFFSET ${offset}
  `.catch(() => [])) as { restaurant_reference: string }[]

  const refs = rows.map(r => r.restaurant_reference).filter(isUuid)
  const results: SyncResult[] = []
  const mismatches: { restaurantReference: string; neonCount: number; fmTotal: number }[] = []
  const bareRepairs: { restaurantReference: string; bareBefore: number; repaired: number }[] = []
  let auth: Record<string, string> | null = null

  for (const ref of refs) {
    let stopAtKnownDate = opts.stopAtKnownDate
    let maxPages = opts.maxPages ?? 3

    if (opts.reconcile) {
      if (!auth) { try { auth = await getFmServiceAuthHeader() } catch { auth = null } }
      if (auth) {
        const neonRows = (await sql`
          SELECT COUNT(*)::int AS n FROM disco_orders
          WHERE restaurant_reference = ${ref}::uuid AND fm_order_reference IS NOT NULL AND is_deleted = false
        `.catch(() => [])) as { n: number }[]
        const neonCount = neonRows[0]?.n ?? 0
        const check = await checkFmSyncComplete(ref, neonCount, auth)
        if (check && !check.complete) {
          const delta = check.fmTotal - neonCount
          // Log only, deliberately no alertOps here: this fires for every restaurant with a
          // historical gap across the 21-hour rotation, and the sweep repairs it automatically
          // in the same run (stopAtKnownDate/maxPages widened below) — posting each one to
          // Slack turned into per-restaurant maintenance noise in the orders channel. The
          // per-run summary line in cron/sync-fm-orders/route.ts (mismatches.length) is the
          // aggregate signal; this line is what stays for a human to grep in Vercel logs.
          console.warn(`[fm-orders-sync] reconciliation mismatch: restaurant=${ref} neonCount=${neonCount} fmTotal=${check.fmTotal} delta=${delta}`)
          mismatches.push({ restaurantReference: ref, neonCount, fmTotal: check.fmTotal })
          stopAtKnownDate = false
          maxPages = 500
        }
      }
    }

    // Bare-order detail repair — unconditional (not gated behind reconcile):
    // cheap when there's no backlog (one COUNT query), and "no FM order sits
    // bare indefinitely" shouldn't depend on an opt-in flag.
    const bareResult = await repairBareOrderDetail(ref)
    if (bareResult.bareBefore > 0) {
      console.warn(`[fm-orders-sync] bare-order repair: restaurant=${ref} bareBefore=${bareResult.bareBefore} repaired=${bareResult.repaired}`)
      bareRepairs.push({ restaurantReference: ref, ...bareResult })
    }

    results.push(await syncRestaurantOrders(ref, {
      withItems: opts.withItems ?? false,
      maxPages,
      stopAtKnownDate,
    }))
  }
  return { restaurants: refs.length, results, mismatches, bareRepairs }
}

// Cache-independent history sync for restaurants disco_restaurant_cache's own
// normalize() excludes from LIVE/marketplace visibility (blocked, or missing
// address coordinates — lib/restaurant-cache.ts:75). That exclusion is
// deliberate for map/search/orderability, but syncAllRestaurantOrders (above),
// the hourly cron, and the one-time fleet backfill all discover their
// restaurant candidates FROM disco_restaurant_cache — so a blocked restaurant's
// entire order history was permanently invisible to every one of them, not
// just missing a recent page. Confirmed empirically: 57 of 59 restaurants with
// zero synced orders were also absent from the cache entirely; 56 of those 57
// are blocked in FM.
//
// This discovers candidates directly from FM's live restaurant list instead
// (reusing restaurant-cache.ts's own pagination, not a second implementation),
// filters to references NOT already in disco_restaurant_cache, and pulls each
// one's full history via the exact same call backfillFmOrderHistory makes
// (lib/native-conversion.ts) — inlined here rather than imported, since
// native-conversion.ts already imports syncRestaurantOrders FROM this file;
// importing back would be a circular dependency for a one-line wrapper.
//
// No new progress-marker column or table: fm_history_backfilled_at lives ON
// disco_restaurant_cache, and writing it for a restaurant with no cache row
// would mean either creating one (reopening the exact "must audit every live
// consumer" risk this path exists to avoid) or a silent no-op update. Instead,
// "already handled" is a Neon-count-vs-FM-count comparison, checked fresh each
// run — NOT "does this restaurant have any disco_orders row yet" (that was the
// original design and it was a bug: a restaurant that only got partially synced
// — a time-budget cutoff mid-run, a transient FM error on some page, or a
// per-restaurant data issue like Mav's Top Buns' duplicate order_numbers,
// below — would satisfy ">=1 row" forever and never be revisited, silently
// freezing whatever gap it had at the moment of that first partial run. Cost:
// one extra lightweight FM call (page=0,size=1, just for totalElements) per
// restaurant that already has >0 rows; restaurants at 0 rows skip straight to
// a full attempt as before, so the common case (genuinely-untouched restaurant)
// pays no extra cost.
// Verified empirically before shipping: "not in disco_restaurant_cache" is
// 329 restaurants today, not the ~57 with real historical orders — most of
// the extra ~270 are FM accounts with genuinely zero orders ever (incomplete
// signups, etc.), which is fine, but it means a single unbounded pass through
// all 329 (each needing at least one live FM page-0 fetch) risks exceeding
// maxDuration before ever reaching a restaurant that actually matters, like
// Mav's Top Buns (1,200 orders) — if it happens to sort late. Two guards:
//   - TIME_BUDGET_MS stops the loop with margin, same pattern as the CRM
//     export (app/api/export/orders/route.ts) — partial progress is fine
//     here (daily cadence, self-healing over a few days), an uncontrolled
//     platform timeout mid-write is not.
//   - The candidate order is shuffled per run, not always alphabetical —
//     otherwise a truncated run would always retry the same early subset
//     forever and never reach the tail.
const NON_CACHE_TIME_BUDGET_MS = 270_000

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export async function syncNonCacheRestaurantOrders(): Promise<{
  fmRestaurants: number
  notInCache: number
  alreadyComplete: number
  resumedPartial: number
  attempted: number
  skippedOnTimeBudget: number
  countCheckFailed: number
  results: SyncResult[]
  bareRepairs: { restaurantReference: string; bareBefore: number; repaired: number }[]
}> {
  const startedAt = Date.now()
  const fmRows = await fetchAllFmRestaurants()
  const fmRefs = [...new Set(
    fmRows.map(r => String((r as Record<string, unknown>).reference ?? (r as Record<string, unknown>).restaurantReference ?? '')).filter(isUuid),
  )]

  const cacheRows = (await sql`SELECT restaurant_reference::text AS ref FROM disco_restaurant_cache`) as { ref: string }[]
  const cacheRefSet = new Set(cacheRows.map(r => r.ref))
  const notInCache = shuffle(fmRefs.filter(ref => !cacheRefSet.has(ref)))

  // Bulk-load current Neon counts up front (one query) rather than one COUNT
  // per restaurant in the loop — matches fm_order_reference IS NOT NULL so a
  // stray native order for the same reference (unlikely for a blocked
  // restaurant, but not impossible) never counts toward "FM history synced."
  const neonCountRows = (await sql`
    SELECT restaurant_reference::text AS ref, COUNT(*)::int AS n
    FROM disco_orders
    WHERE restaurant_reference = ANY(${notInCache}::uuid[]) AND fm_order_reference IS NOT NULL AND is_deleted = false
    GROUP BY restaurant_reference
  `) as { ref: string; n: number }[]
  const neonCount = new Map(neonCountRows.map(r => [r.ref, r.n]))

  let auth: Record<string, string> | null = null
  const results: SyncResult[] = []
  const bareRepairs: { restaurantReference: string; bareBefore: number; repaired: number }[] = []
  let alreadyComplete = 0
  let resumedPartial = 0
  let skippedOnTimeBudget = 0
  let countCheckFailed = 0
  for (const ref of notInCache) {
    if (Date.now() - startedAt > NON_CACHE_TIME_BUDGET_MS) { skippedOnTimeBudget++; continue }
    const currentCount = neonCount.get(ref) || 0
    let shouldSync = currentCount === 0
    if (currentCount > 0) {
      // Not "never touched" — decide complete vs partial by comparing counts,
      // not by existence. A restaurant can never fully reach fmTotal if it has
      // its own duplicate-order_number rows in FM's raw data (a real, separate
      // issue — see Mav's Top Buns) or genuinely-unsyncable rows (no resolvable
      // email); either way, more attempts stay harmless (a fully-synced-except-
      // for-those restaurant re-attempts every run, cheap: fetchFmOrdersPage
      // fetches, upsertOne re-checks each by fm_order_reference and updates,
      // no duplicate rows are ever created).
      if (!auth) { try { auth = await getFmServiceAuthHeader() } catch { auth = null } }
      const check = auth ? await checkFmSyncComplete(ref, currentCount, auth) : null
      if (!check) countCheckFailed++ // can't tell — don't guess, try again next run
      else if (check.complete) alreadyComplete++
      else { resumedPartial++; shouldSync = true }
    }
    // Same params as backfillFmOrderHistory (lib/native-conversion.ts) —
    // full-history pull, not the hourly cron's shallow incremental one. Always
    // withItems:false here — a large restaurant's first full pull is exactly
    // the case that's genuinely expensive per-order (see repairBareOrderDetail
    // below for how the resulting bare backlog gets closed instead).
    if (shouldSync) {
      results.push(await syncRestaurantOrders(ref, { withItems: false, pageSize: 100, maxPages: 500 }))
    }
    // Bare-order detail repair — runs regardless of shouldSync (a header-
    // complete restaurant, e.g. one this cron already fully pulled on a prior
    // run, can still have a bare-detail backlog from that same withItems:false
    // pull). Cheap when clean: one COUNT query.
    const bareResult = await repairBareOrderDetail(ref)
    if (bareResult.bareBefore > 0) {
      console.warn(`[fm-orders-sync] bare-order repair: restaurant=${ref} bareBefore=${bareResult.bareBefore} repaired=${bareResult.repaired}`)
      bareRepairs.push({ restaurantReference: ref, ...bareResult })
    }
  }
  return {
    fmRestaurants: fmRefs.length, notInCache: notInCache.length, alreadyComplete, resumedPartial,
    attempted: results.length, skippedOnTimeBudget, countCheckFailed, results, bareRepairs,
  }
}
