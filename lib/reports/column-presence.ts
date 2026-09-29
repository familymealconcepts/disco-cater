// Which report columns actually carry data for a restaurant — the evidence
// behind the "Basic" preset and the optional keep-this-tidy toggle.
//
// ── THE DISTINCTION THIS MODULE EXISTS TO PRESERVE ──────────────────────────
// buildOrderReportRows runs every money field through n(), which turns NULL into
// 0. After that, "this restaurant has no third-party delivery" and "FamilyMeal
// never sent us this field" are the same value — and they are not the same fact.
// Hiding a column on the second is asserting a zero that nobody measured.
//
// Measured on the live data:
//   · FM_SYNC has 983 NULL stripe_fee of 2,262 rows. FM's list endpoint does not
//     carry the fee; it lives in FM's own database.
//   · FM_BACKFILL, by contrast, carries REAL values — 7,274 non-zero service
//     charges, 1,760 non-zero third-party delivery fees, 22,977 of 22,981
//     non-zero Stripe fees. Its zeros are genuine zeros, so it IS judgeable.
//
// So the rule is not "which source wrote this row" but simply: a NULL anywhere
// in the window means the column cannot be judged, and an unjudgeable column is
// KEPT. That is the conservative direction — a redundant column is clutter, a
// missing one is a number the restaurant cannot see.
//
// STRIPE FEE IS NEVER HIDDEN, on Peter's ruling: every transaction has a Stripe
// fee, so a NULL there is always missing data and never a real zero. It is in
// NEVER_HIDE below rather than left to the NULL rule, so it stays hidden-proof
// even for a restaurant whose window happens to contain no NULLs.
import { sql } from '../db'

/**
 * Columns that are never hidden, whatever the data says.
 *
 * The spine (identity, dates, service) is what makes a row readable at all.
 * netSales / gross / totalDistributed are the report's reason for existing.
 * stripeFee is here on the ruling above. totalDistributed is additionally
 * force-included by native-reports.ts, and is repeated here so this module is
 * correct read on its own.
 */
export const NEVER_HIDE = new Set([
  'location', 'orderId', 'customerName', 'createdDate', 'serviceType', 'orderDate', 'orderTime',
  'netSales', 'gross', 'totalDistributed', 'stripeFee',
])

/**
 * A column is only proposed for hiding when the look-back window holds at least
 * this many orders. A restaurant with three orders has not demonstrated that it
 * never takes third-party delivery — it has demonstrated nothing.
 *
 * This is the guard for the 191 restaurants converted on 2026-09-29: most have
 * little or no native history, and for them the preset should return everything
 * rather than assert emptiness from a handful of rows.
 */
export const MIN_ORDERS_TO_JUDGE = 20

/** Look-back for the preset and the auto-tidy toggle. */
export const LOOKBACK_MONTHS = 12

export interface ColumnPresence {
  /** Column keys with at least one non-zero value in the window. */
  present: string[]
  /** Column keys that are judgeable AND entirely zero — safe to hide. */
  empty: string[]
  /**
   * Column keys that could NOT be judged: a NULL appeared, so absence and zero
   * are indistinguishable. Always treated as present.
   */
  unknown: string[]
  orders: number
  /** False when the window is too thin to conclude anything. */
  judged: boolean
  from: string
  to: string
}

/**
 * Per-column evidence over the look-back window.
 *
 * Reads the underlying columns directly rather than going through
 * buildOrderReportRows, precisely so the NULLs survive to be counted.
 */
export async function getColumnPresence(
  refs: string[],
  opts: { months?: number; now?: Date } = {},
): Promise<ColumnPresence> {
  const months = opts.months ?? LOOKBACK_MONTHS
  const now = opts.now ?? new Date()
  const to = new Date(now.getTime() - 86400000).toISOString().slice(0, 10)
  const fromD = new Date(now)
  fromD.setUTCMonth(fromD.getUTCMonth() - months)
  const from = fromD.toISOString().slice(0, 10)

  const clean = refs.filter(Boolean)
  if (!clean.length) {
    return { present: [], empty: [], unknown: [], orders: 0, judged: false, from, to }
  }

  const rows = (await sql`
    SELECT
      COUNT(*)::int AS orders,
      -- non-zero counts: is there evidence the restaurant uses this at all
      COUNT(*) FILTER (WHERE COALESCE(t.state_tax,0) <> 0)::int AS nz_stateTax,
      COUNT(*) FILTER (WHERE COALESCE(t.local_tax,0) <> 0)::int AS nz_localTax,
      COUNT(*) FILTER (WHERE COALESCE(t.other_tax,0) <> 0)::int AS nz_otherTax,
      COUNT(*) FILTER (WHERE COALESCE(t.own_delivery_fee,0) <> 0)::int AS nz_selfDeliveryFee,
      COUNT(*) FILTER (WHERE COALESCE(t.third_party_delivery_fee,0) <> 0)::int AS nz_thirdPartyDeliveryFee,
      COUNT(*) FILTER (WHERE COALESCE(t.service_charge,0) <> 0)::int AS nz_serviceCharge,
      COUNT(*) FILTER (WHERE COALESCE(t.discount,0) <> 0)::int AS nz_discount,
      COUNT(*) FILTER (WHERE COALESCE(t.lead_gen_one_disco_fee,0) <> 0)::int AS nz_leadGenOne,
      COUNT(*) FILTER (WHERE COALESCE(t.lead_gen_two_disco_fee,0) <> 0)::int AS nz_leadGenTwo,
      COUNT(*) FILTER (WHERE COALESCE(o.refund,0) <> 0)::int AS nz_refundAmount,
      COUNT(*) FILTER (WHERE COALESCE(t.third_party_delivery_subsiding,0) <> 0)::int AS nz_thirdPartySubsidy,
      COUNT(*) FILTER (WHERE COALESCE(t.tips_in_price,0) <> 0
                         AND COALESCE(o.delivery_type,'PICKUP') = 'PICKUP')::int AS nz_tipPickup,
      COUNT(*) FILTER (WHERE COALESCE(t.tips_in_price,0) <> 0
                         AND COALESCE(o.delivery_type,'PICKUP') = 'OWN_DELIVERY')::int AS nz_tipSelfDelivery,
      COUNT(*) FILTER (WHERE (COALESCE(t.third_party_delivery_tips,0) <> 0
                              OR (COALESCE(t.tips_in_price,0) <> 0
                                  AND COALESCE(o.delivery_type,'PICKUP') NOT IN ('PICKUP','OWN_DELIVERY'))))::int AS nz_tipThirdPartyDelivery,
      -- NULL counts: the field was absent, so zero cannot be concluded
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.state_tax IS NULL)::int AS null_stateTax,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.local_tax IS NULL)::int AS null_localTax,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.other_tax IS NULL)::int AS null_otherTax,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.own_delivery_fee IS NULL)::int AS null_selfDeliveryFee,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.third_party_delivery_fee IS NULL)::int AS null_thirdPartyDeliveryFee,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.service_charge IS NULL)::int AS null_serviceCharge,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.discount IS NULL)::int AS null_discount,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.lead_gen_one_disco_fee IS NULL)::int AS null_leadGenOne,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.lead_gen_two_disco_fee IS NULL)::int AS null_leadGenTwo,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.third_party_delivery_subsiding IS NULL)::int AS null_thirdPartySubsidy,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.tips_in_price IS NULL)::int AS null_tips,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t.third_party_delivery_tips IS NULL)::int AS null_tpTips,
      -- an order with NO transaction row at all tells us nothing about any field
      COUNT(*) FILTER (WHERE t.id IS NULL)::int AS bare_orders
    FROM disco_orders o
    LEFT JOIN disco_sale_transactions t
      ON t.order_id = o.id AND t.transaction_type = 'ORIGINAL'
    WHERE o.restaurant_reference = ANY(${clean}::uuid[])
      AND o.is_deleted = false
      AND o.order_date BETWEEN ${from}::date AND ${to}::date
  `.catch(() => [])) as Record<string, number>[]

  const r = rows[0]
  const orders = Number(r?.orders ?? 0)
  const judged = orders >= MIN_ORDERS_TO_JUDGE

  // Every column that can be judged at all, with its evidence.
  const CANDIDATES: { key: string; nz: string; nulls: string[] }[] = [
    { key: 'stateTax', nz: 'nz_statetax', nulls: ['null_statetax'] },
    { key: 'localTax', nz: 'nz_localtax', nulls: ['null_localtax'] },
    { key: 'otherTax', nz: 'nz_othertax', nulls: ['null_othertax'] },
    { key: 'selfDeliveryFee', nz: 'nz_selfdeliveryfee', nulls: ['null_selfdeliveryfee'] },
    { key: 'thirdPartyDeliveryFee', nz: 'nz_thirdpartydeliveryfee', nulls: ['null_thirdpartydeliveryfee'] },
    { key: 'serviceCharge', nz: 'nz_servicecharge', nulls: ['null_servicecharge'] },
    { key: 'discount', nz: 'nz_discount', nulls: ['null_discount'] },
    { key: 'leadGenOne', nz: 'nz_leadgenone', nulls: ['null_leadgenone'] },
    { key: 'leadGenTwo', nz: 'nz_leadgentwo', nulls: ['null_leadgentwo'] },
    { key: 'refundAmount', nz: 'nz_refundamount', nulls: [] },
    { key: 'thirdPartySubsidy', nz: 'nz_thirdpartysubsidy', nulls: ['null_thirdpartysubsidy'] },
    { key: 'tipPickup', nz: 'nz_tippickup', nulls: ['null_tips'] },
    { key: 'tipSelfDelivery', nz: 'nz_tipselfdelivery', nulls: ['null_tips'] },
    { key: 'tipThirdPartyDelivery', nz: 'nz_tipthirdpartydelivery', nulls: ['null_tips', 'null_tptips'] },
  ]

  // An order carrying no transaction row at all is evidence about nothing, so it
  // makes EVERY money column unjudgeable rather than silently counting as zero.
  const bare = Number(r?.bare_orders ?? 0)

  const present: string[] = []
  const empty: string[] = []
  const unknown: string[] = []
  for (const c of CANDIDATES) {
    const nz = Number(r?.[c.nz] ?? 0)
    const nulls = c.nulls.reduce((a, k) => a + Number(r?.[k] ?? 0), 0) + bare
    if (nz > 0) present.push(c.key)
    else if (nulls > 0 || !judged) unknown.push(c.key)
    else empty.push(c.key)
  }

  return { present, empty, unknown, orders, judged, from, to }
}

/**
 * The Basic column set: every catalogue column except the ones proven empty.
 * Order is preserved from the catalogue so the sheet reads the same as always.
 */
export function basicColumnSet(allKeys: string[], presence: ColumnPresence): string[] {
  if (!presence.judged) return [...allKeys]
  const drop = new Set(presence.empty.filter(k => !NEVER_HIDE.has(k)))
  return allKeys.filter(k => !drop.has(k))
}
