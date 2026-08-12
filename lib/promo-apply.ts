import type Stripe from 'stripe'
import { sql } from './db'
import { computeBreakdown, deriveLeadGenPct, r2, cents, type PricingConfig, type PricingOrder } from './promo-pricing'
import { reserveNativeRestaurantPromoUse, finalizeNativeRestaurantPromoUse, releaseNativeRestaurantPromoUse } from './promo-native'

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

interface TaxRatesMirror {
  stateSalesTax?: { percent?: number; fixedAmount?: number }
  localSalesTax?: { percent?: number; fixedAmount?: number }
  otherSalesTax?: { percent?: number; fixedAmount?: number; types?: string[] }
}

// Look up + basic-validate the restaurant-funded code (authoritative discount %).
// This is a PREVIEW-strength check only (same as native's resolveNativeRestaurantPromo)
// — the authoritative gate against a double-submit or a concurrent second order is
// the atomic reservation below, which re-checks both caps right before the charge.
async function resolveCode(code: string, restaurantRef: string, userEmail: string): Promise<{ id: number; pct: number; maxUses: number | null; maxUsesPerUser: number } | null> {
  const rows = (await sql`
    SELECT id, discount_value, valid_from, valid_until, active, max_uses, uses_count, max_uses_per_user
    FROM promo_codes
    WHERE UPPER(code) = UPPER(${code}) AND funded_by = 'RESTAURANT' AND restaurant_ref = ${restaurantRef}
    ORDER BY id DESC LIMIT 1
  `) as { id: number; discount_value: string | number; valid_from: string | null; valid_until: string | null; active: boolean; max_uses: number | null; uses_count: number; max_uses_per_user: number }[]
  const p = rows[0]
  if (!p || !p.active) return null
  const now = Date.now()
  if (p.valid_from && new Date(p.valid_from).getTime() > now) return null
  if (p.valid_until && new Date(p.valid_until).getTime() < now) return null
  if (p.max_uses != null && p.uses_count >= p.max_uses) return null
  const userKey = (userEmail || '').trim().toLowerCase()
  if (userKey) {
    const used = (await sql`SELECT COUNT(*)::int AS c FROM promo_code_uses WHERE promo_code_id = ${p.id} AND LOWER(user_email) = ${userKey}`.catch(() => [{ c: 0 }])) as { c: number }[]
    if ((used[0]?.c ?? 0) >= p.max_uses_per_user) return null
  }
  const pct = num(p.discount_value)
  if (!(pct >= 1 && pct <= 100)) return null
  return { id: p.id, pct, maxUses: p.max_uses, maxUsesPerUser: p.max_uses_per_user }
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

  const resolved = await resolveCode(code, restaurantRef, userEmail)
  if (!resolved) return { applied: false, reason: 'code invalid/expired/inactive' }

  // Tax rates + money-flow from the Neon mirror (the only source at checkout time).
  const mrows = (await sql`SELECT tax_rates, money_flow FROM disco_restaurant_overrides WHERE restaurant_reference = ${restaurantRef} LIMIT 1`) as { tax_rates: TaxRatesMirror | null; money_flow: string | null }[]

  // DIRECT-only gate. Restaurant-funded promo codes can ONLY settle where the
  // restaurant is the merchant of record (FM moneyFlow=DIRECT: a destination charge
  // whose transfer we reduce so the restaurant absorbs the discount). Under
  // FAMILY_MEAL, FamilyMeal is the MoR (plain platform charge, no transfer_data)
  // and the restaurant is paid OUT-OF-BAND from FM's own undiscounted saleTransaction
  // — so reducing the charge would make FamilyMeal, NOT the restaurant, absorb the
  // discount. There is no FM-side lever to fix that (Revyrie gone). So decline.
  // This is a PERMANENT constraint, not a temporary gap.
  if (mrows[0]?.money_flow === 'FAMILY_MEAL') {
    return { applied: false, reason: 'restaurant is FAMILY_MEAL money-flow (FM is merchant of record) — restaurant-funded promos are DIRECT-only' }
  }

  const tax = mrows[0]?.tax_rates
  if (!tax) return { applied: false, reason: 'tax rates not mirrored for restaurant' }

  // FM full-price components.
  const subtotal = num(fmCheckout.subtotal)
  if (subtotal <= 0) return { applied: false, reason: 'no subtotal' }
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

  const order: PricingOrder = {
    subtotal, ownDeliveryFee, thirdPartyDeliveryFee, thirdPartyDeliverySubsiding: subsidy,
    tipCustom, tipAmount: tipVal, tipPct, tipsAreThirdParty,
  }

  // Derive the applied lead-gen % from FM's real full transfer (DIRECT only).
  let leadGenPct = 0
  if (moneyFlow === 'DIRECT') {
    const fullTotalForStripe = piAmount / 100
    const fullStripeFee = r2(fullTotalForStripe * 2.9 / 100 + 0.30)
    leadGenPct = deriveLeadGenPct({
      subtotal, fullTipsInPrice, fullStateTax, fullLocalTax, fullOtherTax,
      ownDeliveryFee, fullServiceCharge, thirdPartyDeliverySubsiding: subsidy,
      fullStripeFee, actualFullTransfer: piTransfer! / 100,
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
  if (cents(full.total) !== piAmount) {
    return { applied: false, reason: `self-check total mismatch: ours=${cents(full.total)}c fm=${piAmount}c` }
  }
  if (moneyFlow === 'DIRECT' && cents(full.transfer) !== piTransfer) {
    return { applied: false, reason: `self-check transfer mismatch: ours=${cents(full.transfer)}c fm=${piTransfer}c` }
  }

  // Self-check passed → the discounted recompute is trustworthy.
  const disc = computeBreakdown(order, cfg, resolved.pct)
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
