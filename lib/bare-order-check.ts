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
import { alertGroup, syncAlertSet, openAlertKeys } from './ops-alert'
import { formatDay, orderLink } from './ops-alert-format'

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
    -- FM_LIST is the PROVISIONAL row written at insert (lib/fm-orders-sync.ts's
    -- writeProvisionalSaleTransaction): it carries subtotal/total/fee so the
    -- financial report is never silently understated, but it still has no
    -- per-component tax/tip breakdown and no items. That is exactly the gap this
    -- check exists to surface, so it must keep counting as bare — otherwise
    -- adding the provisional row would have silenced this alert rather than
    -- fixed anything.
    WHERE (t.id IS NULL OR t.source = 'FM_LIST') AND c.is_disco_native = true
    ORDER BY o.created_at DESC
  `) as {
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
// ONE KEY PER ORDER (bare-order:<ref>), posted grouped by restaurant, and each
// closed in its thread when it gets its items (or its date passes). The query
// above has NO .catch(() => []) for that reason: a failed read that looked like
// "no bare orders" would close every open thread. It throws, and the cron's
// job-failure alert says the check is down instead.
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
  const byRestaurant = new Map<string, BareOrderFinding[]>()
  for (const f of actionable) {
    const k = f.restaurantReference
    byRestaurant.set(k, [...(byRestaurant.get(k) ?? []), f])
  }
  for (const group of byRestaurant.values()) {
    const fresh = await alertGroup(group.map(f => ({ ...f, key: `bare-order:${f.reference.toLowerCase()}` })), items => {
      const name = items[0].restaurantName || items[0].restaurantReference
      const list = items.slice(0, 10).map(f => `#${f.orderNumber}${f.orderDate ? `, for ${formatDay(f.orderDate)}` : ''}`).join('; ')
      return {
        severity: 'warn',
        headline: `${items.length} upcoming order${items.length === 1 ? ' has' : 's have'} no line items — ${name}`,
        lines: [`${list}${items.length > 10 ? `; and ${items.length - 10} more` : ''}. Edit Order, the PDF and emails show "Unavailable", so the restaurant can't see what to cook.`],
        action: `re-sync the order${items.length === 1 ? "'s" : "s'"} items from FamilyMeal.`,
        link: items.length === 1 ? orderLink(items[0].reference, items[0].orderNumber) : undefined,
        context: { refs: items.map(f => f.reference), olderBare: findings.length - actionable.length },
      }
    })
    if (fresh.length) alerted = true
  }
  const stillBare = new Set(findings.map(f => f.reference.toLowerCase()))
  const openRefs = (await openAlertKeys('bare-order:')).map(k => k.slice('bare-order:'.length))
  const numbers = openRefs.length ? (await sql`
    SELECT LOWER(reference::text) AS ref, order_number::text AS n FROM disco_orders WHERE reference::text = ANY(${openRefs})
  `.catch(() => [])) as Array<{ ref: string; n: string }> : []
  const numberOf = new Map(numbers.map(r => [r.ref, r.n]))
  await syncAlertSet('bare-order:', actionable.map(f => `bare-order:${f.reference.toLowerCase()}`), key => {
    const ref = key.slice('bare-order:'.length)
    return stillBare.has(ref)
      ? `#${numberOf.get(ref) ?? ref}'s date has passed, so this is closed.`
      : `Resolved: #${numberOf.get(ref) ?? ref} has its items now.`
  })

  return { count: findings.length, actionableCount: actionable.length, findings, actionable, alerted }
}
