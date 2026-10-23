// "Paid order missing from Disco": a FamilyMeal-placed order whose card was
// charged but which never reached disco_orders, so no confirmation and no
// courier. Keyed on the FamilyMeal order reference, and closed by the hourly
// sync-fm-orders run once the order is in Disco (its DISCO-order backfill sends
// the confirmations then).
import { sql } from '../db'
import { alertOnce, openAlertKeys, resolveAlert } from '../ops-alert'
import { money } from '../ops-alert-format'
import { restaurantName } from '../ops-alert-facts'

const key = (ref: string) => `order-missing:${ref.trim().toLowerCase()}`

export async function alertPaidOrderMissing(
  fmReference: string | null | undefined,
  info: { orderNumber?: string | null; restaurantReference?: string | null; total?: number | null; why?: string | null },
): Promise<void> {
  const name = await restaurantName(info.restaurantReference)
  const parts = [name, info.total != null && Number.isFinite(Number(info.total)) ? money(info.total) : null].filter(Boolean)
  const lines = [
    parts.join(' · '),
    'The card was charged but Disco has no record of the order yet, so no confirmation went out and no courier was booked. The hourly FamilyMeal sync usually recovers it and sends the confirmation then.',
  ]
  if (!info.orderNumber) lines.push("FamilyMeal didn't return an order number.")
  await alertOnce(key(fmReference || `n${info.orderNumber ?? 'unknown'}`), {
    severity: 'urgent',
    headline: info.orderNumber ? `Paid order missing from Disco — order #${info.orderNumber}` : 'Paid order missing from Disco',
    lines,
    action: "if it's not resolved within the hour, find the order in FamilyMeal.",
    context: { fmReference, ...info },
  })
}

export async function resolveMissingOrderAlerts(): Promise<void> {
  const keys = await openAlertKeys('order-missing:')
  const refs = keys.map(k => k.slice('order-missing:'.length)).filter(r => /^[0-9a-f-]{36}$/.test(r))
  if (!refs.length) return
  const found = (await sql`
    SELECT LOWER(COALESCE(fm_order_reference::text, reference::text)) AS a, LOWER(reference::text) AS b
      FROM disco_orders
     WHERE fm_order_reference::text = ANY(${refs}) OR reference::text = ANY(${refs})
  `.catch(() => [])) as Array<{ a: string; b: string }>
  const there = new Set(found.flatMap(r => [r.a, r.b]))
  for (const r of refs) {
    if (there.has(r)) await resolveAlert(key(r), 'Resolved: the sync recorded it and sent the confirmations.')
  }
}
