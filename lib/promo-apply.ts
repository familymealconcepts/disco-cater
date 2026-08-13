import type Stripe from 'stripe'
import { sql } from './db'
import { computeBreakdown, deriveLeadGenPct, r2, cents, resolveEffectiveDiscountPct, type PricingConfig, type PricingOrder, type Breakdown } from './promo-pricing'
import { reserveNativeRestaurantPromoUse, finalizeNativeRestaurantPromoUse, releaseNativeRestaurantPromoUse } from './promo-native'
import { countPriorPaidOrders } from './pricing/native-order'

// Applies a restaurant-funded promo discount PRE-CHARGE (Path B): recompute FM's
// discounted total + restaurant transfer and adjust the FM-created PaymentIntent's
// amount (+ transfer_data.amount under DIRECT). No refund/reversal/webhook/cron.
//
// SAFETY: before adjusting anything, we reproduce FM's FULL-price total (and, for
// DIRECT, transfer) from our engine and require an EXACT cent match against the
// real PI. Only then do we trust the discounted recompute. Any mismatch, missing
// tax mirror, or non-percentage tip config → we DO NOT apply the discount and
// return a reason, so the customer is never charged a wrong amount.

const num = (v: unknown): number => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

export interface ApplyResult {
  applied: boolean
  reason?: string
  discountPct?: number
  subtotalDiscount?: number      // headline subtotal reduction (for receipts)
  newAmount?: number             // charged total, dollars
  newTransfer?: number | null    // restaurant payout, dollars (null = FAMILY_MEAL)
  moneyFlow?: 'DIRECT' | 'FAMILY_MEAL'
}

export interface TaxRatesMirror {
  stateSalesTax?: { percent?: number; fixedAmount?: number }
  localSalesTax?: { percent?: number; fixedAmount?: number }
  otherSalesTax?: { percent?: number; fixedAmount?: number; types?: string[] }
}

export type RestaurantFundedBreakdownResult =
  | { ok: true; full: Breakdown; discounted: Breakdown }
  | { ok: false; reason: string }

// THE single computation shared by the pricing PREVIEW (/api/order/update's
// FM-backed branch) and real PLACEMENT (applyRestaurantFundedDiscount below) —
// there is exactly one place this math lives, called with the same inputs by
// both. Reproduces FM's FULL-price total (and, for DIRECT, transfer) from our
// own engine and requires an exact cent match against fullPriceTotalCents/
// fullPriceTransferCents before trusting the discounted recompute.
//
// Preview and placement differ only in WHAT they can self-check against, out of
// necessity, not choice: placement has a real Stripe PaymentIntent (the actual
// money), so it self-checks total AND transfer. Preview runs before any
// PaymentIntent exists — the only authoritative number available is FM's own
// just-returned total — so it passes fullPriceTransferCents: null and this
// function simply skips the transfer self-check. That's safe specifically
// because leadGenPct/transfer are mathematically absent from computeBreakdown's
// `total` formula — the customer-facing number preview needs is never affected
// by the piece preview can't verify.
export function computeRestaurantFundedBreakdown(args: {
  fmCheckout: Record<string, unknown>
  serviceChargePct: number
  orderType: string
  taxRates: TaxRatesMirror
  discountPct: number
  moneyFlow: 'DIRECT' | 'FAMILY_MEAL'
  fullPriceTotalCents: number
  fullPriceTransferCents: number | null
}): RestaurantFundedBreakdownResult {
  const { fmCheckout, serviceChargePct, orderType, taxRates: tax, discountPct, moneyFlow, fullPriceTotalCents, fullPriceTransferCents } = args

  const subtotal = num(fmCheckout.subtotal)
  if (subtotal <= 0) return { ok: false, reason: 'no subtotal' }
  const fullServiceCharge = num(fmCheckout.serviceCharge)
  const fullStateTax = num(fmCheckout.stateSalesTaxInPrice)
  const fullLocalTax = num(fmCheckout.localSalesTaxInPrice)
  const fullOtherTax = num(fmCheckout.otherSalesTaxInPrice)
  const ownDeliveryFee = num(fmCheckout.ownDeliveryFee)
  const thirdPartyDeliveryFee = num(fmCheckout.thirdPartyDeliveryFee)
  const fullTipsInPrice = num(fmCheckout.tipsInPrice)
  const fullThirdPartyTips = num(fmCheckout.thirdPartyDeliveryTipsInPrice)
  const subsidy = num(fmCheckout.thirdPartyDeliverySubsiding)
  const tipsAreThirdParty = fullThirdPartyTips > 0

  // Recover the customer's tip config from FM's full-price tip (tip base = subtotal
  // at full price, so tipPct = fullTip/subtotal×100). Custom tips can't be scaled
  // by the discount, so if we can't cleanly recover a % we treat it as custom
  // (unchanged) — the self-check will still verify the full total matches.
  const tipVal = tipsAreThirdParty ? fullThirdPartyTips : fullTipsInPrice
  const tipPctRaw = subtotal > 0 ? (tipVal / subtotal) * 100 : 0
  const tipPct = Math.round(tipPctRaw * 100) / 100
  const tipLooksPercentage = tipVal > 0 && Math.abs(r2(subtotal * tipPct / 100) - tipVal) < 0.005
  const tipCustom = !tipLooksPercentage

  const other = tax.otherSalesTax
  const otherApplies = !!other && (!other.types || other.types.length === 0 || other.types.includes(orderType))

  const order: PricingOrder = {
    subtotal, ownDeliveryFee, thirdPartyDeliveryFee, thirdPartyDeliverySubsiding: subsidy,
    tipCustom, tipAmount: tipVal, tipPct, tipsAreThirdParty,
  }

  // leadGenPct only affects `transfer`, never `total` (see computeBreakdown) — so
  // when there's no transfer figure to derive it from (preview) it's simply 0,
  // which never distorts the customer-facing number either self-check verifies.
  let leadGenPct = 0
  if (moneyFlow === 'DIRECT' && fullPriceTransferCents != null) {
    const fullTotalForStripe = fullPriceTotalCents / 100
    const fullStripeFee = r2(fullTotalForStripe * 2.9 / 100 + 0.30)
    leadGenPct = deriveLeadGenPct({
      subtotal, fullTipsInPrice, fullStateTax, fullLocalTax, fullOtherTax,
      ownDeliveryFee, fullServiceCharge, thirdPartyDeliverySubsiding: subsidy,
      fullStripeFee, actualFullTransfer: fullPriceTransferCents / 100,
    })
  }

  const cfg: PricingConfig = {
    scPct: serviceChargePct,
    stateTax: { percent: num(tax.stateSalesTax?.percent), fixedAmount: num(tax.stateSalesTax?.fixedAmount) },
    localTax: { percent: num(tax.localSalesTax?.percent), fixedAmount: num(tax.localSalesTax?.fixedAmount) },
    otherTax: { percent: num(other?.percent), fixedAmount: num(other?.fixedAmount), applies: otherApplies },
    familyMealPct: 3, stripePct: 2.9, stripeFlat: 0.30, leadGenPct,
  }

  // ── SELF-CHECK: reproduce FM's FULL-price numbers exactly, or bail. ──
  const full = computeBreakdown(order, cfg, 0)
  if (cents(full.total) !== fullPriceTotalCents) {
    return { ok: false, reason: `self-check total mismatch: ours=${cents(full.total)}c ref=${fullPriceTotalCents}c` }
  }
  if (moneyFlow === 'DIRECT' && fullPriceTransferCents != null && cents(full.transfer) !== fullPriceTransferCents) {
    return { ok: false, reason: `self-check transfer mismatch: ours=${cents(full.transfer)}c ref=${fullPriceTransferCents}c` }
  }

  // Self-check passed → the discounted recompute is trustworthy.
  const discounted = computeBreakdown(order, cfg, discountPct)
  return { ok: true, full, discounted }
}

// Look up + basic-validate the restaurant-funded code (flat-$ or percent, with
// cap/min-order/first-time enforcement). This is a PREVIEW-strength check only
// (same as native's resolveNativeRestaurantPromo) — the authoritative gate against
// a double-submit or a concurrent second order is the atomic reservation below,
// which re-checks both caps right before the charge.
//
// subtotal is required (not optional) — same reasoning as resolveNativeRestaurantPromo:
// min_order_subtotal and the flat-$/cap-to-pct conversion both need it, and both
// callers already have fmCheckout.subtotal before calling this. Previously this
// function never looked at discount_type at all — a flat-$ code would have been
// silently read as a percent (confirmed no live row has ever been discount_type='flat',
// so this hasn't actually mispriced anything, but it was a live latent bug).
export async function resolveCode(code: string, restaurantRef: string, subtotal: number, userEmail: string): Promise<{ id: number; pct: number; maxUses: number | null; maxUsesPerUser: number } | null> {
  if (subtotal <= 0) return null
  const rows = (await sql`
    SELECT id, discount_value, discount_type, max_discount_cap, min_order_subtotal, first_time_only,
           valid_from, valid_until, active, max_uses, uses_count, max_uses_per_user
    FROM promo_codes
    WHERE UPPER(code) = UPPER(${code}) AND funded_by = 'RESTAURANT' AND restaurant_ref = ${restaurantRef}
    ORDER BY id DESC LIMIT 1
  `) as {
    id: number; discount_value: string | number; discount_type: 'flat' | 'percent'
    max_discount_cap: string | number | null; min_order_subtotal: string | number | null; first_time_only: boolean
    valid_from: string | null; valid_until: string | null; active: boolean
    max_uses: number | null; uses_count: number; max_uses_per_user: number
  }[]
  const p = rows[0]
  if (!p || !p.active) return null
  const now = Date.now()
  if (p.valid_from && new Date(p.valid_from).getTime() > now) return null
  if (p.valid_until && new Date(p.valid_until).getTime() < now) return null
  if (p.max_uses != null && p.uses_count >= p.max_uses) return null
  const minOrder = p.min_order_subtotal == null ? null : num(p.min_order_subtotal)
  if (minOrder != null && subtotal < minOrder) return null // evaluated against the PRE-discount subtotal
  const userKey = (userEmail || '').trim().toLowerCase()
  if (userKey) {
    const used = (await sql`SELECT COUNT(*)::int AS c FROM promo_code_uses WHERE promo_code_id = ${p.id} AND LOWER(user_email) = ${userKey}`.catch(() => [{ c: 0 }])) as { c: number }[]
    if ((used[0]?.c ?? 0) >= p.max_uses_per_user) return null
    if (p.first_time_only) {
      // Restaurant-scoped, same definition the lead-gen fee tier uses.
      const prior = await countPriorPaidOrders(userKey, restaurantRef)
      if (prior > 0) return null
    }
  }
  const discountValue = num(p.discount_value)
  const maxDiscountCap = p.max_discount_cap == null ? null : num(p.max_discount_cap)
  const pct = resolveEffectiveDiscountPct(subtotal, p.discount_type, discountValue, maxDiscountCap)
  if (!(pct > 0 && pct <= 100)) return null
  return { id: p.id, pct, maxUses: p.max_uses, maxUsesPerUser: p.max_uses_per_user }
}

// Restaurant-scoped tax_rates + money_flow mirror — the only source available at
// checkout time (FM exposes real tax rates only to the restaurant's own admin
// token). Shared by placement and preview so both read the identical row.
export async function getTaxRatesMirror(restaurantRef: string): Promise<{ taxRates: TaxRatesMirror | null; moneyFlow: string | null }> {
  const rows = (await sql`SELECT tax_rates, money_flow FROM disco_restaurant_overrides WHERE restaurant_reference = ${restaurantRef} LIMIT 1`) as { tax_rates: TaxRatesMirror | null; money_flow: string | null }[]
  return { taxRates: rows[0]?.tax_rates ?? null, moneyFlow: rows[0]?.money_flow ?? null }
}

// Preview-side orchestration around computeRestaurantFundedBreakdown — same
// core function applyRestaurantFundedDiscount uses below, called with the
// self-check reference FM's OWN just-returned total (no PaymentIntent exists
// yet at preview time, so there's nothing else authoritative to check against;
// transfer is skipped for the reason documented on computeRestaurantFundedBreakdown
// itself). Never touches Stripe or the atomic reservation — those only matter
// once there's a real charge to gate, which is placement's job, not preview's.
export async function previewRestaurantFundedDiscount(args: {
  restaurantRef: string
  code: string
  serviceChargePct: number
  orderType: string
  fmCheckout: Record<string, unknown>
  userEmail: string
}): Promise<{ applied: true; breakdown: Breakdown } | { applied: false; reason: string }> {
  const { restaurantRef, code, serviceChargePct, orderType, fmCheckout, userEmail } = args

  const subtotal = num(fmCheckout.subtotal)
  const resolved = await resolveCode(code, restaurantRef, subtotal, userEmail)
  if (!resolved) return { applied: false, reason: 'code invalid/expired/inactive' }

  const mirror = await getTaxRatesMirror(restaurantRef)
  if (mirror.moneyFlow === 'FAMILY_MEAL') return { applied: false, reason: 'FAMILY_MEAL money-flow — restaurant-funded promos are DIRECT-only' }
  const tax = mirror.taxRates
  if (!tax) return { applied: false, reason: 'tax rates not mirrored for restaurant' }

  const fullTotalCents = cents(num(fmCheckout.total))
  if (fullTotalCents <= 0) return { applied: false, reason: 'no total in FM response' }

  const result = computeRestaurantFundedBreakdown({
    fmCheckout, serviceChargePct, orderType, taxRates: tax, discountPct: resolved.pct,
    moneyFlow: 'DIRECT', // preview never sees FAMILY_MEAL past the gate above
    fullPriceTotalCents: fullTotalCents, fullPriceTransferCents: null,
  })
  if (!result.ok) return { applied: false, reason: result.reason }
  return { applied: true, breakdown: result.discounted }
}

export async function applyRestaurantFundedDiscount(args: {
  stripe: Stripe
  paymentIntentId: string
  restaurantRef: string
  code: string
  serviceChargePct: number         // from the order's menu settings (client-supplied; self-check validates it)
  orderType: string                // 'PICKUP' | 'DELIVERY' (for otherTax.types gate)
  fmCheckout: Record<string, unknown>  // FM's full-price CheckoutPublicResponseDto
  orderRef: string                 // for recording the use (usage-limit enforcement) idempotently
  userEmail: string
}): Promise<ApplyResult> {
  const { stripe, paymentIntentId, restaurantRef, code, serviceChargePct, orderType, fmCheckout, orderRef, userEmail } = args
  if (!paymentIntentId) return { applied: false, reason: 'no payment intent' }

  const subtotal = num(fmCheckout.subtotal)
  const resolved = await resolveCode(code, restaurantRef, subtotal, userEmail)
  if (!resolved) return { applied: false, reason: 'code invalid/expired/inactive' }

  // DIRECT-only gate. Restaurant-funded promo codes can ONLY settle where the
  // restaurant is the merchant of record (FM moneyFlow=DIRECT: a destination charge
  // whose transfer we reduce so the restaurant absorbs the discount). Under
  // FAMILY_MEAL, FamilyMeal is the MoR (plain platform charge, no transfer_data)
  // and the restaurant is paid OUT-OF-BAND from FM's own undiscounted saleTransaction
  // — so reducing the charge would make FamilyMeal, NOT the restaurant, absorb the
  // discount. There is no FM-side lever to fix that (Revyrie gone). So decline.
  // This is a PERMANENT constraint, not a temporary gap.
  const mirror = await getTaxRatesMirror(restaurantRef)
  if (mirror.moneyFlow === 'FAMILY_MEAL') {
    return { applied: false, reason: 'restaurant is FAMILY_MEAL money-flow (FM is merchant of record) — restaurant-funded promos are DIRECT-only' }
  }
  const tax = mirror.taxRates
  if (!tax) return { applied: false, reason: 'tax rates not mirrored for restaurant' }

  // Retrieve the authoritative PI (amount + transfer_data for DIRECT).
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId)
  const piAmount = pi.amount ?? 0
  const piTransfer = pi.transfer_data?.amount
  const moneyFlow: 'DIRECT' | 'FAMILY_MEAL' = piTransfer != null ? 'DIRECT' : 'FAMILY_MEAL'
  // Defense-in-depth for the DIRECT-only gate: the ABSENCE of transfer_data on the
  // FM-created PI is the real-time proof that FM is the merchant of record
  // (FAMILY_MEAL) — catches it even if the money_flow mirror is missing/stale.
  if (moneyFlow !== 'DIRECT') {
    return { applied: false, reason: 'PI has no transfer_data (FM is merchant of record) — restaurant-funded promos are DIRECT-only' }
  }

  const result = computeRestaurantFundedBreakdown({
    fmCheckout, serviceChargePct, orderType, taxRates: tax, discountPct: resolved.pct,
    moneyFlow, fullPriceTotalCents: piAmount, fullPriceTransferCents: piTransfer ?? null,
  })
  if (!result.ok) return { applied: false, reason: result.reason }
  const disc = result.discounted

  const newAmount = cents(disc.total)
  const newTransfer = moneyFlow === 'DIRECT' ? cents(disc.transfer) : null
  if (newAmount <= 0 || newAmount >= piAmount) return { applied: false, reason: 'discount produced no reduction' }
  if (newTransfer != null && (newTransfer <= 0 || newTransfer >= piTransfer!)) return { applied: false, reason: 'transfer reduction invalid' }

  // Reserve the cap slot ATOMICALLY before touching the real charge — same
  // guarantee as native's reserveNativeRestaurantPromoUse (lib/promo-native.ts,
  // reused directly: it's a generic promo_codes/promo_code_uses primitive with
  // no native-specific fields, not a unification of the two pricing paths).
  // The FM order + PaymentIntent already exist at full price by the time this
  // runs (FM created them when placing the order) — reserving first means a
  // lost race refuses the PROMO before ever touching the PI, instead of
  // applying the discount and only discovering afterward that a concurrent
  // request already exhausted the cap.
  const reservation = await reserveNativeRestaurantPromoUse({
    promoId: resolved.id, userEmail, maxUses: resolved.maxUses, maxUsesPerUser: resolved.maxUsesPerUser, restaurantRef,
  })
  if (!reservation.ok) {
    return {
      applied: false,
      reason: reservation.reason === 'max_uses' ? 'promo code has reached its usage limit' : 'diner has already used this promo code the maximum number of times',
    }
  }

  try {
    await stripe.paymentIntents.update(paymentIntentId, {
      amount: newAmount,
      ...(newTransfer != null ? { transfer_data: { amount: newTransfer } } : {}),
    })
  } catch (e) {
    // The reservation held a slot for a charge that never actually changed —
    // give it back rather than burning it on a failed Stripe call.
    await releaseNativeRestaurantPromoUse(reservation.reservationId, resolved.id)
    return { applied: false, reason: `Stripe update failed: ${e instanceof Error ? e.message : String(e)}` }
  }

  // Attach the real order/PI to the reservation now that the charge is
  // actually discounted. Best-effort: the charge is already correct even if
  // this bookkeeping write fails.
  await finalizeNativeRestaurantPromoUse(reservation.reservationId, {
    orderRef, discountDollars: disc.discount, paymentIntentId,
  })

  return {
    applied: true,
    discountPct: resolved.pct,
    subtotalDiscount: disc.discount,
    newAmount: newAmount / 100,
    newTransfer: newTransfer != null ? newTransfer / 100 : null,
    moneyFlow,
  }
}
