// Shared, single-order disco_sale_transactions field reconstruction — the exact
// mapping from FM's raw financial fields (tax split, delivery-fee split, discount,
// tips) to what gets written to Neon. Used by BOTH the snapshot-based backfill
// (scripts/fm-order-backfill.ts, reading fm_backup) and the ongoing sync
// (lib/fm-orders-sync.ts, reading FM's live API) so this money math is defined
// exactly once — two implementations of the same reconstruction is how the
// promo-code bug happened twice.

function round2(x: number): number { return Math.round(x * 100) / 100 }

export interface FmTxnRawInput {
  subtotal: number | null
  total: number | null
  fee: number | null
  stateTax: number | null
  localTax: number | null
  otherTax: number | null
  ownDeliveryFee: number | null
  thirdPartyDeliveryFee: number | null
  doordashDeliveryFee: number | null
  thirdPartyDeliverySubsiding: number | null
  thirdPartyDeliveryTips: number | null
  doordashTips: number | null
  discount: number | null
  leadGenOne: number | null
  leadGenTwo: number | null
  stripeFee: number | null
  // Genuinely unknown at sync time (FM exposes no working endpoint for the
  // actual applied service charge — paymentDetails is dead code, and the one
  // endpoint that maps the real persisted value, GET /api/orders/list, 500s
  // with a NonUniqueResultException for every restaurant tested). NULL, never
  // coerced to 0 — a confident-looking zero is worse than an honest unknown.
  serviceCharge: number | null
  // Tips: supply EITHER a precomputed dollar figure (tipsInPrice — what the
  // snapshot dump always has, FM's own stored value, ground truth) OR the raw
  // FM signal (rawTips + tipsType) for on-the-fly conversion. tipsInPrice wins
  // outright when present.
  tipsInPrice: number | null
  rawTips: number | null
  tipsType: string | null
}

export interface SaleTransactionFields {
  subtotal: number | null
  total: number | null
  fee: number | null
  serviceCharge: number | null
  stripeFee: number | null
  stateTax: number | null
  localTax: number | null
  otherTax: number | null
  tipsInPrice: number | null
  thirdPartyDeliveryTips: number | null
  ownDeliveryFee: number | null
  thirdPartyDeliveryFee: number | null
  thirdPartyDeliverySubsiding: number | null
  discount: number | null
  leadGenOne: number | null
  leadGenTwo: number | null
}

// FM keeps DoorDash as its own pair of fields, separate from the generic
// third-party (Nash) pair. Neon's disco_sale_transactions has only one
// third-party bucket, matching disco_orders.delivery_type's own two-way model
// (OWN_DELIVERY vs everything else, including DOORDASH) — fold DoorDash's
// figures in. Verified against the full fm_backup snapshot: 0 orders ever have
// both a DoorDash and an own/Nash delivery fee nonzero at once, so this is a
// lossless combine, not an approximation.
function foldThirdParty(generic: number | null, doordash: number | null): number {
  return (generic || 0) + (doordash || 0)
}

// Tips: a precomputed dollar figure wins outright when the source has one.
// Otherwise convert from the raw FM signal: CUSTOM tipsType means rawTips IS
// ALREADY a dollar amount; PERCENTAGE means it's a percent of
// (subtotal - discount) — verified against 800 real historical orders in
// fm_backup: matches FM's own stored tips_in_price ~90% of the time. The ~10%
// miss is a pre-existing FM data-quality quirk (the order-level raw tip signal
// doesn't always reflect what was actually, finally charged — verified this
// isn't explained by order/transaction status; happens on ordinary COMPLETED
// orders too) that no available field resolves. This is NOT the residual-
// from-total pattern that would let an unknown service charge contaminate the
// figure — this computation never reads total or serviceCharge at all.
export function resolveTipsInPrice(input: Pick<FmTxnRawInput, 'tipsInPrice' | 'rawTips' | 'tipsType' | 'subtotal' | 'discount'>): number | null {
  if (input.tipsInPrice != null) return round2(input.tipsInPrice)
  if (input.rawTips == null || input.rawTips <= 0) return 0
  if (input.tipsType === 'PERCENTAGE') {
    const base = (input.subtotal || 0) - (input.discount || 0)
    return round2(base * (input.rawTips / 100))
  }
  return round2(input.rawTips) // CUSTOM: already a dollar figure
}

export function buildSaleTransactionFields(input: FmTxnRawInput): SaleTransactionFields {
  return {
    subtotal: input.subtotal,
    total: input.total,
    fee: input.fee,
    serviceCharge: input.serviceCharge,
    stripeFee: input.stripeFee,
    stateTax: input.stateTax,
    localTax: input.localTax,
    otherTax: input.otherTax,
    tipsInPrice: resolveTipsInPrice(input),
    thirdPartyDeliveryTips: foldThirdParty(input.thirdPartyDeliveryTips, input.doordashTips),
    ownDeliveryFee: input.ownDeliveryFee,
    thirdPartyDeliveryFee: foldThirdParty(input.thirdPartyDeliveryFee, input.doordashDeliveryFee),
    thirdPartyDeliverySubsiding: input.thirdPartyDeliverySubsiding,
    discount: input.discount,
    leadGenOne: input.leadGenOne,
    leadGenTwo: input.leadGenTwo,
  }
}
