import { sql } from './db'

// The single, canonical way to load an order's line items together with
// their per-item add-ons. Before this existed, disco_order_items got
// queried independently — without joining disco_order_item_addons — in five
// separate places (the order PDF, the restaurant portal's order popout, the
// confirmation emails, the reminder emails, the diner order-status page, and
// the native "Order Counts" export), plus a sixth that's worse than a
// display bug: the Edit Order save path deletes and recreates
// disco_order_items on every save without ever touching
// disco_order_item_addons, silently orphaning (not deleting — the rows
// survive, just disconnected from any current item) the add-on money on any
// order that gets edited. An item whose real price lives entirely on an
// add-on (base price_per_unit priced at $0.00, e.g. order #900000086's
// "jojos") showed as "$0.00" against a real subtotal wherever the join was
// missing. Every consumer of an order's line items should call this instead
// of re-querying disco_order_items directly.
function num(v: unknown): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

export interface OrderItemAddOn {
  id: number
  name: string
  price: number
  quantity: number
}

export interface OrderItemWithAddOns {
  id: number
  mealPackageReference: string | null
  name: string
  quantity: number
  pricePerUnit: number
  notes: string | null
  serves: string | null
  addOns: OrderItemAddOn[]
}

export async function loadOrderItemsWithAddOns(orderId: number): Promise<OrderItemWithAddOns[]> {
  const items = (await sql`
    SELECT id, meal_package_reference, name, quantity, price_per_unit, notes, serves
    FROM disco_order_items WHERE order_id = ${orderId} ORDER BY id
  `) as Record<string, unknown>[]

  const itemIds = items.map((it) => Number(it.id)).filter((n) => Number.isFinite(n))
  const addonRows = itemIds.length
    ? ((await sql`
        SELECT id, order_item_id, name, price, quantity FROM disco_order_item_addons
        WHERE order_item_id = ANY(${itemIds}) ORDER BY id
      `.catch(() => [])) as Record<string, unknown>[])
    : []
  const addOnsByItem = new Map<number, OrderItemAddOn[]>()
  for (const a of addonRows) {
    const key = Number(a.order_item_id)
    const list = addOnsByItem.get(key) ?? []
    list.push({
      id: Number(a.id), name: String(a.name ?? 'Add-on'), price: num(a.price),
      quantity: Math.max(1, Math.trunc(num(a.quantity)) || 1),
    })
    addOnsByItem.set(key, list)
  }

  return items.map((it) => ({
    id: Number(it.id),
    mealPackageReference: it.meal_package_reference ? String(it.meal_package_reference) : null,
    name: String(it.name ?? ''),
    quantity: Math.max(1, Math.trunc(num(it.quantity)) || 1),
    pricePerUnit: num(it.price_per_unit),
    notes: it.notes ? String(it.notes) : null,
    serves: it.serves ? String(it.serves) : null,
    addOns: addOnsByItem.get(Number(it.id)) ?? [],
  }))
}
