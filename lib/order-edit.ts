// Shared helpers for the Disco-native order edit flow (edit route, edit-status
// route, and the Stripe invoice webhook). FM is reference-only — Disco owns the
// edit state in Neon.

import { sql } from './db'
import { getFmServiceAuthHeader } from './fm-service-auth'

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
    subtotal, total, tip, delivery, taxAndFee, taxRate, tipsRaw, tipsType,
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
