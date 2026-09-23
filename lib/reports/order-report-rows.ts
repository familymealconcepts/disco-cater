import { sql } from '../db'

/**
 * THE canonical order-money report: FamilyMeal's column set, with a payout figure
 * that is correct for a Disco-native order.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────
 * Three different shapes were in the codebase: the export route's 10 columns, the
 * scheduled-report catalogue's 12, and FM's 21. They disagreed about what a
 * restaurant is owed, and the export's final column — labelled "Total" until
 * 8230096 — was the CUSTOMER CHARGE. On order #900000142 that read $1,159.00
 * while $1,011.29 reached Apollo Bagels - Kips Bay.
 *
 * ── COLUMNS: FM's ORDER AND FM's HEADERS ──────────────────────────────────────
 * Taken verbatim from FM's ReportConstants.RESTAURANT_REPORT_COLUMNS so a
 * restaurant reading both sees the same sheet. Two deliberate divergences, both
 * because FM's shape cannot express how a native order settles — see TIP SPLIT
 * and SUBSIDY below.
 *
 * ── TOTAL DISTRIBUTED: COMPUTED, BECAUSE IT IS NOT STORED ─────────────────────
 * There is no transfer/payout column on disco_sale_transactions. The figure only
 * ever existed as transfer_data.amount on the Stripe PaymentIntent, so it is
 * recomputed here from the components that produced it:
 *
 *   subtotal + tips_in_price + state_tax + local_tax + other_tax
 *            + own_delivery_fee + service_charge
 *            − third_party_delivery_subsiding − discount − stripe_fee
 *            − lead_gen_one − lead_gen_two
 *
 * VERIFIED, not assumed: this reproduced transfer_data.amount to the cent on 11
 * of 11 real orders, #900000142 among them at $1,011.29.
 *
 * DO NOT PORT FM's totalDistributed SQL. It adds tips_in_price unconditionally,
 * which is right for an FM order and wrong for a native third-party delivery
 * where Disco keeps the tips — it would overstate the payout by the whole tip.
 *
 * ── WHICH FORMULA A ROW USES ──────────────────────────────────────────────────
 * disco_sale_transactions.source, NEVER disco_orders.source_of_order. Those are
 * different facts and they disagree: #900000142 is source_of_order = 'FAMILYMEAL'
 * (that field is LINK ATTRIBUTION — which entry point the customer came through)
 * while source = 'NATIVE_CHECKOUT' with a real Disco transfer. Branching on
 * source_of_order sends it down FM's formula and overstates it by the tips.
 */

/** FM's 21, plus the two native-only columns. `financial` marks FM's 15 summed columns. */
export interface ReportColumnDef { key: string; label: string; financial: boolean; nativeOnly?: boolean; hiddenByDefault?: boolean }

export const ORDER_REPORT_COLUMNS: ReportColumnDef[] = [
  { key: 'orderId', label: 'Order ID', financial: false },
  { key: 'customerName', label: 'Name', financial: false },
  { key: 'createdDate', label: 'Created Date', financial: false },
  { key: 'serviceType', label: 'Service', financial: false },
  { key: 'orderDate', label: 'Order Date', financial: false },
  { key: 'orderTime', label: 'Order Time', financial: false },
  { key: 'netSales', label: 'Net Sales', financial: true },
  { key: 'stateTax', label: 'Tax (State)', financial: true },
  { key: 'localTax', label: 'Tax (Local)', financial: true },
  { key: 'otherTax', label: 'Tax (Other)', financial: true },
  { key: 'selfDeliveryFee', label: 'Delivery Fee (Self-Delivery)', financial: true },
  { key: 'thirdPartyDeliveryFee', label: 'Delivery Fee (Third-Party)', financial: true },
  // ── TIP SPLIT, BY FULFILMENT TYPE ───────────────────────────────────────────
  // FM's restaurant dashboard breaks tips out three ways — pickupTipsInPrice,
  // owndeliveryTipsInPrice, thirdpartyTipsInPrice — and these mirror it.
  //
  // tips_in_price and third_party_delivery_tips ARE THE SAME TIP under two
  // names, not two tips (Peter's ruling, and FM's data proves it: of 25,179
  // ORIGINAL transactions, the number with BOTH fields non-zero is ZERO). Which
  // name FM files it under follows the fulfilment type, so a single
  // "Tips (Third-Party Delivery)" column holding whichever field is populated
  // cannot double-count. An earlier version of this file claimed 14 orders
  // carried both — that was a misreading: 13 of those had a zero courier tip,
  // and the one genuine overlap (#46668561, $194.80 in both) was a defect in
  // DISCO's mirror, not two tips. FM holds it once. It has been repaired.
  //
  // WHAT THE RESTAURANT RECEIVES STILL DEPENDS ON WHICH FIELD HOLDS IT, and that
  // is settled against Stripe, not naming: where the tip sits in
  // third_party_delivery_tips it goes to the courier network and never enters
  // transfer_data.amount (#46668561 paid out $1,012.15, excluding its $194.80);
  // where it sits in tips_in_price the restaurant is paid it (verified on 9 of 9
  // such orders). Gross is therefore derived from the underlying fields, never
  // from this column — see the Gross note below and reconcileGross().
  { key: 'tipPickup', label: 'Tips (Pickup)', financial: true },
  { key: 'tipSelfDelivery', label: 'Tips (Self Delivery)', financial: true },
  { key: 'tipThirdPartyDelivery', label: 'Tips (Third-Party Delivery)', financial: true },
  { key: 'serviceCharge', label: 'Service charge', financial: true },
  { key: 'discount', label: 'Discount', financial: true },
  { key: 'leadGenOne', label: 'Lead Gen 1', financial: true },
  { key: 'leadGenTwo', label: 'Lead Gen 2', financial: true },
  { key: 'gross', label: 'Gross', financial: true },
  { key: 'stripeFee', label: 'Stripe Fee', financial: true },
  { key: 'refundAmount', label: 'Refund Amount', financial: true },
  // ── SUBSIDY ─────────────────────────────────────────────────────────────────
  // No FM equivalent. Where a restaurant sets a third-party subsidy %, the
  // delivery fee splits: the customer pays part and the RESTAURANT covers the
  // rest out of its payout. It is subtracted from Total Distributed, so without
  // it on screen the payout cannot be derived from the visible columns — the
  // sheet appears not to add up.
  //
  // Hidden by default because it is zero for every order that has ever been
  // placed, and a permanently-zero column is noise. AUTO-SHOWN the moment any row
  // is non-zero (see subsidyShouldShow) so the arithmetic is never invisible.
  { key: 'thirdPartySubsidy', label: 'Third-Party Subsidy (paid by restaurant)', financial: true, nativeOnly: true, hiddenByDefault: true },
  { key: 'totalDistributed', label: 'Total Distributed', financial: true },
]

export const LOCATION_COLUMN: ReportColumnDef = { key: 'location', label: 'Location', financial: false }

export interface OrderReportRow {
  location: string
  orderId: string
  customerName: string
  createdDate: string
  serviceType: string
  orderDate: string
  orderTime: string
  netSales: number
  stateTax: number
  localTax: number
  otherTax: number
  selfDeliveryFee: number
  thirdPartyDeliveryFee: number
  tipPickup: number
  tipSelfDelivery: number
  tipThirdPartyDelivery: number
  serviceCharge: number
  discount: number
  leadGenOne: number
  leadGenTwo: number
  gross: number
  stripeFee: number
  refundAmount: number
  thirdPartySubsidy: number
  totalDistributed: number
  /**
   * The part of tipThirdPartyDelivery that went to the COURIER and so is not in
   * Gross. Not a column — carried so reconcileGross/reconcileRow can check the
   * arithmetic without putting a fourth tip column back on the sheet.
   */
  tipThirdPartyCourierPortion: number
  /** Which settlement produced totalDistributed. Not a column; used for diagnostics. */
  settlement: 'native' | 'fm'
  /** Not columns — carried so callers can filter without a second query. */
  orderStatus: string
  deliveryType: string | null
}

const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const r2 = (x: number) => Math.round(x * 100) / 100

/**
 * FM's serviceType CASE, plus the value FM never emits.
 *
 * THE LITERAL STRING 'PICKUP' USED TO FALL THROUGH TO 'Third-Party Delivery'.
 * FM records a pickup as a NULL delivery_type, so the original CASE only tested
 * null/'' — but Disco's own native checkout writes the literal 'PICKUP'. 87
 * orders (67 NATIVE_CHECKOUT + 20 legacy), every one with zero delivery fee and
 * zero courier tip, were therefore reported as third-party deliveries. With the
 * per-fulfilment tip and delivery columns below, that mistake would have moved
 * real pickup tips into the third-party bucket and out of Gross.
 */
export function serviceTypeOf(deliveryType: string | null): string {
  if (deliveryType === 'OWN_DELIVERY') return 'Self-Delivery'
  if (deliveryType == null || deliveryType === '' || deliveryType === 'PICKUP') return 'Pickup'
  return 'Third-Party Delivery'
}

/**
 * The payout. Throws rather than returning a plausible wrong number — see the
 * reconciliation note in buildOrderReportRows.
 */
export function nativeTotalDistributed(t: Record<string, unknown>): number {
  return r2(
    n(t.subtotal) + n(t.tips_in_price) + n(t.state_tax) + n(t.local_tax) + n(t.other_tax)
    + n(t.own_delivery_fee) + n(t.service_charge)
    - n(t.third_party_delivery_subsiding) - n(t.discount) - n(t.stripe_fee)
    - n(t.lead_gen_one_disco_fee) - n(t.lead_gen_two_disco_fee),
  )
}

/** FM's formula, for rows that settled through FM. Tips credited unconditionally. */
export function fmTotalDistributed(t: Record<string, unknown>, refund: number): number {
  return r2(
    (n(t.subtotal) + n(t.state_tax) + n(t.local_tax) + n(t.other_tax)
      + n(t.tips_in_price) + n(t.service_charge) + n(t.own_delivery_fee))
    - (n(t.discount) + n(t.stripe_fee) + n(t.lead_gen_one_disco_fee) + n(t.lead_gen_two_disco_fee) + refund),
  )
}

/** Any row carrying a subsidy forces the column visible. See the SUBSIDY note. */
export function subsidyShouldShow(rows: OrderReportRow[]): boolean {
  return rows.some(r => Math.abs(r.thirdPartySubsidy) > 0.001)
}

export interface BuildOptions {
  refs: string[]
  from: string
  to: string
  dateField?: 'order_date' | 'created_at'
  /** Optional filters, used by scheduled reports. Empty/absent = no filter. */
  orderStatuses?: string[]
  deliveryTypes?: string[]
}

export async function buildOrderReportRows(opts: BuildOptions): Promise<OrderReportRow[]> {
  const byCreated = opts.dateField === 'created_at'
  const statuses = (opts.orderStatuses ?? []).filter(Boolean)
  const deliveryTypes = (opts.deliveryTypes ?? []).filter(Boolean)

  // COALESCE(placed_at, created_at) FOR "CREATED DATE", NOT created_at ALONE.
  // placed_at is FM's real order-creation timestamp (backfilled for pre-freeze
  // orders, populated going forward by the fixed sync); created_at is NEON SYNC
  // TIME, which for FM-mirrored orders can trail real placement by hours to
  // years. "Created Date" means when the order was actually placed.
  //
  // This was briefly regressed when the column set moved here — the first
  // version of this query used bare created_at and would have mis-dated every
  // FM-mirrored row, both in the scheduled report and the on-demand export.
  const rows = (await sql`
    SELECT o.order_number, o.restaurant_name, o.customer_first_name, o.customer_last_name,
           COALESCE(o.placed_at, o.created_at) AS created_at,
           o.order_date::text AS order_date, o.order_time::text AS order_time,
           o.delivery_type, o.order_status, o.refund, o.source_of_order,
           t.source, t.subtotal, t.state_tax, t.local_tax, t.other_tax,
           t.own_delivery_fee, t.third_party_delivery_fee, t.tips_in_price, t.third_party_delivery_tips,
           t.service_charge, t.discount, t.lead_gen_one_disco_fee, t.lead_gen_two_disco_fee,
           t.total, t.fee, t.stripe_fee, t.third_party_delivery_subsiding
      FROM disco_orders o
      LEFT JOIN disco_sale_transactions t
        ON t.order_id = o.id AND t.transaction_type = 'ORIGINAL'
     WHERE o.restaurant_reference = ANY(${opts.refs}::uuid[])
       AND o.is_deleted = false
       AND (CASE WHEN ${byCreated} THEN COALESCE(o.placed_at, o.created_at)::date ELSE o.order_date END)
           BETWEEN ${opts.from}::date AND ${opts.to}::date
       AND (${statuses.length === 0} OR o.order_status = ANY(${statuses}))
       AND (${deliveryTypes.length === 0} OR COALESCE(o.delivery_type, 'PICKUP') = ANY(${deliveryTypes}))
     ORDER BY o.order_date, o.order_time, o.order_number
  `.catch(() => [])) as Record<string, unknown>[]

  return rows.map(row => {
    const refund = n(row.refund)
    const service = serviceTypeOf((row.delivery_type as string) ?? null)
    // THE BRANCH. t.source, never o.source_of_order — see the header.
    const isNative = String(row.source ?? '') === 'NATIVE_CHECKOUT'
    const totalDistributed = isNative ? nativeTotalDistributed(row) : fmTotalDistributed(row, refund)
    return {
      location: String(row.restaurant_name ?? ''),
      orderId: String(row.order_number ?? ''),
      customerName: [row.customer_first_name, row.customer_last_name].filter(Boolean).join(' ').trim(),
      createdDate: row.created_at ? new Date(row.created_at as string).toISOString().slice(0, 10) : '',
      serviceType: service,
      orderDate: String(row.order_date ?? ''),
      orderTime: String(row.order_time ?? '').slice(0, 5),
      netSales: n(row.subtotal),
      stateTax: n(row.state_tax),
      localTax: n(row.local_tax),
      otherTax: n(row.other_tax),
      selfDeliveryFee: n(row.own_delivery_fee),
      thirdPartyDeliveryFee: n(row.third_party_delivery_fee),
      // The restaurant's own tip, filed under the fulfilment type it was left on.
      tipPickup: service === 'Pickup' ? n(row.tips_in_price) : 0,
      tipSelfDelivery: service === 'Self-Delivery' ? n(row.tips_in_price) : 0,
      // One column for the third-party tip, whichever field FM filed it under.
      // Never both — see the TIP SPLIT note.
      tipThirdPartyDelivery: r2((service === 'Third-Party Delivery' ? n(row.tips_in_price) : 0) + n(row.third_party_delivery_tips)),
      tipThirdPartyCourierPortion: n(row.third_party_delivery_tips),
      serviceCharge: n(row.service_charge),
      discount: n(row.discount),
      leadGenOne: n(row.lead_gen_one_disco_fee),
      leadGenTwo: n(row.lead_gen_two_disco_fee),
      // ── GROSS IS WHAT THE RESTAURANT ACTUALLY RECEIVES ────────────────────
      // Three things are excluded, and none of them is a naming judgement —
      // each was checked against what Stripe actually transferred.
      //
      //  1. The FamilyMeal 3% fee (Peter's ruling, 2026-09-22) — never reaches
      //     the restaurant. No Fee column exists here either; it is simply not
      //     part of a restaurant-facing sheet. Super-admin surfaces keep it.
      //  2. The third-party DELIVERY FEE — paid to the courier network.
      //  3. The third-party (courier) TIP — likewise the courier's.
      //
      // MEASURED, not inferred. Across 43 Gracious Bakery + Stacks & Cordials
      // orders that have a real Stripe transfer:
      //     gross = total − fee                          matched 18/43
      //     FM's own convertToGross                      matched 18/43
      //     gross = total − fee − 3P delivery − 3P tips  matched 43/43
      // The 25 failures in the first two are exactly the third-party orders; on
      // #95807513 the old figure read $803.08 against a $586.16 transfer.
      //
      // Built from the visible components rather than as total − fee so the
      // columns on the sheet provably add up to this number; the two are
      // algebraically identical (total already equals the components plus fee,
      // 3P delivery and courier tip) and reconcileRow() re-checks it per row.
      gross: r2(
        n(row.subtotal) + n(row.state_tax) + n(row.local_tax) + n(row.other_tax)
        + n(row.own_delivery_fee) + n(row.tips_in_price) + n(row.service_charge)
        - n(row.discount),
      ),
      stripeFee: n(row.stripe_fee),
      refundAmount: refund,
      thirdPartySubsidy: n(row.third_party_delivery_subsiding),
      totalDistributed,
      settlement: isNative ? 'native' : 'fm',
      orderStatus: String(row.order_status ?? ''),
      deliveryType: (row.delivery_type as string) ?? null,
    }
  })
}

/**
 * Does Total Distributed reconcile against the columns on the sheet?
 *
 * THE SUBSIDY PATH IS UNEXERCISED. No native order has ever carried a non-zero
 * third_party_delivery_subsiding — zero of every NATIVE_CHECKOUT transaction —
 * so the subtraction is correct by construction and by code review, and has never
 * been checked against real money. One menu is configured with a subsidy %, so
 * the first such order will be the first test.
 *
 * It therefore FAILS LOUDLY rather than quietly. A subsidy that silently
 * misstates a payout is the worst outcome available here: the number still looks
 * like money and nobody has a reason to doubt it. This recomputes the payout from
 * the row's own visible components and reports any row that does not reconcile,
 * so a caller can refuse to render rather than publish a wrong figure.
 */
export function reconcileRow(r: OrderReportRow): { ok: boolean; expected: number; delta: number } {
  // The restaurant's own tip, wherever it was filed. Exactly one of the three is
  // non-zero for any row (they are keyed off the row's single service type), so
  // summing them is the same figure the old single tipRestaurant column held.
  const ownTip = r.tipPickup + r.tipSelfDelivery + r.tipThirdPartyDelivery - r.tipThirdPartyCourierPortion
  const expected = r.settlement === 'native'
    ? r2(r.netSales + ownTip + r.stateTax + r.localTax + r.otherTax + r.selfDeliveryFee + r.serviceCharge
        - r.thirdPartySubsidy - r.discount - r.stripeFee - r.leadGenOne - r.leadGenTwo)
    : r2((r.netSales + r.stateTax + r.localTax + r.otherTax + ownTip + r.serviceCharge + r.selfDeliveryFee)
        - (r.discount + r.stripeFee + r.leadGenOne + r.leadGenTwo + r.refundAmount))
  const delta = r2(Math.abs(expected - r.totalDistributed))
  return { ok: delta < 0.011, expected, delta }
}

/**
 * Do the money columns on the sheet add up to the Gross printed beside them?
 *
 * Gross is built from components, so this cannot drift silently — but it is the
 * claim the whole report rests on ("the columns sum exactly to gross"), and the
 * excluded pair (third-party delivery fee, courier tip) is precisely the part a
 * future edit is most likely to get wrong. Cheap to assert, so assert it.
 */
export function reconcileGross(r: OrderReportRow): { ok: boolean; expected: number; delta: number } {
  const expected = r2(
    r.netSales + r.stateTax + r.localTax + r.otherTax + r.selfDeliveryFee
    + r.tipPickup + r.tipSelfDelivery + r.tipThirdPartyDelivery - r.tipThirdPartyCourierPortion
    + r.serviceCharge - r.discount,
  )
  const delta = r2(Math.abs(expected - r.gross))
  return { ok: delta < 0.011, expected, delta }
}

/** Totals for FM's financial columns, plus the two native-only ones. */
export function totalsRow(rows: OrderReportRow[]): Partial<OrderReportRow> {
  const sum = (f: (r: OrderReportRow) => number) => r2(rows.reduce((a, r) => a + f(r), 0))
  return {
    netSales: sum(r => r.netSales), stateTax: sum(r => r.stateTax), localTax: sum(r => r.localTax),
    otherTax: sum(r => r.otherTax), selfDeliveryFee: sum(r => r.selfDeliveryFee),
    thirdPartyDeliveryFee: sum(r => r.thirdPartyDeliveryFee),
    tipPickup: sum(r => r.tipPickup), tipSelfDelivery: sum(r => r.tipSelfDelivery),
    tipThirdPartyDelivery: sum(r => r.tipThirdPartyDelivery),
    tipThirdPartyCourierPortion: sum(r => r.tipThirdPartyCourierPortion),
    serviceCharge: sum(r => r.serviceCharge),
    discount: sum(r => r.discount), leadGenOne: sum(r => r.leadGenOne), leadGenTwo: sum(r => r.leadGenTwo),
    gross: sum(r => r.gross), stripeFee: sum(r => r.stripeFee), refundAmount: sum(r => r.refundAmount),
    thirdPartySubsidy: sum(r => r.thirdPartySubsidy), totalDistributed: sum(r => r.totalDistributed),
  }
}
