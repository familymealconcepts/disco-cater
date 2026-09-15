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
import { alertOnce } from './ops-alert'

export interface BareOrderFinding {
  orderNumber: string
  reference: string
  restaurantReference: string
  restaurantName: string | null
  sourceOfOrder: string | null
  createdAt: string
  /** The delivery/pickup date — what decides whether this is still actionable. */
  orderDate: string | null
}

export async function findBareOrdersOnNativeRestaurants(): Promise<BareOrderFinding[]> {
  const rows = (await sql`
    SELECT o.order_number, o.reference, o.restaurant_reference, o.restaurant_name, o.source_of_order,
           o.created_at::text AS created_at, o.order_date::text AS order_date
    FROM disco_orders o
    LEFT JOIN disco_sale_transactions t ON t.order_id = o.id
    JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference::text
    WHERE t.id IS NULL AND c.is_disco_native = true
    ORDER BY o.created_at DESC
  `.catch(() => [])) as {
    order_number: string | number; reference: string; restaurant_reference: string
    restaurant_name: string | null; source_of_order: string | null; created_at: string
    order_date: string | null
  }[]
  return rows.map(r => ({
    orderNumber: String(r.order_number),
    reference: r.reference,
    restaurantReference: r.restaurant_reference,
    restaurantName: r.restaurant_name,
    sourceOfOrder: r.source_of_order,
    createdAt: r.created_at,
    orderDate: r.order_date,
  }))
}

// ── WHAT THIS ALERTS ON, AND WHY IT IS NOT THE WHOLE POPULATION ───────────────
// It alerts ONLY on bare orders whose date is TODAY OR LATER. That is the set a
// restaurant still has to cook and cannot see properly, which is the only part
// of this that anyone can act on.
//
// The historical set is deliberately excluded. An FM-backed order that is not
// editable in Disco is EXPECTED, and it resolves itself as restaurants
// transition — it is a migration state, not a fault. Measured 2026-09-15 there
// were 192 bare orders in total and only 16 dated today or later, so alerting
// on the full population meant 176 rows of noise carrying the 16 that mattered,
// every hour, as raw JSON across several Slack messages. That is how a channel
// stops being read on its first day.
//
// NO RAW JSON, EVER. Slack gets a count, the worst few restaurants and a date
// range. The per-order detail stays in the return value for the Vercel log and
// for any caller that wants it — a chat message is not a data export.
//
// alertOnce keyed on the SET of actionable orders, so the alert fires when the
// set changes and stays silent while it does not. A new bare order tomorrow
// raises a new alert; the same sixteen at 11am do not raise a seventeenth.
export async function checkBareOrderIntegrity(): Promise<{
  count: number
  actionableCount: number
  findings: BareOrderFinding[]
  actionable: BareOrderFinding[]
  alerted: boolean
}> {
  const findings = await findBareOrdersOnNativeRestaurants()

  const today = new Date().toISOString().slice(0, 10)
  const actionable = findings.filter(f => (f.orderDate ?? '') >= today)

  let alerted = false
  if (actionable.length > 0) {
    // Worst few restaurants by count — enough to see where to look, not a dump.
    const byRestaurant = new Map<string, number>()
    for (const f of actionable) {
      const k = f.restaurantName || f.restaurantReference
      byRestaurant.set(k, (byRestaurant.get(k) ?? 0) + 1)
    }
    const worst = [...byRestaurant.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, n]) => `${name} (${n})`)
      .join(', ')

    const dates = actionable.map(f => f.orderDate).filter(Boolean).sort()
    const range = dates.length ? `${dates[0]} … ${dates[dates.length - 1]}` : 'unknown'

    // The key is the sorted set of affected order numbers: same set, no repeat;
    // one new bare order, new alert.
    const key = `bare-orders:${actionable.map(f => f.orderNumber).sort().join(',')}`

    alerted = await alertOnce(
      key,
      `bare-order-check: ${actionable.length} upcoming order(s) on native restaurants are missing their sale transaction — ` +
      `Edit Order / PDF / emails show "Unavailable" and the restaurant cannot see what to cook. ` +
      `Restaurants: ${worst}. Dates: ${range}.` +
      (findings.length > actionable.length
        ? ` (${findings.length - actionable.length} older bare order(s) exist and are expected during the FM transition — not alerted.)`
        : ''),
      { actionableCount: actionable.length, totalBare: findings.length, dateRange: range },
    )
  }

  return { count: findings.length, actionableCount: actionable.length, findings, actionable, alerted }
}
