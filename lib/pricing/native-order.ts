// Native (Neon-only, zero-FM) order pricing for Disco-native restaurants.
//
// The money MATH is the FM-verified, cent-exact engine in lib/promo-pricing.ts
// (`computeBreakdown`) — this module does NOT re-derive it. It only assembles that
// engine's inputs from Neon and adds the two things FM used to own that Disco-native
// restaurants have no FM source for:
//   1. the lead-gen commission RATES (disco_restaurant_overrides.lead_gen_one/two_pct), and
//   2. the first-vs-repeat DECISION (an all-time count of the customer's prior paid
//      orders at this restaurant — fee 1 on the first, fee 2 forever after).
//
// Fulfillment routing (who keeps tip + delivery fee) is encoded here to match the
// product rules, then handed to computeBreakdown verbatim:
//   PICKUP / OWN_DELIVERY  → restaurant keeps the tip; OWN_DELIVERY keeps its fee too.
//   THIRD_PARTY_DELIVERY   → tip + delivery fee are excluded from the restaurant
//                            transfer (Disco keeps both; Disco pays the courier).

import { sql } from '../db'
import {
  computeBreakdown, type Breakdown, type PricingConfig, type PricingOrder,
} from '../promo-pricing'

export type Fulfillment = 'PICKUP' | 'OWN_DELIVERY' | 'THIRD_PARTY_DELIVERY'

// disco_orders.order_status values that mean the customer successfully PAID — the
// signal that a prior order "counts" for lead-gen fee 1 → fee 2. Excludes
// CART/RESERVED/UNPAID/EXPIRED/VOID/CANCELED/PAYMENT_FAILED.
const PAID_STATUSES = ['DUE', 'COMPLETED', 'PAID', 'PARTIAL_REFUND', 'REFUND'] as const

// FM default lead-gen rates (whole-number percents), used when an override row has
// no explicit rate. Mirrors FM Restaurant.leadGenOne/leadGenTwo defaults (15 / 5).
export const DEFAULT_LEAD_GEN_ONE_PCT = 15
export const DEFAULT_LEAD_GEN_TWO_PCT = 5

export interface NativeLeadGenRates { oneRatePct: number; twoRatePct: number }

interface FmTaxRate { percent?: number; fixedAmount?: number }
interface FmOtherTaxRate extends FmTaxRate { types?: string[] }
interface FmTaxRates {
  stateSalesTax?: FmTaxRate
  localSalesTax?: FmTaxRate
  otherSalesTax?: FmOtherTaxRate
}

// Count of prior PAID orders by this customer at this restaurant. All-time,
// permanent, no rolling window (matches the FM rule). 0 → first order (fee 1);
// ≥1 → repeat (fee 2 forever). Never throws — a lookup failure returns 0 (fee 1),
// the customer-favourable default, rather than blocking the order.
//
// Counts BOTH native (source_of_order='DISCO') AND FM-mirrored (FAMILYMEAL) paid
// orders. This is what makes the fee tier carry over across an FM→native
// conversion: a returning customer with paid FM history at the restaurant stays on
// fee-2 instead of resetting to fee-1. Requires the restaurant's FM order history
// to have been backfilled into disco_orders (a gated conversion prerequisite —
// see backfillFmOrderHistory in native-conversion.ts).
export async function countPriorPaidOrders(customerEmail: string, restaurantReference: string): Promise<number> {
  const e = (customerEmail || '').trim().toLowerCase()
  if (!e || !restaurantReference) return 0
  try {
    const rows = (await sql`
      SELECT COUNT(*)::int AS n FROM disco_orders
      WHERE lower(customer_email) = ${e}
        AND restaurant_reference = ${restaurantReference}::uuid
        AND order_status = ANY(${PAID_STATUSES as unknown as string[]})
    `) as { n: number }[]
    return rows[0]?.n ?? 0
  } catch (err) {
    console.error('[native-order] countPriorPaidOrders failed:', err instanceof Error ? err.message : err)
    return 0
  }
}

// The lead-gen % that applies to THIS order for THIS customer↔restaurant pair.
export async function resolveNativeLeadGenPct(
  customerEmail: string, restaurantReference: string, rates: NativeLeadGenRates,
): Promise<{ pct: number; priorOrders: number; tier: 1 | 2 }> {
  const priorOrders = await countPriorPaidOrders(customerEmail, restaurantReference)
  return priorOrders > 0
    ? { pct: rates.twoRatePct, priorOrders, tier: 2 }
    : { pct: rates.oneRatePct, priorOrders, tier: 1 }
}

// Load the native pricing config for a restaurant from Neon (no FM): tax rates and
// lead-gen rates from disco_restaurant_overrides. Service-charge % comes from the
// menu setting (0 until that authoring lands — Stage 5). `leadGenPct` is resolved
// separately (it needs the customer) and set by the caller before pricing.
export async function loadNativePricingConfig(
  restaurantReference: string,
  opts?: { scPct?: number; orderType?: string },
): Promise<{ cfg: Omit<PricingConfig, 'leadGenPct'>; rates: NativeLeadGenRates }> {
  let tax: FmTaxRates = {}
  let rates: NativeLeadGenRates = { oneRatePct: DEFAULT_LEAD_GEN_ONE_PCT, twoRatePct: DEFAULT_LEAD_GEN_TWO_PCT }
  try {
    const rows = (await sql`
      SELECT tax_rates, lead_gen_one_pct, lead_gen_two_pct
      FROM disco_restaurant_overrides WHERE restaurant_reference = ${restaurantReference}
      LIMIT 1
    `) as { tax_rates: FmTaxRates | null; lead_gen_one_pct: string | number | null; lead_gen_two_pct: string | number | null }[]
    const row = rows[0]
    if (row?.tax_rates) tax = row.tax_rates
    if (row) {
      rates = {
        oneRatePct: row.lead_gen_one_pct != null ? Number(row.lead_gen_one_pct) : DEFAULT_LEAD_GEN_ONE_PCT,
        twoRatePct: row.lead_gen_two_pct != null ? Number(row.lead_gen_two_pct) : DEFAULT_LEAD_GEN_TWO_PCT,
      }
    }
  } catch (err) {
    console.error('[native-order] loadNativePricingConfig failed — using safe defaults:', err instanceof Error ? err.message : err)
  }

  const otherTypes = tax.otherSalesTax?.types ?? []
  const cfg: Omit<PricingConfig, 'leadGenPct'> = {
    scPct: opts?.scPct ?? 0,
    stateTax: { percent: tax.stateSalesTax?.percent ?? 0, fixedAmount: tax.stateSalesTax?.fixedAmount ?? 0 },
    localTax: { percent: tax.localSalesTax?.percent ?? 0, fixedAmount: tax.localSalesTax?.fixedAmount ?? 0 },
    otherTax: {
      percent: tax.otherSalesTax?.percent ?? 0,
      fixedAmount: tax.otherSalesTax?.fixedAmount ?? 0,
      applies: !!opts?.orderType && otherTypes.includes(opts.orderType),
    },
    familyMealPct: 3,
    stripePct: 2.9,
    stripeFlat: 0.30,
  }
  return { cfg, rates }
}

// Map fulfillment type → the delivery-fee / tip routing computeBreakdown expects.
// This is where the "who keeps the tip and delivery fee" product rule is encoded.
export function routeFulfillment(input: {
  subtotal: number
  fulfillment: Fulfillment
  deliveryFee?: number
  thirdPartyDeliverySubsiding?: number
  tip: { custom: boolean; amount?: number; pct?: number }
}): PricingOrder {
  const fee = input.deliveryFee ?? 0
  const isThirdParty = input.fulfillment === 'THIRD_PARTY_DELIVERY'
  return {
    subtotal: input.subtotal,
    ownDeliveryFee: input.fulfillment === 'OWN_DELIVERY' ? fee : 0,
    thirdPartyDeliveryFee: isThirdParty ? fee : 0,
    thirdPartyDeliverySubsiding: isThirdParty ? (input.thirdPartyDeliverySubsiding ?? 0) : 0,
    tipCustom: input.tip.custom,
    tipAmount: input.tip.amount ?? 0,
    tipPct: input.tip.pct ?? 0,
    tipsAreThirdParty: isThirdParty, // third-party tips route to Disco (excluded from transfer)
  }
}

export interface NativeOrderInput {
  restaurantReference: string
  customerEmail: string
  subtotal: number
  fulfillment: Fulfillment
  deliveryFee?: number
  thirdPartyDeliverySubsiding?: number
  scPct?: number
  tip: { custom: boolean; amount?: number; pct?: number }
  discountPct?: number
}

export interface NativePricedOrder extends Breakdown {
  leadGenPct: number
  leadGenTier: 1 | 2
  priorOrders: number
  fulfillment: Fulfillment
}

// Full native price of an order: load config + resolve lead-gen from history +
// route fulfillment + run the cent-exact engine. `total` is the customer charge,
// `transfer` is the restaurant payout; Disco keeps `total − transfer`.
export async function priceNativeOrder(input: NativeOrderInput): Promise<NativePricedOrder> {
  const orderType = input.fulfillment === 'PICKUP' ? 'PICKUP' : 'DELIVERY'
  const { cfg, rates } = await loadNativePricingConfig(input.restaurantReference, { scPct: input.scPct, orderType })
  const { pct: leadGenPct, priorOrders, tier } = await resolveNativeLeadGenPct(input.customerEmail, input.restaurantReference, rates)
  const order = routeFulfillment(input)
  const breakdown = computeBreakdown(order, { ...cfg, leadGenPct }, input.discountPct ?? 0)
  return { ...breakdown, leadGenPct, leadGenTier: tier, priorOrders, fulfillment: input.fulfillment }
}
