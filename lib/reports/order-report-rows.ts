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
  // ── TIP SPLIT ───────────────────────────────────────────────────────────────
  // FM has ONE "Tip" column because on FM every tip reaches the restaurant. On a
  // native third-party delivery it does not: the tip routes to
  // third_party_delivery_tips and is excluded from the transfer, because the
  // courier network invoices Disco separately. Verified on real money —
  // #900000162 ($26.80) and #900000160 ($67.20) both settled with the tip
  // excluded from transfer_data.amount.
  //
  // A single "Tip" column therefore has no honest value: showing the restaurant's
  // share alone reads as "no tip was left", and showing the sum claims money the
  // restaurant never receives. Two columns, and the second one SAYS SO in its
  // header rather than relying on anyone knowing the settlement rule.
  { key: 'tipRestaurant', label: 'Tip (Restaurant)', financial: true },
  { key: 'tipThirdParty', label: 'Tip (Third-Party, not paid out)', financial: true },
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
  tipRestaurant: number
  tipThirdParty: number
  serviceCharge: number
  discount: number
  leadGenOne: number
  leadGenTwo: number
  gross: number
  stripeFee: number
  refundAmount: number
  thirdPartySubsidy: number
  totalDistributed: number
  /** Which settlement produced totalDistributed. Not a column; used for diagnostics. */
  settlement: 'native' | 'fm'
  /** Not columns — carried so callers can filter without a second query. */
  orderStatus: string
  deliveryType: string | null
}

const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const r2 = (x: number) => Math.round(x * 100) / 100

/** FM's serviceType CASE, reproduced exactly. */
function serviceTypeOf(deliveryType: string | null): string {
  if (deliveryType === 'OWN_DELIVERY') return 'Self-Delivery'
  if (deliveryType == null || deliveryType === '') return 'Pickup'
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
           t.total, t.stripe_fee, t.third_party_delivery_subsiding
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
    // THE BRANCH. t.source, never o.source_of_order — see the header.
    const isNative = String(row.source ?? '') === 'NATIVE_CHECKOUT'
    const totalDistributed = isNative ? nativeTotalDistributed(row) : fmTotalDistributed(row, refund)
    return {
      location: String(row.restaurant_name ?? ''),
      orderId: String(row.order_number ?? ''),
      customerName: [row.customer_first_name, row.customer_last_name].filter(Boolean).join(' ').trim(),
      createdDate: row.created_at ? new Date(row.created_at as string).toISOString().slice(0, 10) : '',
      serviceType: serviceTypeOf((row.delivery_type as string) ?? null),
      orderDate: String(row.order_date ?? ''),
      orderTime: String(row.order_time ?? '').slice(0, 5),
      netSales: n(row.subtotal),
      stateTax: n(row.state_tax),
      localTax: n(row.local_tax),
      otherTax: n(row.other_tax),
      selfDeliveryFee: n(row.own_delivery_fee),
      thirdPartyDeliveryFee: n(row.third_party_delivery_fee),
      tipRestaurant: n(row.tips_in_price),
      tipThirdParty: n(row.third_party_delivery_tips),
      serviceCharge: n(row.service_charge),
      discount: n(row.discount),
      leadGenOne: n(row.lead_gen_one_disco_fee),
      leadGenTwo: n(row.lead_gen_two_disco_fee),
      gross: n(row.total),
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
  const expected = r.settlement === 'native'
    ? r2(r.netSales + r.tipRestaurant + r.stateTax + r.localTax + r.otherTax + r.selfDeliveryFee + r.serviceCharge
        - r.thirdPartySubsidy - r.discount - r.stripeFee - r.leadGenOne - r.leadGenTwo)
    : r2((r.netSales + r.stateTax + r.localTax + r.otherTax + r.tipRestaurant + r.serviceCharge + r.selfDeliveryFee)
        - (r.discount + r.stripeFee + r.leadGenOne + r.leadGenTwo + r.refundAmount))
  const delta = r2(Math.abs(expected - r.totalDistributed))
  return { ok: delta < 0.011, expected, delta }
}

/** Totals for FM's financial columns, plus the two native-only ones. */
export function totalsRow(rows: OrderReportRow[]): Partial<OrderReportRow> {
  const sum = (f: (r: OrderReportRow) => number) => r2(rows.reduce((a, r) => a + f(r), 0))
  return {
    netSales: sum(r => r.netSales), stateTax: sum(r => r.stateTax), localTax: sum(r => r.localTax),
    otherTax: sum(r => r.otherTax), selfDeliveryFee: sum(r => r.selfDeliveryFee),
    thirdPartyDeliveryFee: sum(r => r.thirdPartyDeliveryFee), tipRestaurant: sum(r => r.tipRestaurant),
    tipThirdParty: sum(r => r.tipThirdParty), serviceCharge: sum(r => r.serviceCharge),
    discount: sum(r => r.discount), leadGenOne: sum(r => r.leadGenOne), leadGenTwo: sum(r => r.leadGenTwo),
    gross: sum(r => r.gross), stripeFee: sum(r => r.stripeFee), refundAmount: sum(r => r.refundAmount),
    thirdPartySubsidy: sum(r => r.thirdPartySubsidy), totalDistributed: sum(r => r.totalDistributed),
  }
}
