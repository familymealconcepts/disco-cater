// Reproduces FamilyMeal's order pricing to the cent so Disco can compute the
// DISCOUNTED customer total + restaurant transfer for a restaurant-funded promo
// and adjust the FM PaymentIntent (amount + transfer_data.amount) PRE-CHARGE
// (Path B). No refund, no reversal, no webhook, no cron.
//
// Verified against FM source (PriceCalculateService, StripeConnectedAccount
// ServiceImpl). Every component rounds HALF_UP to 2 decimals individually (FM
// uses BigDecimal.setScale(2, HALF_UP)); the transfer is summed from those
// 2-decimal components. r2() mirrors that with an epsilon guard against binary
// float error near .xx5 boundaries.
//
// FM composition (all bases use the DISCOUNTED subtotal = subtotal − discount):
//   discount      = round(subtotal × discountPct/100)
//   serviceCharge = round(base × scPct/100)                       base = subtotal − discount
//   taxBase       = base + serviceCharge
//   stateTax      = round(taxBase × statePct/100 + stateFixed)
//   localTax      = round(taxBase × localPct/100 + localFixed)
//   otherTax      = applies ? round(taxBase × otherPct/100 + otherFixed) : 0
//   familyMealFee = round(base × 3/100)                           (platform keeps it; NOT in transfer)
//   tips          = custom ? amount : round(base × tipPct/100)    (own tips → tipsInPrice; Nash → thirdPartyDeliveryTips)
//   total         = round(base + taxes + delivery + familyMealFee + serviceCharge + tips)   ← customer charge
//   stripeFee     = round(total × 2.9/100 + 0.30)                 (restaurant bears it; subtracted from transfer)
//   leadGen       = round(base × leadGenPct/100)                  (subtracted from transfer; derived at runtime)
//   transfer      = round(subtotal + tipsInPrice + taxes + ownDeliveryFee + serviceCharge
//                          − thirdPartyDeliverySubsiding − discount − stripeFee − leadGen)   ← restaurant payout

export function r2(x: number): number {
  return (x < 0 ? -1 : 1) * Math.floor(Math.abs(x) * 100 + 0.5 + 1e-6) / 100
}

export interface TaxRate { percent: number; fixedAmount: number }
export interface OtherTaxRate extends TaxRate { applies: boolean }

export interface PricingConfig {
  scPct: number                 // service charge % (from the order's menu settings)
  stateTax: TaxRate
  localTax: TaxRate
  otherTax: OtherTaxRate        // applies = orderType ∈ FM otherSalesTax.types
  familyMealPct: number         // 3
  stripePct: number             // 2.9
  stripeFlat: number            // 0.30
  leadGenPct: number            // applicable lead-gen % (derived from FM's actual transfer); 0 if none
}

export interface PricingOrder {
  subtotal: number
  ownDeliveryFee: number
  thirdPartyDeliveryFee: number
  thirdPartyDeliverySubsiding: number
  tipCustom: boolean
  tipAmount: number             // when custom
  tipPct: number                // when percentage
  tipsAreThirdParty: boolean    // Nash/third-party: tips route to thirdPartyDeliveryTips (excluded from transfer)
}

export interface Breakdown {
  discount: number
  serviceCharge: number
  stateTax: number
  localTax: number
  otherTax: number
  familyMealFee: number
  tipsInPrice: number
  thirdPartyDeliveryTips: number
  stripeFee: number
  leadGen: number
  total: number       // customer charge (dollars)
  transfer: number    // restaurant payout (dollars)
}

export function computeBreakdown(order: PricingOrder, cfg: PricingConfig, discountPct: number): Breakdown {
  const s = order.subtotal
  const discount = r2(s * discountPct / 100)
  const base = s - discount
  const serviceCharge = r2(base * cfg.scPct / 100)
  const taxBase = base + serviceCharge
  const stateTax = r2(taxBase * cfg.stateTax.percent / 100 + cfg.stateTax.fixedAmount)
  const localTax = r2(taxBase * cfg.localTax.percent / 100 + cfg.localTax.fixedAmount)
  const otherTax = cfg.otherTax.applies ? r2(taxBase * cfg.otherTax.percent / 100 + cfg.otherTax.fixedAmount) : 0
  const familyMealFee = r2(base * cfg.familyMealPct / 100)

  const tipVal = order.tipCustom ? r2(order.tipAmount) : r2(base * order.tipPct / 100)
  const tipsInPrice = order.tipsAreThirdParty ? 0 : tipVal
  const thirdPartyDeliveryTips = order.tipsAreThirdParty ? tipVal : 0

  const total = r2(
    base + stateTax + localTax + otherTax
    + order.ownDeliveryFee + order.thirdPartyDeliveryFee
    + familyMealFee + serviceCharge + tipsInPrice + thirdPartyDeliveryTips,
  )
  const stripeFee = r2(total * cfg.stripePct / 100 + cfg.stripeFlat)
  const leadGen = r2(base * cfg.leadGenPct / 100)

  const transfer = r2(
    s + tipsInPrice + stateTax + localTax + otherTax + order.ownDeliveryFee + serviceCharge
    - order.thirdPartyDeliverySubsiding - discount - stripeFee - leadGen,
  )

  return { discount, serviceCharge, stateTax, localTax, otherTax, familyMealFee, tipsInPrice, thirdPartyDeliveryTips, stripeFee, leadGen, total, transfer }
}

// Derive the applicable lead-gen amount FM actually applied, from FM's real
// full-price transfer, so we don't need to fetch lead-gen config or replicate
// FM's first-vs-repeat count. Everything in the transfer except lead-gen is
// known/computable at full price; lead-gen is the residual.
//   fullTransfer = subtotal + fullTipsInPrice + fullTaxes + ownDeliveryFee + fullServiceCharge
//                  − subsidy − stripeFeeFull − leadGenFull        (discount = 0 at full price)
export function deriveLeadGenPct(args: {
  subtotal: number
  fullTipsInPrice: number
  fullStateTax: number
  fullLocalTax: number
  fullOtherTax: number
  ownDeliveryFee: number
  fullServiceCharge: number
  thirdPartyDeliverySubsiding: number
  fullStripeFee: number
  actualFullTransfer: number
}): number {
  const ex = r2(
    args.subtotal + args.fullTipsInPrice + args.fullStateTax + args.fullLocalTax + args.fullOtherTax
    + args.ownDeliveryFee + args.fullServiceCharge - args.thirdPartyDeliverySubsiding - args.fullStripeFee,
  )
  const leadGenFull = r2(ex - args.actualFullTransfer)
  if (args.subtotal <= 0 || leadGenFull <= 0) return 0
  // FM's lead-gen percentage is a whole integer (Restaurant.leadGenOne/Two: Integer).
  const pct = Math.round((leadGenFull / args.subtotal) * 100)
  return pct >= 0 && pct <= 100 ? pct : 0
}

export const cents = (dollars: number): number => Math.round(dollars * 100)
