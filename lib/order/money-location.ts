// WHOSE MONEY IS IT? (Peter, 27 Oct 2026)
//
// An order's money is reported under the location whose Stripe account actually
// received it — not the location the order was later transferred to. A transfer
// moves the kitchen, calendar, order details, emails and courier to the new
// location; it moves no money (the payment already went to the old location's
// connected account). #900000724: $1,156.40 was paid to Son del North – West
// Village; LES prepares it. It counts in West Village's reports and payouts.
//
// THE RULE, for money reports only (Export Reports/CSV and the payout sheet,
// both dashboards, Super Admin money views):
//   - an order that was never transferred → its own location (unchanged);
//   - a transferred order → the location on its first successful payment
//     (disco_stripe_payments.restaurant_reference: whose connected account the
//     charge went to), else the location it was first transferred away from
//     (FamilyMeal-processed orders have no Disco payment row).
//
// The SQL below is the same expression each report query inlines (the Neon
// driver can't splice a fragment into a tagged template); keep them in step.
//
//   CASE WHEN EXISTS (SELECT 1 FROM disco_order_events te
//                      WHERE te.order_reference = o.reference AND te.event_type = 'TRANSFERRED')
//     THEN COALESCE(
//       (SELECT sp.restaurant_reference FROM disco_stripe_payments sp
//         WHERE sp.order_reference = o.reference AND sp.status = 'SUCCEEDED' AND sp.restaurant_reference IS NOT NULL
//         ORDER BY sp.created_at, sp.id LIMIT 1),
//       (SELECT (e.event_data->>'from_restaurant')::uuid FROM disco_order_events e
//         WHERE e.order_reference = o.reference AND e.event_type = 'TRANSFERRED'
//         ORDER BY e.created_at LIMIT 1),
//       o.restaurant_reference)
//     ELSE o.restaurant_reference END
//
// Known edge, not handled: an EDIT charged after a transfer is paid to the new
// location's account, but reports attribute the whole order to the paid-to
// location of its first payment. No real order has this today.
import { sql } from '../db'

export interface MoneyLocation {
  /** Location whose Stripe account received the order's money. */
  paidToReference: string
  paidToName: string
  /** Location that prepares the order now. */
  preparedByReference: string
  preparedByName: string
  /** True when they differ (the order was transferred after payment). */
  split: boolean
}

/** For one order's displays ("Paid to West Village, prepared by LES"). */
export async function loadMoneyLocation(orderRef: string): Promise<MoneyLocation | null> {
  const rows = (await sql`
    SELECT o.restaurant_reference::text AS prepared_ref,
           COALESCE(o.restaurant_name, pr.name, '') AS prepared_name,
           m.paid_ref::text AS paid_ref, COALESCE(pc.name, '') AS paid_name
      FROM disco_orders o
      CROSS JOIN LATERAL (SELECT CASE WHEN EXISTS (SELECT 1 FROM disco_order_events te
                                                    WHERE te.order_reference = o.reference AND te.event_type = 'TRANSFERRED')
        THEN COALESCE(
          (SELECT sp.restaurant_reference FROM disco_stripe_payments sp
            WHERE sp.order_reference = o.reference AND sp.status = 'SUCCEEDED' AND sp.restaurant_reference IS NOT NULL
            ORDER BY sp.created_at, sp.id LIMIT 1),
          (SELECT (e.event_data->>'from_restaurant')::uuid FROM disco_order_events e
            WHERE e.order_reference = o.reference AND e.event_type = 'TRANSFERRED'
            ORDER BY e.created_at LIMIT 1),
          o.restaurant_reference)
        ELSE o.restaurant_reference END AS paid_ref) m
      LEFT JOIN disco_restaurant_cache pc ON pc.restaurant_reference = m.paid_ref::text
      LEFT JOIN disco_restaurant_cache pr ON pr.restaurant_reference = o.restaurant_reference::text
     WHERE o.reference = ${orderRef}::uuid OR o.fm_order_reference = ${orderRef}::uuid
     LIMIT 1
  `.catch(() => [])) as Array<{ prepared_ref: string; prepared_name: string; paid_ref: string; paid_name: string }>
  const r = rows[0]
  if (!r) return null
  return {
    paidToReference: r.paid_ref, paidToName: r.paid_name,
    preparedByReference: r.prepared_ref, preparedByName: r.prepared_name,
    split: r.paid_ref !== r.prepared_ref,
  }
}

/** "Paid to West Village, prepared by LES" — or null when they're the same place. */
export function moneyLocationNote(m: MoneyLocation | null): string | null {
  if (!m || !m.split) return null
  return `Paid to ${m.paidToName || 'the original location'}, prepared by ${m.preparedByName || 'this location'}`
}
