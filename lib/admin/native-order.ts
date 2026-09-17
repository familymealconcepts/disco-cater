/**
 * Serving a Disco-native order to the SUPER_ADMIN portal.
 *
 * The admin Orders list already merges native orders in (app/api/admin/orders/
 * route.ts), shaped to FamilyMeal's UserOrderResponseDto field names so the two
 * classes of order can sit in one table. The per-order routes did not: they
 * forwarded to FM's /api/admin/userOrders/{ref}, and FM has no record of a
 * native order, so every one of them failed. This is the missing half.
 *
 * The shape here deliberately MATCHES the list route's native shaping field for
 * field, and adds the items and the money breakdown a detail view needs. Two
 * surfaces describing the same order differently is how the "3P Native" display
 * bug happened.
 */
import { sql } from '../db'
import { loadOrderItemsWithAddOns } from '../order-items'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function num(v: unknown): number { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : 0 }

interface Row {
  id: number
  orderReference: string
  restaurantReference: string
  restaurantName: string
  restaurantTimezone: string | null
  createdAtRaw: string | Date
  orderDate: string
  orderTime: string
  orderType: string
  orderStatus: string
  total: string | number
  subtotal: string | number | null
  fee: string | number | null
  refund: string | number | null
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  orderNumber: number | string
  deliveryType: string | null
  sourceoforder: string | null
  isDirectEntry: boolean | null
  deliveryAddressLine1: string | null
  deliveryAddressLine2: string | null
  deliveryCity: string | null
  deliveryState: string | null
  deliveryZip: string | null
  deliveryInstructions: string | null
  deliveryTimeWindow: string | null
  note: string | null
  companyName: string | null
  persons: number | null
  taxExemptId: string | null
  taxExemptState: string | null
}

interface Txn {
  service_charge: string | number | null
  state_tax: string | number | null
  local_tax: string | number | null
  other_tax: string | number | null
  tips_in_price: string | number | null
  third_party_delivery_tips: string | number | null
  own_delivery_fee: string | number | null
  third_party_delivery_fee: string | number | null
  discount: string | number | null
}

/**
 * The native order at `ref`, in the admin portal's shape — or null when `ref` is
 * not a native order (an FM order, or nothing at all), in which case the caller
 * keeps its existing FamilyMeal path.
 */
export async function loadNativeAdminOrder(ref: string): Promise<Record<string, unknown> | null> {
  if (!UUID_RE.test(ref)) return null
  try {
    const rows = (await sql`
      SELECT o.id,
             o.reference::text AS "orderReference",
             o.restaurant_reference::text AS "restaurantReference",
             COALESCE(o.restaurant_name, rc.name, '') AS "restaurantName",
             rc.timezone AS "restaurantTimezone",
             o.created_at AS "createdAtRaw",
             to_char(o.order_date, 'YYYY-MM-DD') AS "orderDate",
             o.order_time::text AS "orderTime",
             o.order_type AS "orderType", o.order_status AS "orderStatus",
             COALESCE(o.total, 0) AS total, o.subtotal, o.fee, COALESCE(o.refund, 0) AS refund,
             o.customer_first_name AS "firstName", o.customer_last_name AS "lastName",
             o.customer_email AS email, o.customer_phone AS phone,
             o.order_number AS "orderNumber", o.delivery_type AS "deliveryType",
             o.source_of_order AS sourceoforder, o.is_direct_entry AS "isDirectEntry",
             o.delivery_address_line1 AS "deliveryAddressLine1", o.delivery_address_line2 AS "deliveryAddressLine2",
             o.delivery_city AS "deliveryCity", o.delivery_state AS "deliveryState", o.delivery_zip AS "deliveryZip",
             o.delivery_instructions AS "deliveryInstructions", o.delivery_time_window AS "deliveryTimeWindow",
             o.note, o.company_name AS "companyName", o.persons,
             o.tax_exempt_id AS "taxExemptId", o.tax_exempt_state AS "taxExemptState"
        FROM disco_orders o
        -- rc is joined ONLY for display fields. Never add an is_live/visible/
        -- archived_at predicate: archiving a restaurant is not deleting its orders.
        LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
       WHERE o.reference = ${ref}::uuid AND o.fm_order_reference IS NULL AND o.is_deleted = false
       LIMIT 1
    `) as Row[]
    if (!rows.length) return null
    const r = rows[0]

    const items = await loadOrderItemsWithAddOns(r.id)
    const txnRows = (await sql`
      SELECT service_charge, state_tax, local_tax, other_tax, tips_in_price,
             third_party_delivery_tips, own_delivery_fee, third_party_delivery_fee, discount
        FROM disco_sale_transactions WHERE order_id = ${r.id} LIMIT 1
    `.catch(() => [])) as Txn[]
    const t = txnRows[0] ?? null

    const createdDate = r.createdAtRaw instanceof Date ? r.createdAtRaw.toISOString() : String(r.createdAtRaw ?? '')

    return {
      // FM's UserOrderResponseDto names the order's own reference `reference`;
      // the admin list normalizes that to orderReference. Emit BOTH so either
      // consumer works without a normalizer.
      reference: r.orderReference,
      orderReference: r.orderReference,
      restaurantReference: r.restaurantReference,
      restaurantName: r.restaurantName,
      restaurantTimezone: r.restaurantTimezone,
      createdDate,
      orderDate: r.orderDate,
      orderTime: r.orderTime,
      orderType: r.orderType,
      orderStatus: r.orderStatus,
      orderNumber: Number(r.orderNumber ?? 0),
      total: num(r.total),
      transactionsTotal: num(r.total),
      subtotal: num(r.subtotal),
      fee: num(r.fee),
      refund: num(r.refund),
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      userEmail: r.email,
      phone: r.phone,
      deliveryType: r.deliveryType,
      deliveryAddressLine1: r.deliveryAddressLine1,
      deliveryAddressLine2: r.deliveryAddressLine2,
      deliveryCity: r.deliveryCity,
      deliveryState: r.deliveryState,
      deliveryZip: r.deliveryZip,
      deliveryInstructions: r.deliveryInstructions,
      deliveryTimeWindow: r.deliveryTimeWindow,
      note: r.note,
      companyName: r.companyName,
      persons: r.persons,
      // taxExempt* drive the admin list's tax-exempt badge; carrying the raw
      // fields keeps the detail consistent with the row.
      taxExemptId: r.taxExemptId,
      taxExemptState: r.taxExemptState,
      taxExempt: !!r.taxExemptId,
      // The real column, never a hardcoded 'DISCO' — that hardcode is what
      // mislabeled genuinely-1P native orders as 3P in this very portal.
      sourceoforder: r.sourceoforder,
      isDirectEntry: r.isDirectEntry === true,
      native: true,
      // Same flat key names FM's OrderPublicResponseDto uses, so any consumer
      // that already reads FM's money fields reads these unchanged.
      ...(t ? {
        serviceCharge: num(t.service_charge),
        stateSalesTaxInPrice: num(t.state_tax),
        localSalesTaxInPrice: num(t.local_tax),
        otherSalesTaxInPrice: num(t.other_tax),
        tipsInPrice: num(t.tips_in_price),
        thirdPartyDeliveryTipsInPrice: num(t.third_party_delivery_tips),
        ownDeliveryFee: num(t.own_delivery_fee),
        thirdPartyDeliveryFee: num(t.third_party_delivery_fee),
        discount: num(t.discount),
      } : {}),
      orderMealPackages: items.map(it => ({
        reference: it.mealPackageReference || undefined,
        mealPackageReference: it.mealPackageReference || undefined,
        name: it.name,
        price: it.pricePerUnit,
        count: it.quantity,
        serves: it.serves ?? null,
        orderAddOns: it.addOns.length ? it.addOns.map(a => ({ name: a.name, price: a.price, count: a.quantity })) : undefined,
      })),
      orderClassics: [],
    }
  } catch (e) {
    console.error('[admin/native-order] load failed:', e instanceof Error ? e.message : e)
    return null
  }
}
