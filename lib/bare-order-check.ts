// Check C — bare-order display integrity (a standing check, not a one-off).
//
// A "bare" order (a disco_orders row with no disco_sale_transactions row) has
// no real per-component tax/tip/fee breakdown. Every display surface that
// reads one (Edit Order's money recompute, the PDF, notification emails) was
// fixed to show "Unavailable" rather than infer a figure via subtraction —
// see lib/order-edit.ts, lib/order/order-pdf.ts, lib/order-notifications.ts,
// lib/email/notifications.ts. That fix stops a bare order from ever *lying*,
// but a bare order sitting unrepaired is still a real gap: nobody notices it
// exists until they happen to open that one order. This scans for the
// population and alerts so a human repairs it (via
// lib/fm-orders-sync.ts's syncOrderDetail) before that happens — proactive,
// not reactive to a customer or restaurant hitting the blank.
//
// Scoped to NATIVE restaurants specifically. An FM order on an FM-backed
// restaurant staying bare is the pre-existing background sync hygiene the
// runbook already tracks (the hourly sync self-heals most of it) — not new
// here, and including it would make this alert fire constantly on a fleet
// this size. A bare order on a NATIVE restaurant is the population that
// actually surfaces to a real person through Disco's own UI (Edit Order, the
// restaurant portal, the customer confirmation) — that's the one worth a
// standing check.
import { sql } from './db'
import { alertOps } from './ops-alert'

export interface BareOrderFinding {
  orderNumber: string
  reference: string
  restaurantReference: string
  restaurantName: string | null
  sourceOfOrder: string | null
  createdAt: string
}

export async function findBareOrdersOnNativeRestaurants(): Promise<BareOrderFinding[]> {
  const rows = (await sql`
    SELECT o.order_number, o.reference, o.restaurant_reference, o.restaurant_name, o.source_of_order,
           o.created_at::text AS created_at
    FROM disco_orders o
    LEFT JOIN disco_sale_transactions t ON t.order_id = o.id
    JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference::text
    WHERE t.id IS NULL AND c.is_disco_native = true
    ORDER BY o.created_at DESC
  `.catch(() => [])) as {
    order_number: string | number; reference: string; restaurant_reference: string
    restaurant_name: string | null; source_of_order: string | null; created_at: string
  }[]
  return rows.map(r => ({
    orderNumber: String(r.order_number),
    reference: r.reference,
    restaurantReference: r.restaurant_reference,
    restaurantName: r.restaurant_name,
    sourceOfOrder: r.source_of_order,
    createdAt: r.created_at,
  }))
}

// Alerts (log + Slack, via alertOps) whenever the population is non-empty —
// every run, not just on change, so this can't go quiet by getting used to a
// standing count. Repair is a manual follow-up (syncOrderDetail per order);
// this only surfaces the gap, it never writes.
export async function checkBareOrderIntegrity(): Promise<{ count: number; findings: BareOrderFinding[] }> {
  const findings = await findBareOrdersOnNativeRestaurants()
  if (findings.length > 0) {
    await alertOps(
      `bare-order-check: ${findings.length} bare order(s) on native restaurant(s) — Edit Order/PDF/emails will show "Unavailable" for these until repaired`,
      { orders: findings.map(f => ({ orderNumber: f.orderNumber, restaurant: f.restaurantName, source: f.sourceOfOrder, createdAt: f.createdAt })) },
    )
  }
  return { count: findings.length, findings }
}
