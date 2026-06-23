// Shared helpers for the Disco-native order edit flow (edit route, edit-status
// route, and the Stripe invoice webhook). FM is reference-only — Disco owns the
// edit state in Neon.

import { sql } from './db'
import { getFmServiceAuthHeader } from './fm-service-auth'
import { sendOrderEditPaymentConfirmed } from './email/notifications'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const MAX_EDITS = 3
const NON_EDITABLE_STATUSES = ['COMPLETED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'VOID']

export function isEditableStatus(status: string): boolean {
  return !NON_EDITABLE_STATUSES.includes(String(status || '').toUpperCase())
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(v: string): boolean { return UUID_RE.test(String(v || '')) }

// FM date "DD.MM.YYYY" or "YYYY-MM-DD" → ISO "YYYY-MM-DD".
export function fmDateToIso(d: string): string {
  const dmy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d || '')
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
  return ymd ? `${ymd[1]}-${ymd[2]}-${ymd[3]}` : ''
}

// ISO "YYYY-MM-DD" → FM "DD.MM.YYYY".
export function isoToFmDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '')
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

// Hours from now until the pickup datetime. Returns Infinity when unparseable so
// the 24h gate never blocks on bad data.
export function hoursUntil(dateIso: string, timeStr: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso || '').slice(0, 10))
  if (!m) return Infinity
  const [hh, mm] = String(timeStr || '00:00').split(':').map(Number)
  const pickup = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh || 0, mm || 0)
  return (pickup - Date.now()) / 3_600_000
}

export interface DiscoOrderRow {
  id: number
  reference: string
  fm_order_reference: string | null
  order_number: number
  order_status: string
  order_type: string
  restaurant_reference: string
  restaurant_name: string | null
  restaurant_email: string | null
  customer_email: string
  customer_first_name: string | null
  customer_last_name: string | null
  order_date: string
  order_time: string
  tips: number
  tips_type: string
  edit_count: number
  edit_status: string | null
}

// Look up a Disco order by either its FM reference or its Disco reference.
export async function getDiscoOrder(ref: string): Promise<DiscoOrderRow | null> {
  if (!isUuid(ref)) return null
  try {
    const rows = (await sql`
      SELECT id, reference, fm_order_reference, order_number, order_status, order_type,
             restaurant_reference, restaurant_name, restaurant_email,
             customer_email, customer_first_name, customer_last_name,
             order_date, order_time, tips, tips_type,
             COALESCE(edit_count, 0) AS edit_count, edit_status
      FROM disco_orders
      WHERE fm_order_reference = ${ref}::uuid OR reference = ${ref}::uuid
      LIMIT 1
    `) as DiscoOrderRow[]
    return rows[0] ?? null
  } catch {
    return null
  }
}

export interface FmOrderItem { reference: string; name: string; price: number; count: number; serves?: string | number | null }
export interface FmOrderMoney {
  order: Record<string, unknown>
  subtotal: number
  total: number
  tip: number
  delivery: number
  tax: number
  taxAndFee: number
  taxRate: number
  tipsRaw: number
  tipsType: string
  status: string
  orderType: string
  orderDateIso: string
  orderTime: string
  orderNumber: string | number
  restaurantRef: string
  restaurantName: string
  customerEmail: string
  firstName: string
  items: FmOrderItem[]
}

function n(v: unknown): number { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : 0 }
function s(v: unknown): string { return typeof v === 'string' ? v : (v == null ? '' : String(v)) }

// Parse the FM /public-api/v2/orders/{ref}/details payload into the money +
// metadata we need for delta/tax math and emails. Reads defensively — FM nests
// the order under data.order or returns it flat.
export function parseFmOrder(details: Record<string, unknown>): FmOrderMoney {
  const order = (((details?.data as Record<string, unknown>)?.order as Record<string, unknown>)
    ?? (details?.order as Record<string, unknown>)
    ?? details
    ?? {}) as Record<string, unknown>

  const subtotal = n(order.subtotal)
  const total = n(order.total) || n(order.transactionsTotal)
  const tax = n(order.stateSalesTaxInPrice) + n(order.localSalesTaxInPrice) + n(order.otherSalesTaxInPrice)
  const delivery = (n(order.ownDeliveryFee) + n(order.doordashDeliveryFee) + n(order.thirdPartyDeliveryFee)) || n(order.deliveryFee)
  const tipsInPrice = n(order.tipsInPrice) + n(order.thirdPartyDeliveryTipsInPrice)
  const tipsRaw = n(order.tips)
  const tipsType = s(order.tipsType)
  // Dollar tip: priced wins; else derive from type + raw.
  let tip = tipsInPrice
  if (tip <= 0 && tipsRaw > 0) tip = tipsType === 'PERCENTAGE' ? subtotal * (tipsRaw / 100) : tipsRaw
  // Everything between subtotal and total that isn't tip/delivery → tax + fees.
  const taxAndFee = total - subtotal - tip - delivery
  const taxRate = subtotal > 0 ? taxAndFee / subtotal : 0

  // Items live under orderMealPackages (fall back to mealPackages/items).
  const rawItems = (Array.isArray(order.orderMealPackages) ? order.orderMealPackages
    : Array.isArray(order.mealPackages) ? order.mealPackages
    : Array.isArray(order.items) ? order.items
    : []) as Record<string, unknown>[]
  const items: FmOrderItem[] = rawItems.map(it => ({
    reference: s(it.reference) || s(it.mealPackageReference) || s((it.mealPackage as Record<string, unknown>)?.reference),
    name: s(it.name) || s((it.mealPackage as Record<string, unknown>)?.name),
    price: n(it.price) || n(it.pricePerUnit) || n((it.mealPackage as Record<string, unknown>)?.price),
    count: n(it.count) || n(it.quantity) || 1,
    serves: (it.serves as string | number | null | undefined) ?? null,
  }))

  const restaurant = (order.restaurant as Record<string, unknown>) ?? {}
  const user = (order.user as Record<string, unknown>) ?? {}
  return {
    order,
    subtotal, total, tip, delivery, tax, taxAndFee, taxRate, tipsRaw, tipsType,
    status: s(order.orderStatus) || s(order.status),
    orderType: s(order.orderType) || (s(order.deliveryType).includes('DELIVERY') ? 'DELIVERY' : 'PICKUP'),
    orderDateIso: fmDateToIso(s(order.orderDate)),
    orderTime: s(order.orderTime),
    orderNumber: (order.orderNumber as string | number) ?? s(order.orderNo) ?? '',
    restaurantRef: s(order.restaurantReference) || s(restaurant.reference),
    restaurantName: s(order.restaurantName) || s(restaurant.businessName) || s(restaurant.name),
    customerEmail: s(order.userEmail) || s(order.email) || s(user.email),
    firstName: s(order.firstName) || s(user.firstName),
    items,
  }
}

// Load the FM order details with the SUPER_ADMIN service JWT. Returns null on any
// failure.
export async function loadFmOrderDetails(ref: string): Promise<Record<string, unknown> | null> {
  try {
    const auth = await getFmServiceAuthHeader()
    const res = await fetch(`${FM}/public-api/v2/orders/${ref}/details`, { headers: { ...auth, Accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json().catch(() => null)) as Record<string, unknown> | null
  } catch {
    return null
  }
}

// Neon-first "original order" snapshot used by the edit route. Neon owns the
// CURRENT items/money/schedule (reflecting any prior native edits); FM supplies
// the structural rates (tip, delivery, blended tax rate) + customer/restaurant
// meta that Neon doesn't store. For a 2nd/3rd edit this is what makes the delta
// diff against the last Disco state instead of the stale FM order.
export interface OrderBaseline {
  source: 'neon' | 'fm' | 'mixed'
  items: FmOrderItem[]
  subtotal: number
  total: number
  tip: number
  delivery: number
  tax: number
  taxRate: number
  fee: number
  tipsRaw: number
  tipsType: string
  orderType: string
  orderDateIso: string
  orderTime: string
  orderNumber: string | number
  restaurantRef: string
  restaurantName: string
  customerEmail: string
  firstName: string
  lastName: string
  status: string
}

export async function loadOrderBaseline(ref: string, disco: DiscoOrderRow | null): Promise<OrderBaseline | null> {
  const details = await loadFmOrderDetails(ref)
  const fm = details ? parseFmOrder(details) : null

  // Neon current state (items + money) when the order is mirrored and has rows.
  let neonItems: FmOrderItem[] = []
  let neonSubtotal: number | null = null
  let neonTotal: number | null = null
  let neonFee: number | null = null
  if (disco) {
    const money = (await sql`SELECT subtotal, total, fee FROM disco_orders WHERE id = ${disco.id} LIMIT 1`
      .catch(() => [])) as { subtotal: string | null; total: string | null; fee: string | null }[]
    neonSubtotal = money[0]?.subtotal != null ? n(money[0].subtotal) : null
    neonTotal = money[0]?.total != null ? n(money[0].total) : null
    neonFee = money[0]?.fee != null ? n(money[0].fee) : null
    const rows = (await sql`
      SELECT meal_package_reference, name, quantity, price_per_unit, serves
      FROM disco_order_items WHERE order_id = ${disco.id} ORDER BY id
    `.catch(() => [])) as { meal_package_reference: string | null; name: string; quantity: number; price_per_unit: string; serves: number | null }[]
    neonItems = rows.map(r => ({ reference: s(r.meal_package_reference), name: r.name, price: n(r.price_per_unit), count: n(r.quantity), serves: r.serves ?? null }))
  }

  if (!fm && !disco) return null

  const items = neonItems.length ? neonItems : (fm?.items ?? [])
  const itemsSubtotal = Math.round(items.reduce((a, it) => a + n(it.price) * n(it.count), 0) * 100) / 100
  const subtotal = neonSubtotal ?? (fm ? fm.subtotal : itemsSubtotal) ?? itemsSubtotal
  const fee = neonFee ?? 0
  const tip = fm?.tip ?? 0
  const delivery = fm?.delivery ?? 0
  const total = neonTotal ?? (fm ? fm.total : subtotal + fee + tip + delivery)
  let taxRate = fm && fm.subtotal > 0 ? fm.tax / fm.subtotal : 0
  let tax = fm ? fm.tax : 0
  if (!fm) { tax = Math.max(0, total - subtotal - fee - tip - delivery); taxRate = subtotal > 0 ? tax / subtotal : 0 }

  return {
    source: neonItems.length && fm ? 'mixed' : (neonItems.length ? 'neon' : 'fm'),
    items, subtotal, total, tip, delivery, tax, taxRate, fee,
    tipsRaw: fm?.tipsRaw ?? n(disco?.tips), tipsType: fm?.tipsType || disco?.tips_type || 'PERCENTAGE',
    orderType: fm?.orderType || disco?.order_type || 'PICKUP',
    orderDateIso: disco ? String(disco.order_date).slice(0, 10) : (fm?.orderDateIso ?? ''),
    orderTime: disco ? disco.order_time : (fm?.orderTime ?? ''),
    orderNumber: fm?.orderNumber || disco?.order_number || '',
    restaurantRef: fm?.restaurantRef || disco?.restaurant_reference || '',
    restaurantName: fm?.restaurantName || disco?.restaurant_name || '',
    customerEmail: fm?.customerEmail || disco?.customer_email || '',
    firstName: fm?.firstName || disco?.customer_first_name || '',
    lastName: disco?.customer_last_name || '',
    status: disco?.order_status || fm?.status || '',
  }
}

export interface ApplyFmArgs {
  fmRef: string
  restaurantRef: string
  activeLines: { reference: string; quantity: number }[]
  orderDateIso: string
  orderTime: string
  orderType: string
  tips: number
  tipsType: string
}

// PUT the edited cart/date back to FM. Best-effort: returns { ok, status, body }
// and NEVER throws — Disco's Neon state is the source of truth.
export async function applyFmOrderUpdate(args: ApplyFmArgs): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const auth = await getFmServiceAuthHeader()
    const payload = {
      mealPackages: args.activeLines.map(l => ({ reference: l.reference, count: l.quantity })),
      orderDate: isoToFmDate(args.orderDateIso),
      orderTime: args.orderTime,
      orderType: args.orderType,
      restaurantReference: args.restaurantRef,
      tips: args.tips,
      tipsType: args.tipsType || 'PERCENTAGE',
      taxExempt: false,
    }
    const res = await fetch(`${FM}/public-api/v2/restaurants/${args.restaurantRef}/orders/${args.fmRef}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.text().catch(() => '')
    if (!res.ok) console.error('[order-edit] FM PUT failed', res.status, body.slice(0, 300))
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    console.error('[order-edit] FM PUT threw:', err instanceof Error ? err.message : err)
    return { ok: false, status: 0, body: '' }
  }
}

// Compute new totals from the edited lines using the original blended tax rate.
export function computeNewTotals(
  activeLines: { price: number; quantity: number }[],
  orig: { subtotal: number; total: number; tip: number; delivery: number; taxRate: number },
): { newSubtotal: number; newTaxAndFee: number; newTotal: number; delta: number } {
  const newSubtotal = Math.round(activeLines.reduce((a, l) => a + n(l.price) * n(l.quantity), 0) * 100) / 100
  const newTaxAndFee = Math.round(newSubtotal * orig.taxRate * 100) / 100
  const newTotal = Math.round((newSubtotal + newTaxAndFee + orig.delivery + orig.tip) * 100) / 100
  const delta = Math.round((newTotal - orig.total) * 100) / 100
  return { newSubtotal, newTaxAndFee, newTotal, delta }
}

// ── Apply a PAID pending edit (shared by the Stripe webhook invoice.paid handler
// and the edit-status route, which applies on page load if the invoice is paid).
// Mirrors the proposal stored in disco_orders.pending_edit_data: updates the
// order money/date/items, marks the edit succeeded, records the payment, syncs
// FM (best-effort), and emails the customer a confirmation. Callers must only
// invoke this when the invoice is paid. Sub-writes are best-effort.
function fmtDateHuman(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '')
  if (!m) return iso || ''
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
function fmtTimeHuman(t: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '')
  if (!m) return t || ''
  let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12
  return `${h}:${m[2]} ${ap}`
}

export async function applyPendingEdit(args: {
  orderId: number
  orderReference: string
  pending: Record<string, unknown>
  invoiceId: string
  paymentIntentId?: string | null
}): Promise<void> {
  const { orderId, orderReference, invoiceId } = args
  const p = args.pending || {}
  const lines = Array.isArray(p.activeLines)
    ? (p.activeLines as { reference: string; quantity: number; name?: string; price?: number }[])
    : []
  const orderDateIso = String(p.orderDateIso || '')
  const orderTime = String(p.orderTime || '')
  const restaurantRef = String(p.restaurantRef || '')
  const newTotal = typeof p.newTotal === 'number' ? p.newTotal : null

  // FM is read-only — Neon is the source of truth. The edit is applied to Neon
  // only; FM is never updated.

  // Apply the edit to disco_orders: new total/date/time, bump edit_count, clear pending.
  await sql`
    UPDATE disco_orders
    SET total = COALESCE(${newTotal}, total),
        order_date = COALESCE(${orderDateIso || null}::date, order_date),
        order_time = COALESCE(${orderTime || null}::time, order_time),
        edit_count = COALESCE(edit_count,0) + 1,
        edit_status = NULL, pending_edit_data = NULL, pending_edit_delta = NULL,
        pending_stripe_invoice_id = NULL, updated_at = NOW()
    WHERE id = ${orderId}
  `

  // Replace disco_order_items from the edited lines (best-effort).
  if (lines.length) {
    await sql`DELETE FROM disco_order_items WHERE order_id = ${orderId}`.catch(e => console.error('[applyPendingEdit] items delete:', e))
    for (const l of lines) {
      const unit = n(l.price); const qty = Math.max(1, Math.trunc(n(l.quantity) || 1))
      await sql`
        INSERT INTO disco_order_items (order_id, meal_package_reference, name, quantity, price_per_unit, total_price)
        VALUES (${orderId}, ${l.reference || null}, ${String(l.name || l.reference || 'Item')}, ${qty}, ${unit}, ${Math.round(unit * qty * 100) / 100})
      `.catch(e => console.error('[applyPendingEdit] item insert:', e))
    }
  }

  // Mark the pending edit row succeeded; record the invoice payment.
  await sql`UPDATE disco_order_edits SET payment_status = 'succeeded' WHERE stripe_invoice_id = ${invoiceId}`.catch(e => console.error('[applyPendingEdit] edit row:', e))
  if (restaurantRef) {
    await sql`
      INSERT INTO disco_stripe_payments (order_reference, restaurant_reference, stripe_payment_intent_id, status, total, created_at)
      VALUES (${orderReference}::uuid, ${restaurantRef}::uuid, ${args.paymentIntentId || invoiceId}, 'SUCCEEDED', ${newTotal}, NOW())
      ON CONFLICT (stripe_payment_intent_id) DO NOTHING
    `.catch(e => console.error('[applyPendingEdit] stripe_payment:', e))
  }
  await sql`
    INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
    VALUES (${orderReference}::uuid, 'ORDER_EDIT_CONFIRMED', ${JSON.stringify({ invoiceId, delta: p.delta, newTotal })}::jsonb, 'EDIT_APPLY')
  `.catch(e => console.error('[applyPendingEdit] event:', e))

  // Confirmation email (best-effort).
  const customerEmail = String(p.customerEmail || '')
  if (customerEmail) {
    sendOrderEditPaymentConfirmed({
      to: customerEmail, firstName: String(p.firstName || ''),
      orderNumber: String(p.orderNumber || ''), businessName: String(p.businessName || 'the restaurant'),
      orderDate: fmtDateHuman(orderDateIso), orderTime: fmtTimeHuman(orderTime),
      items: Array.isArray(p.newItems) ? (p.newItems as { count: number; name: string; price: number }[]) : undefined,
      newTotal: typeof p.newTotal === 'number' ? p.newTotal : undefined,
    }).catch(err => console.error('[applyPendingEdit] email:', err))
  }
}
