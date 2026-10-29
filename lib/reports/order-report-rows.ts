import { sql } from '../db'
import { expandFulfillmentFilter } from './fulfillment-filter'
import { paymentLabel, PAID_LABELS } from '../order/stripe-facts'
import { SHORTFALL_VIA } from '../order/refund-stripe-fee'

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
  // Restored. It was on the pre-3dc0666 column list, three saved reports still
  // ask for it, and the value has been on OrderReportRow the whole time — it was
  // simply never re-listed when the column set was replaced. Without it the
  // migration would have had to drop a column those restaurants chose.
  { key: 'orderStatus', label: 'Status', financial: false },
  // ── PAYMENT (Peter, 2026-10-29, decision 1) ─────────────────────────────────
  // Unpaid orders stay in the report, labelled so nobody reads them as paid:
  // Paid / Refunded / Partially refunded / Unpaid invoice / Abandoned checkout /
  // Voided / Declined (lib/order/stripe-facts.ts paymentLabel). Disco-processed
  // orders only — a FamilyMeal-copied row keeps FM's status and is left blank.
  { key: 'paymentStatus', label: 'Payment', financial: false },
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
  // ── ROUNDING ADJUSTMENT (Peter, 2026-10-29) ─────────────────────────────────
  // Seven native orders (#900000338 and six others, 30 Sep – 22 Oct) were placed
  // under the 1¢ rounding bug (lib/menu-settings.ts computeThirdPartyDelivery)
  // and store a subsidy of −$0.01 at restaurants that set no subsidy. Stripe paid
  // them that cent. The subsidy column shows $0.00 for them and the cent is shown
  // here instead, so Total Distributed still matches the transfer. Display only:
  // the stored figure is left as settled. Shown only when non-zero.
  { key: 'roundingAdjustment', label: 'Rounding Adjustment', financial: true, nativeOnly: true, hiddenByDefault: true },
  // ── STRIPE FEE ON A REFUND ──────────────────────────────────────────────────
  // Peter, 2026-10-29: the restaurant bears the Stripe fee on a refund. What was
  // actually reversed from its payouts for this order's refunds
  // (disco_refund_stripe_fees.recovered_amount, lib/order/refund-stripe-fee.ts).
  // Subtracted from Total Distributed so the payout matches Stripe; shown only
  // when non-zero (visible-columns), like the subsidy.
  { key: 'refundStripeFee', label: 'Stripe Fee on Refund', financial: true, nativeOnly: true, hiddenByDefault: true },
  // ── PAYOUT ADJUSTMENT (Peter, 2026-10-29, decision 4) ──────────────────────
  // Total Distributed is what Stripe ACTUALLY transferred less what it reversed
  // (disco_order_stripe_facts). Where that differs from what the order's own
  // figures add up to, the difference is shown here so the sheet still adds up
  // and nobody has to guess why: Stripe's fee above or below the estimate before
  // it was settled, a refund made in the Stripe dashboard that reversed nothing,
  // a payout that was never sent. Shown only when non-zero.
  { key: 'payoutAdjustment', label: 'Payout Adjustment (Stripe)', financial: true, nativeOnly: true, hiddenByDefault: true },
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
  /** The 1¢ a rounding-bug order paid the restaurant, shown apart from the subsidy. */
  roundingAdjustment: number
  /** Stripe fee on this order's refunds, taken back from the restaurant's payouts. */
  refundStripeFee: number
  /** Stripe's actual payout less what the order's figures add up to. */
  payoutAdjustment: number
  totalDistributed: number
  /** Payment in words (Disco-processed orders); '' for a FamilyMeal-copied row. */
  paymentStatus: string
  /** False for a Disco order that was never paid: no payout, left out of the totals row. */
  paid: boolean
  /**
   * The part of tipThirdPartyDelivery that went to the COURIER and so is not in
   * Gross. Not a column — carried so reconcileGross/reconcileRow can check the
   * arithmetic without putting a fourth tip column back on the sheet.
   */
  tipThirdPartyCourierPortion: number
  /** What refunds took back from a native payout (refund ÷ charge × payout). Not a column. */
  refundReversal: number
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
  /**
   * Also include orders that fall BEFORE `from` but only synced into Neon after
   * this timestamp — the previous run of this report.
   *
   * WHY. An FM-mirrored order carries its real placement time but arrives in
   * Neon whenever the sync next runs. Order #80285521 was placed 2026-09-04 and
   * synced 2026-09-10: the 09-07 run covered its date and found nothing because
   * the row did not exist yet, and the 09-14 run's window starts after its date.
   * It has never appeared in a report and never would have. 140 of the 438
   * orders placed since scheduled reports began (32%) synced after the run that
   * covered them, so this is ongoing, not an artifact of the FM backfill.
   *
   * Strictly `< from`: an order dated AFTER the window is not late, it is early,
   * and its own future run will carry it. Bounding on the previous run means
   * each late arrival is swept up exactly once.
   */
  catchUpSince?: string | null
}

export async function buildOrderReportRows(opts: BuildOptions): Promise<OrderReportRow[]> {
  const byCreated = opts.dateField === 'created_at'
  const statuses = (opts.orderStatuses ?? []).filter(Boolean)
  // Concepts in, raw column values out. A stored filter may hold either shape —
  // see lib/reports/fulfillment-filter.ts for why both must keep working.
  const deliveryTypes = expandFulfillmentFilter(opts.deliveryTypes)
  const catchUpSince = opts.catchUpSince ? String(opts.catchUpSince) : null

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
    SELECT o.order_number, o.restaurant_name, pc.name AS paid_to_name, (m.paid_ref <> o.restaurant_reference) AS transferred_money,
           o.customer_first_name, o.customer_last_name,
           COALESCE(o.placed_at, o.created_at) AS created_at,
           o.order_date::text AS order_date, o.order_time::text AS order_time,
           o.delivery_type, o.order_status, o.refund, o.source_of_order,
           t.source, t.subtotal, t.state_tax, t.local_tax, t.other_tax,
           t.own_delivery_fee, t.third_party_delivery_fee, t.tips_in_price, t.third_party_delivery_tips,
           t.service_charge, t.discount, t.lead_gen_one_disco_fee, t.lead_gen_two_disco_fee,
           t.total, t.fee, t.stripe_fee, t.third_party_delivery_subsiding,
           o.total AS order_total,
           t0.total AS orig_total, t0.subtotal AS orig_subtotal, t0.tips_in_price AS orig_tips_in_price,
           t0.state_tax AS orig_state_tax, t0.local_tax AS orig_local_tax, t0.other_tax AS orig_other_tax,
           t0.own_delivery_fee AS orig_own_delivery_fee, t0.service_charge AS orig_service_charge,
           t0.third_party_delivery_subsiding AS orig_third_party_delivery_subsiding, t0.discount AS orig_discount,
           t0.stripe_fee AS orig_stripe_fee, t0.lead_gen_one_disco_fee AS orig_lead_gen_one_disco_fee,
           t0.lead_gen_two_disco_fee AS orig_lead_gen_two_disco_fee,
           -- What edits refunded (lib/order/refundable.ts editRefundedSql): already
           -- inside the lowered total, so only the REST of o.refund is a refund.
           (SELECT COALESCE(SUM(-e.delta), 0) FROM disco_order_edits e
              WHERE e.fm_order_reference IN (o.reference, o.fm_order_reference)
                AND e.payment_status = 'refunded' AND e.delta < 0) AS edit_refunded,
           -- The Stripe fee on its refunds that the restaurant paid back (lib/order/refund-stripe-fee.ts),
           -- and, separately, everything taken back for its refunds (fee + a capped reversal's shortfall).
           (SELECT COALESCE(SUM(f.recovered_amount), 0) FROM disco_refund_stripe_fees f
              WHERE f.order_reference = o.reference::text AND f.via <> ${SHORTFALL_VIA}) AS refund_stripe_fee,
           (SELECT COALESCE(SUM(f.recovered_amount), 0) FROM disco_refund_stripe_fees f
              WHERE f.order_reference = o.reference::text) AS refund_taken_back,
           -- What Stripe actually did (lib/order/stripe-facts.ts; Disco-processed orders only).
           sf.order_reference IS NOT NULL AS has_facts, sf.captured AS sf_captured, sf.refunded AS sf_refunded,
           sf.stripe_fee AS sf_stripe_fee, sf.fee_known AS sf_fee_known, sf.transferred AS sf_transferred,
           sf.reversed AS sf_reversed, sf.invoice_status AS sf_invoice_status,
           (o.fm_order_reference IS NULL) AS disco_processed,
           (EXISTS (SELECT 1 FROM disco_stripe_payments sp WHERE sp.order_reference = o.reference AND sp.status = 'SUCCEEDED')
              OR o.stripe_invoice_status = 'paid') AS paid_in_disco
      FROM disco_orders o
      LEFT JOIN disco_order_stripe_facts sf ON sf.order_reference = o.reference::text AND o.fm_order_reference IS NULL
      -- Money belongs to the location whose Stripe account received it, not the
      -- one a transfer moved the order to (lib/order/money-location.ts).
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
      -- t = the order's CURRENT figures: the newest edit breakdown (a MANUAL_EDIT
      -- row carrying taxes), else checkout — the same rule as the PDF and order
      -- details (lib/order/current-breakdown.ts). Reading checkout only left
      -- every paid edit out (#900000522 +$65.97). An UNPAID edit writes no row,
      -- so it is not counted until it is paid. t0 = checkout, for the payout
      -- share a later refund takes back.
      LEFT JOIN disco_sale_transactions t0
        ON t0.order_id = o.id AND t0.transaction_type = 'ORIGINAL'
      LEFT JOIN LATERAL (
        SELECT * FROM disco_sale_transactions x
         WHERE x.order_id = o.id
           AND (x.transaction_type = 'ORIGINAL'
                OR (x.source = 'MANUAL_EDIT' AND x.transaction_type IN ('ADDITIONAL', 'REFUND') AND x.state_tax IS NOT NULL))
         ORDER BY (x.transaction_type = 'ORIGINAL'), x.created_at DESC, x.id DESC
         LIMIT 1
      ) t ON true
     WHERE m.paid_ref = ANY(${opts.refs}::uuid[])
       AND o.is_deleted = false
       -- Unpaid Disco orders are KEPT (Peter, 2026-10-29, decision 1) and labelled
       -- in the Payment column, with no payout and out of the totals row. They used
       -- to be dropped (#900000473: cancelled, never paid, printed as $372.63 of
       -- payout) — the payout part of that is now prevented by the paid flag below.
       AND (
             (CASE WHEN ${byCreated} THEN COALESCE(o.placed_at, o.created_at)::date ELSE o.order_date END)
               BETWEEN ${opts.from}::date AND ${opts.to}::date
             -- Late arrivals: dated before this window, but synced since the
             -- previous run, so no earlier run could have seen them.
             OR (${catchUpSince !== null}
                 AND o.created_at > ${catchUpSince}::timestamptz
                 AND (CASE WHEN ${byCreated} THEN COALESCE(o.placed_at, o.created_at)::date ELSE o.order_date END)
                     < ${opts.from}::date)
           )
       AND (${statuses.length === 0} OR o.order_status = ANY(${statuses}))
       AND (${deliveryTypes.length === 0} OR COALESCE(o.delivery_type, 'PICKUP') = ANY(${deliveryTypes}))
     ORDER BY o.order_date, o.order_time, o.order_number
  `.catch(() => [])) as Record<string, unknown>[]

  return rows.map(row => {
    // THE BRANCH. The checkout row's source, never o.source_of_order — see the
    // header. (t may be an edit row, whose source is MANUAL_EDIT.)
    const isNative = String(row.source ?? '') === 'NATIVE_CHECKOUT' || String(row.source ?? '') === 'MANUAL_EDIT'
    // A native order's real refunds: an edit's refund is already inside the
    // lowered figures, so only the rest counts (lib/order/refundable.ts).
    const refund = isNative ? r2(Math.max(0, n(row.refund) - n(row.edit_refunded))) : n(row.refund)
    const service = serviceTypeOf((row.delivery_type as string) ?? null)
    // ── WHAT A REFUND TAKES BACK FROM THE PAYOUT ──────────────────────────────
    // A portal/Super Admin refund reverses the restaurant's transfer in
    // proportion to the charge (reverse_transfer, lib/order/native-refund.ts):
    // refund ÷ checkout charge × checkout payout. A full refund therefore takes
    // the payout to zero (#900000499 still showed $420.63 of payout).
    const origTotal = n(row.orig_total)
    const origPayout = nativeTotalDistributed({
      subtotal: row.orig_subtotal, tips_in_price: row.orig_tips_in_price, state_tax: row.orig_state_tax,
      local_tax: row.orig_local_tax, other_tax: row.orig_other_tax, own_delivery_fee: row.orig_own_delivery_fee,
      service_charge: row.orig_service_charge, third_party_delivery_subsiding: row.orig_third_party_delivery_subsiding,
      discount: row.orig_discount, stripe_fee: row.orig_stripe_fee,
      lead_gen_one_disco_fee: row.orig_lead_gen_one_disco_fee, lead_gen_two_disco_fee: row.orig_lead_gen_two_disco_fee,
    })
    // ── PAID OR NOT, IN WORDS (decision 1) ────────────────────────────────────
    // Native rows only. Stripe's facts once synced; Disco's own payment record
    // until then. A FamilyMeal-copied row is untouched: blank, counted as before.
    const disco = row.disco_processed === true
    const hasFacts = disco && row.has_facts === true
    const paymentStatus = disco ? paymentLabel({
      orderStatus: String(row.order_status ?? ''),
      captured: hasFacts ? Math.round(n(row.sf_captured) * 100) : null,
      refunded: hasFacts ? Math.round(n(row.sf_refunded) * 100) : null,
      invoiceStatus: hasFacts ? (row.sf_invoice_status as string | null) : null,
      paidInDisco: row.paid_in_disco === true, refundInDisco: n(row.refund), totalInDisco: n(row.order_total),
    }) : ''
    const paid = !disco || PAID_LABELS.has(paymentStatus as never)
    // ── WHAT STRIPE ACTUALLY DID (decisions 3 and 4) ──────────────────────────
    // Stripe's actual fee, and its actual transfers less reversals, once synced
    // (lib/order/stripe-facts.ts). Before the first sync, the computed figures.
    const actualFee = hasFacts && row.sf_fee_known === true ? n(row.sf_stripe_fee) : null
    const stripeFee = !paid ? 0 : actualFee ?? n(row.stripe_fee)
    const refundReversal = paid && isNative && refund > 0 && origTotal > 0 ? r2(Math.min(refund / origTotal, 1) * origPayout) : 0
    const refundStripeFee = paid && isNative ? n(row.refund_stripe_fee) : 0
    const computed = isNative ? r2(nativeTotalDistributed({ ...row, stripe_fee: stripeFee }) - refundReversal - refundStripeFee) : 0
    const totalDistributed = !paid ? 0
      : !isNative ? fmTotalDistributed(row, refund)
      : hasFacts ? r2(n(row.sf_transferred) - n(row.sf_reversed) - n(row.refund_taken_back))
      : computed
    const payoutAdjustment = isNative && paid ? r2(totalDistributed - computed) : 0
    // A native subsidy is never negative (the restaurant covers part of the fee or
    // none of it); a stored −$0.01 is the rounding bug's cent, not a subsidy. See
    // the ROUNDING ADJUSTMENT note. FamilyMeal-copied rows keep their figures.
    const storedSubsidy = n(row.third_party_delivery_subsiding)
    const roundingCent = isNative && storedSubsidy < 0 && storedSubsidy >= -0.01
    return {
      // A transferred order is listed under the location that was paid, naming
      // the one that prepares it, so neither reads it as a mistake.
      location: row.transferred_money
        ? `${String(row.paid_to_name ?? '')} (prepared by ${String(row.restaurant_name ?? '')})`
        : String(row.restaurant_name ?? ''),
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
      stripeFee: isNative ? stripeFee : n(row.stripe_fee),
      refundAmount: refund,
      thirdPartySubsidy: roundingCent ? 0 : storedSubsidy,
      roundingAdjustment: roundingCent && paid ? r2(-storedSubsidy) : 0,
      refundStripeFee,
      payoutAdjustment,
      totalDistributed,
      paymentStatus,
      paid,
      refundReversal,
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
  // An unpaid Disco order has no payout to reconcile (decision 1).
  if (r.paid === false) return { ok: r.totalDistributed === 0, expected: 0, delta: Math.abs(r.totalDistributed) }
  // The restaurant's own tip, wherever it was filed. Exactly one of the three is
  // non-zero for any row (they are keyed off the row's single service type), so
  // summing them is the same figure the old single tipRestaurant column held.
  const ownTip = r.tipPickup + r.tipSelfDelivery + r.tipThirdPartyDelivery - r.tipThirdPartyCourierPortion
  const expected = r.settlement === 'native'
    ? r2(r.netSales + ownTip + r.stateTax + r.localTax + r.otherTax + r.selfDeliveryFee + r.serviceCharge
        - r.thirdPartySubsidy - r.discount - r.stripeFee - r.leadGenOne - r.leadGenTwo - r.refundReversal - r.refundStripeFee
        + (r.roundingAdjustment ?? 0) + (r.payoutAdjustment ?? 0))
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

/** The totals row's label: unpaid Disco orders are listed but not summed (decision 1). */
export const TOTALS_LABEL = 'TOTAL (paid orders)'

/** Totals for FM's financial columns, plus the native-only ones. Paid orders only. */
export function totalsRow(allRows: OrderReportRow[]): Partial<OrderReportRow> {
  const rows = allRows.filter(r => r.paid !== false)
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
    thirdPartySubsidy: sum(r => r.thirdPartySubsidy), roundingAdjustment: sum(r => r.roundingAdjustment ?? 0),
    refundStripeFee: sum(r => r.refundStripeFee),
    payoutAdjustment: sum(r => r.payoutAdjustment ?? 0),
    totalDistributed: sum(r => r.totalDistributed),
  }
}
