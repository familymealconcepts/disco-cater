// Native (zero-FM) order lifecycle for Disco-native restaurants: price a cart
// (init) and persist a placed order (place). The actual Stripe charge is Stage 1f;
// place leaves the order in RESERVED (pre-payment), and the existing Stripe webhook
// flips RESERVED→DUE on payment_intent.succeeded.

import type Stripe from 'stripe'
import { sql, withDiscoTables } from '../db'
import { priceNativeOrder, type Fulfillment, type NativePricedOrder } from '../pricing/native-order'
import { createNativeOrderPaymentIntent, getRestaurantPayoutConfig, getOrCreateStripeCustomer } from './native-payment'
import { computeThirdPartyDelivery, menuRowToScheduleExtras, type DeliverySettings, type MenuSettingsRow } from '../menu-settings'
import { cents, discountedBase } from '../promo-pricing'
import { buildNativeScheduleOption, type NativeScheduleConfig } from '../scheduling/native-schedule'
import { isDateTimeBookable } from '../scheduling/cutoffs'
import { validateNativeDelivery, type NativeDeliveryAddress } from './native-delivery'
import { resolveNativeRestaurantPromo, type NativePromoResolution, type NativePromoReason } from '../promo-native'

export interface NativeCartItem {
  reference?: string; name: string; price: number; quantity: number
  // Base unit price (excluding add-ons) + the itemized add-ons. `price` stays the
  // FOLDED unit price (base + add-ons) so the money math is unchanged; basePrice +
  // addOns are stored separately so the PDF/emails can show itemized "+" sub-lines.
  basePrice?: number
  addOns?: { name: string; price: number; quantity: number }[]
  // Which disco_menus row (by its UUID `reference`) this item's menu tab came
  // from, tagged client-side. Absent for legacy clients / FM-backed carts —
  // callers must treat that as "unknown", not "primary menu", and fall back
  // explicitly (see resolveCartMenuReference).
  menuReference?: string
}
export interface NativeTip { custom: boolean; amount?: number; pct?: number }
export interface NativeDeliveryAddressInput {
  addressLine1?: string; addressLine2?: string; city?: string; state?: string
  zip?: string; zipcode?: string; latitude?: number; longitude?: number
}

export interface NativeCheckoutInput {
  restaurantReference: string
  customerEmail: string
  fulfillment: Fulfillment
  items: NativeCartItem[]
  tip?: NativeTip
  deliveryFee?: number                 // customer-facing delivery fee (third-party: net of subsidy)
  thirdPartyDeliverySubsiding?: number // restaurant's subsidy share (off its payout)
  discountPct?: number
  scPct?: number
  // 1P Direct URL ('FAMILYMEAL') vs 3P marketplace URL ('DISCO', default). Drives
  // both source_of_order and lead-gen suppression (see priceNativeOrder).
  sourceOfOrder?: 'DISCO' | 'FAMILYMEAL'
}

export interface NativePlaceInput extends NativeCheckoutInput {
  customerFirstName?: string
  customerLastName?: string
  customerPhone?: string
  orderDate: string  // yyyy-mm-dd
  orderTime: string  // HH:mm
  deliveryAddress?: NativeDeliveryAddressInput
  note?: string | null
  deliveryInstructions?: string | null
  companyName?: string | null
  persons?: number | null
  // Initial order_status. Defaults to RESERVED (card flow, pre-payment). The
  // native invoice flow (M7) passes 'UNPAID' — the order exists with no charge and
  // is settled later via a Stripe invoice.
  orderStatus?: string
}

// Whether a restaurant reference is a Disco-native restaurant (no FM record).
// Native restaurants must never hit FM — the order routes branch on this.
export async function isDiscoNativeRestaurant(ref: string): Promise<boolean> {
  if (!ref) return false
  const rows = (await sql`
    SELECT 1 FROM disco_restaurant_cache
    WHERE restaurant_reference = ${ref} AND is_disco_native = true LIMIT 1
  `.catch(() => [])) as unknown[]
  return rows.length > 0
}

const round2 = (n: number) => Math.round(n * 100) / 100

// The service-charge % for a native order. service_charge_pct is a per-MENU
// setting (_MenuForm.tsx), not restaurant-level — a restaurant can legitimately
// have menus at different %, same as delivery method below. When menuReference
// is known, look up that exact menu. FALLBACK ONLY when it's not (no items
// tagged — an old client, or a cart with zero menu-tagged items): guess the
// restaurant's "primary" (lowest position/id) visible menu, same as before
// this fix. Authoritative either way: the client never dictates it.
export async function loadRestaurantServiceChargePct(restaurantReference: string, menuReference?: string): Promise<number> {
  if (menuReference) {
    const exact = (await sql`
      SELECT service_charge_pct FROM disco_menus
      WHERE restaurant_reference = ${restaurantReference}::uuid AND reference = ${menuReference}::uuid
      LIMIT 1
    `.catch(() => [])) as { service_charge_pct: string | number | null }[]
    if (exact.length) {
      const v = exact[0].service_charge_pct
      return v != null && Number.isFinite(Number(v)) ? Number(v) : 0
    }
    console.warn('[native-checkout] loadRestaurantServiceChargePct: tagged menuReference not found, falling back to primary-menu guess', { restaurantReference, menuReference })
  }
  const rows = (await sql`
    SELECT service_charge_pct FROM disco_menus
    WHERE restaurant_reference = ${restaurantReference}::uuid AND visible = true AND archived = false
    ORDER BY position, id LIMIT 1
  `.catch(() => [])) as { service_charge_pct: string | number | null }[]
  const v = rows[0]?.service_charge_pct
  return v != null && Number.isFinite(Number(v)) ? Number(v) : 0
}

// The delivery method (OWN_DELIVERY vs THIRD_PARTY) for the menu the cart's
// items actually came from. Delivery method is a per-MENU setting, not
// restaurant-level — a restaurant can legitimately have one menu on
// third-party delivery and another self-delivered (see Winkin' Rooster vs
// DeCheco's - Munroe Falls). When menuReference is known, look up that exact
// menu. FALLBACK ONLY when it's not (no items tagged — an old client, or a
// cart with zero delivery-settings-bearing items): guess the restaurant's
// "primary" (lowest position/id) visible menu, same as before this fix. This
// fallback is real prior behavior, not a guess this function invented — every
// call site must know it's degraded when it hits this branch.
export async function loadRestaurantDeliverySettings(restaurantReference: string, menuReference?: string): Promise<DeliverySettings | null> {
  if (menuReference) {
    const exact = (await sql`
      SELECT delivery_settings FROM disco_menus
      WHERE restaurant_reference = ${restaurantReference}::uuid AND reference = ${menuReference}::uuid
      LIMIT 1
    `.catch(() => [])) as { delivery_settings: DeliverySettings | null }[]
    if (exact.length) return exact[0].delivery_settings || null
    console.warn('[native-checkout] loadRestaurantDeliverySettings: tagged menuReference not found, falling back to primary-menu guess', { restaurantReference, menuReference })
  }
  const rows = (await sql`
    SELECT delivery_settings FROM disco_menus
    WHERE restaurant_reference = ${restaurantReference}::uuid AND visible = true AND archived = false
    ORDER BY position, id LIMIT 1
  `.catch(() => [])) as { delivery_settings: DeliverySettings | null }[]
  return rows[0]?.delivery_settings || null
}

export interface MenuFulfillmentAvailability { offersPickup: boolean; offersDelivery: boolean }

// Which order types a menu accepts (disco_menus.offers_pickup / offers_delivery,
// both default true — see menuRowToSettings/menuAvailability, which the client
// already reads to disable an unavailable toggle). A restaurant can legitimately
// run normal catering as pickup+delivery and a holiday menu as pickup-only; this
// is the server-side half of that — the client-side disabled button doesn't stop
// a direct API call. Same exact-match-then-explicit-fallback shape as
// loadRestaurantDeliverySettings/loadRestaurantServiceChargePct.
export async function loadMenuFulfillmentAvailability(restaurantReference: string, menuReference?: string): Promise<MenuFulfillmentAvailability> {
  if (menuReference) {
    const exact = (await sql`
      SELECT offers_pickup, offers_delivery FROM disco_menus
      WHERE restaurant_reference = ${restaurantReference}::uuid AND reference = ${menuReference}::uuid
      LIMIT 1
    `.catch(() => [])) as { offers_pickup: boolean | null; offers_delivery: boolean | null }[]
    if (exact.length) {
      return { offersPickup: exact[0].offers_pickup !== false, offersDelivery: exact[0].offers_delivery !== false }
    }
    console.warn('[native-checkout] loadMenuFulfillmentAvailability: tagged menuReference not found, falling back to primary-menu guess', { restaurantReference, menuReference })
  }
  const rows = (await sql`
    SELECT offers_pickup, offers_delivery FROM disco_menus
    WHERE restaurant_reference = ${restaurantReference}::uuid AND visible = true AND archived = false
    ORDER BY position, id LIMIT 1
  `.catch(() => [])) as { offers_pickup: boolean | null; offers_delivery: boolean | null }[]
  return { offersPickup: rows[0]?.offers_pickup !== false, offersDelivery: rows[0]?.offers_delivery !== false }
}

// The delivery time-window granularity ('exact' | '30_min' | '1_hour') the
// restaurant configured (disco_restaurant_overrides.delivery_order_time_windows).
// Snapshotted onto a delivery order so emails/PDF/confirmation show the RANGE
// (via formatTimeWindow), not just the exact start time. Null → 'exact'.
export async function loadDeliveryTimeWindow(restaurantReference: string): Promise<string | null> {
  const rows = (await sql`
    SELECT delivery_order_time_windows FROM disco_restaurant_overrides
    WHERE restaurant_reference = ${restaurantReference} LIMIT 1
  `.catch(() => [])) as { delivery_order_time_windows: string | null }[]
  const w = rows[0]?.delivery_order_time_windows
  return typeof w === 'string' && w ? w : null
}

// Online-ordering hard gate: a Disco-native restaurant is "open" for orders unless
// it has explicitly paused online ordering (online_ordering_enabled = false). A
// missing overrides row counts as open (COALESCE → true) — see lib/db.ts. The
// native order routes call this before pricing/placing so a paused restaurant can
// never take an order, even via a direct API call.
export async function isNativeOrderingOpen(restaurantReference: string): Promise<boolean> {
  const rows = (await sql`
    SELECT COALESCE(o.online_ordering_enabled, true) AS enabled
    FROM disco_restaurant_cache c
    LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
    WHERE c.restaurant_reference = ${restaurantReference} LIMIT 1
  `.catch(() => [])) as { enabled: boolean }[]
  return rows.length === 0 ? true : rows[0].enabled !== false
}

// Server-side backup for the Closed Days / Closed Holidays block: true when the
// order date falls inside any restaurant-wide closed-day range (holiday dates are
// stored as one-day ranges). The customer date picker already hides these; this is
// the server backstop so a direct API call can't order on a closed date.
export async function isNativeDateClosed(restaurantReference: string, orderDate: string): Promise<boolean> {
  if (!orderDate) return false
  const rows = (await sql`
    SELECT 1 FROM disco_restaurant_closed_days
    WHERE restaurant_reference = ${restaurantReference}::uuid
      AND from_date <= ${orderDate}::date AND to_date >= ${orderDate}::date
    LIMIT 1
  `.catch(() => [])) as unknown[]
  return rows.length > 0
}

// Daily order-capacity gate: the restaurant's primary visible menu may set
// max_orders_per_day (NULL = no cap — the default, and the only behavior
// before this existed since nothing read the column). When set, a new order
// is blocked once that many still-active orders already exist for the same
// restaurant + date. "Still-active" excludes CART (never placed),
// CANCELED/CANCELLED/REFUND/REFUNDED/EXPIRED/VOID/VOIDED/PAYMENT_FAILED (no
// longer real orders occupying capacity) — everything else (RESERVED/DUE/
// UNPAID/PAID/COMPLETED/PARTIAL_REFUND/REOPEN) counts, including pre-payment
// RESERVED/UNPAID rows, so two concurrent checkouts can't both slip in under
// the cap while waiting on payment confirmation.
export async function isNativeDailyCapReached(restaurantReference: string, orderDate: string): Promise<boolean> {
  if (!orderDate) return false
  const capRows = (await sql`
    SELECT max_orders_per_day FROM disco_menus
    WHERE restaurant_reference = ${restaurantReference}::uuid AND visible = true AND archived = false
    ORDER BY position, id LIMIT 1
  `.catch(() => [])) as { max_orders_per_day: number | null }[]
  const cap = capRows[0]?.max_orders_per_day
  if (cap == null) return false
  const countRows = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_orders
    WHERE restaurant_reference = ${restaurantReference}::uuid
      AND order_date = ${orderDate}::date
      AND order_status IN ('RESERVED','DUE','UNPAID','PAID','COMPLETED','PARTIAL_REFUND','REOPEN')
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  return (countRows[0]?.n ?? 0) >= cap
}

// Server-side re-validation of the SAME scheduling rules the checkout UI
// already enforces client-side (lib/scheduling/cutoffs.ts) — lead time, daily/
// hard cutoff, day-of-week pickup window, Custom [startDate, endDate]
// availability, and per-menu skipped days. Built from the restaurant's primary
// (lowest-position, visible) menu, exactly like the customer render path
// (app/(customer)/restaurants/[slug]/shared.tsx) builds its scheduleOption —
// same source data, same cutoffs.ts logic — so client and server can never
// disagree about what's bookable. This is the backstop for a request that
// bypasses the picker entirely (a direct API call): the UI hides invalid
// dates/times, this actually blocks them. Restaurant-wide closed days are
// checked separately by isNativeDateClosed; a missing menu row (nothing to
// validate against) passes, matching the client's ungated default.
export async function isNativeDateTimeValid(restaurantReference: string, orderDate: string, orderTime: string): Promise<boolean> {
  if (!orderDate || !orderTime) return false
  const rows = (await sql`
    SELECT schedule_config, availability_mode,
           to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
           lead_time_hours, rolling_availability_days, max_orders_per_day,
           to_char(daily_cutoff_time, 'HH24:MI') AS daily_cutoff_time,
           to_char(hard_cutoff_date, 'YYYY-MM-DD') AS hard_cutoff_date,
           skipped_days
    FROM disco_menus
    WHERE restaurant_reference = ${restaurantReference}::uuid AND visible = true AND archived = false
    ORDER BY position, id LIMIT 1
  `.catch(() => [])) as (MenuSettingsRow & {
    schedule_config: NativeScheduleConfig | null; availability_mode: string | null
    start_date: string | null; end_date: string | null
    skipped_days: { fromDate: string; toDate: string }[] | null
  })[]
  const primary = rows[0]
  if (!primary) return true
  const scheduleOption = {
    ...buildNativeScheduleOption(primary.schedule_config, primary.availability_mode, primary.start_date, primary.end_date),
    ...menuRowToScheduleExtras(primary),
    ...(Array.isArray(primary.skipped_days) && primary.skipped_days.length ? { skippedDays: primary.skipped_days } : {}),
  }
  return isDateTimeBookable(scheduleOption, orderDate, orderTime)
}

export function cartSubtotal(items: NativeCartItem[]): number {
  return round2((items || []).reduce((s, it) => s + (Number(it.price) || 0) * Math.max(1, Math.trunc(Number(it.quantity) || 1)), 0))
}

// Which menu an order's cart actually came from. The checkout UI blocks mixing
// menus with DIFFERENT delivery methods (see RestaurantClient.tsx's
// addItemWithConfig), but mixing menus with the SAME method is allowed — so a
// cart can legitimately carry more than one distinct menuReference. In that
// case any one of them resolves to the correct delivery_settings (they agree
// by construction), so the first is as good as any. Returns undefined — never
// a guess — when items carry no tag at all (old/legacy client) or, as a safety
// net, when the client-side mixing guard was somehow bypassed and the cart's
// menus actually disagree on delivery method; callers must treat undefined as
// "fall back to the old primary-menu behavior, explicitly", not silently
// substitute one menu for another.
export function resolveCartMenuReference(items: NativeCartItem[]): string | undefined {
  const refs = Array.from(new Set((items || []).map(it => it.menuReference).filter((r): r is string => !!r)))
  if (refs.length === 0) return undefined
  return refs[0]
}

export interface PriceNativeCartInput {
  restaurantReference: string
  customerEmail: string
  items: NativeCartItem[]
  orderType: 'PICKUP' | 'DELIVERY'
  // Present at real placement (and the /validate-address step) once the diner
  // has entered a real address; absent during the FIRST pricing preview
  // (/api/order/init|update), which has never geocoded anything. Own-delivery's
  // fee is distance-dependent and stays deferred (0) until an address exists —
  // unchanged from before this fix. Third-party's fee needs no address at all
  // (courier fee is subtotal-only), so it prices correctly either way.
  deliveryAddress?: NativeDeliveryAddressInput
  tip: NativeTip
  // Restaurant-funded promo code (M6). Resolved HERE — before delivery is
  // priced — so the 3P 15%/$85-cap and own-delivery tiers see the DISCOUNTED
  // subtotal, same as tax/fee/lead-gen. This is the fix for the bug where
  // validateNativeDelivery was called with the raw pre-discount subtotal.
  restaurantPromoCode?: string | null
  sourceOfOrder?: 'DISCO' | 'FAMILYMEAL'
}

export interface PriceNativeCartResult {
  breakdown: NativePricedOrder & { subtotal: number; discountedSubtotal: number }
  fulfillment: Fulfillment
  deliveryFee: number
  thirdPartyDeliverySubsiding: number
  promo: NativePromoResolution | null
  // Set whenever a restaurantPromoCode was submitted but didn't resolve — null
  // whenever no code was submitted at all (never conflate "no code" with "code
  // failed"). See lib/promo-native.ts's NativePromoReason for the full set; callers
  // map this to a diner-facing message rather than showing it verbatim.
  promoError: NativePromoReason | null
  // Delivery serviceability — false only when an address was supplied and it's
  // out of range / ungeocodable. Always true when deliveryAddress is absent
  // (preview) or orderType is PICKUP.
  deliveryValid: boolean
  deliveryMessage?: string
  // The menu this cart's items actually came from (see resolveCartMenuReference) —
  // exposed so callers that need it downstream (e.g. buildNativePlaceInput's own
  // service-charge lookup) don't have to recompute it from input.items themselves.
  menuReference?: string
}

// THE single function that prices a native cart — resolves the restaurant
// promo, derives the discounted subtotal ONCE (lib/promo-pricing.ts's
// discountedBase, the same formula computeBreakdown uses internally), prices
// delivery off THAT discounted figure, then calls priceNativeOrder with the
// resolved discountPct. Both the pricing preview (priceNativeFmDto, below) and
// real placement (lib/order/native-place-checkout.ts's buildNativePlaceInput)
// call this — there is no second path that can drift from it.
export async function priceNativeCart(input: PriceNativeCartInput): Promise<PriceNativeCartResult> {
  const subtotal = cartSubtotal(input.items)
  const promoResult = input.restaurantPromoCode
    ? await resolveNativeRestaurantPromo(input.restaurantPromoCode, input.restaurantReference, subtotal, input.customerEmail)
    : null
  const promo = promoResult?.resolution ?? null
  const promoError = promoResult?.reason ?? null
  if (promoError) {
    // A code was submitted but didn't resolve — log with enough context to
    // diagnose which restaurant/code/reason, same as the FM-backed self-check
    // failure (lib/promo-apply.ts). Never throws; the order still prices at full
    // price, the caller (priceNativeFmDto) surfaces this to the diner instead of
    // silently showing an undiscounted total.
    console.error(`[native-checkout] restaurant-funded promo not applied: restaurant=${input.restaurantReference} code=${input.restaurantPromoCode} reason=${promoError}`)
  }
  const discountPct = promo?.pct ?? 0
  const discountedSubtotal = discountedBase(subtotal, discountPct)

  // The menu this cart's items actually came from — the one signal that
  // decides delivery method below. undefined (not a guess) when items carry
  // no tag; both calls below fall back to the old primary-menu guess
  // explicitly in that case, rather than this function silently picking one.
  const menuReference = resolveCartMenuReference(input.items)

  let fulfillment: Fulfillment = 'PICKUP'
  let deliveryFee = 0
  let thirdPartyDeliverySubsiding = 0
  let deliveryValid = true
  let deliveryMessage: string | undefined

  if (input.orderType === 'DELIVERY') {
    if (input.deliveryAddress) {
      // Real address known — validateNativeDelivery is the single authority for
      // BOTH own- and third-party fees; feed it the DISCOUNTED subtotal.
      const dv = await validateNativeDelivery(input.restaurantReference, input.deliveryAddress as NativeDeliveryAddress, discountedSubtotal, undefined, menuReference)
      fulfillment = dv.fulfillment
      deliveryFee = dv.deliveryFee
      thirdPartyDeliverySubsiding = dv.thirdPartyDeliverySubsiding
      deliveryValid = dv.valid
      deliveryMessage = dv.message
    } else {
      // No address yet (initial preview). Third-party needs none; own-delivery
      // stays deferred to the address-known call above (same as before this fix).
      const del = await loadRestaurantDeliverySettings(input.restaurantReference, menuReference)
      if (del?.method === 'OWN_DELIVERY') {
        fulfillment = 'OWN_DELIVERY'
      } else {
        fulfillment = 'THIRD_PARTY_DELIVERY'
        const tp = computeThirdPartyDelivery(discountedSubtotal, del?.thirdPartySubsidyPct ?? 0)
        deliveryFee = tp.customerFee
        thirdPartyDeliverySubsiding = tp.subsidy
      }
    }
  }

  const scPct = await loadRestaurantServiceChargePct(input.restaurantReference, menuReference)
  const breakdown = await priceNativeOrder({
    restaurantReference: input.restaurantReference,
    customerEmail: input.customerEmail,
    subtotal,
    fulfillment,
    deliveryFee,
    thirdPartyDeliverySubsiding,
    scPct,
    tip: input.tip,
    discountPct,
    sourceOfOrder: input.sourceOfOrder,
  })

  return {
    breakdown: { ...breakdown, subtotal, discountedSubtotal },
    fulfillment,
    deliveryFee,
    thirdPartyDeliverySubsiding,
    promo,
    promoError,
    deliveryValid,
    deliveryMessage,
    menuReference,
  }
}

// Price a native cart. Returns the full cent-exact breakdown (customer `total`,
// restaurant `transfer`, and every withheld component). No persistence.
export async function priceNativeCheckout(input: NativeCheckoutInput): Promise<NativePricedOrder & { subtotal: number }> {
  const subtotal = cartSubtotal(input.items)
  const breakdown = await priceNativeOrder({
    restaurantReference: input.restaurantReference,
    customerEmail: input.customerEmail,
    subtotal,
    fulfillment: input.fulfillment,
    deliveryFee: input.deliveryFee,
    thirdPartyDeliverySubsiding: input.thirdPartyDeliverySubsiding,
    scPct: input.scPct,
    tip: input.tip ?? { custom: false, pct: 0 },
    discountPct: input.discountPct,
    sourceOfOrder: input.sourceOfOrder,
  })
  return { ...breakdown, subtotal }
}

// ── Client (FM-DTO) adapter for the pricing preview ──────────────────────────
// The customer checkout (CheckoutDrawer/buildCheckoutPayload) sends an FM-shaped
// DTO to /api/order/init|update. For a Disco-native restaurant we price it in Neon
// and return the SAME FM response shape (data.checkoutPublicResponseDto) the client
// already reads (extractFmMoney), so no client changes are needed for pricing.
// NOTE: the customer-facing TOTAL does not depend on lead-gen (that's withheld from
// the restaurant payout), so pricing needs no customer session — safe for previews.

interface FmDtoAddOn { name?: string; price?: number; count?: number; quantity?: number }
interface FmDtoItem { reference?: string; name?: string; price?: number; count?: number; extraItems?: FmDtoAddOn[]; addOns?: FmDtoAddOn[]; menuReference?: string }

// Map FM-shaped checkout items → native cart items, folding each line's add-on
// prices into the unit price and count→quantity, so cartSubtotal matches FM's
// own line math.
export function fmItemsToNativeCart(items: FmDtoItem[] | undefined): NativeCartItem[] {
  return (items || []).map((it, i) => {
    // Accept add-ons as `addOns` (carries names) or the legacy `extraItems`.
    const raw = Array.isArray(it.addOns) ? it.addOns : Array.isArray(it.extraItems) ? it.extraItems : []
    const addOns = raw.map((e) => ({
      name: String(e.name || 'Add-on'),
      price: Number(e.price) || 0,
      quantity: Math.max(1, Math.trunc(Number(e.count ?? e.quantity) || 1)),
    }))
    const addOnTotal = addOns.reduce((a, e) => a + e.price * e.quantity, 0)
    const base = Number(it.price) || 0
    return {
      reference: it.reference,
      name: it.name || `item-${i}`,
      basePrice: base,
      // Folded unit price keeps cartSubtotal + all pricing byte-for-byte unchanged.
      price: base + addOnTotal,
      quantity: Math.max(1, Math.trunc(Number(it.count) || 1)),
      addOns: addOns.length ? addOns : undefined,
      menuReference: typeof it.menuReference === 'string' && it.menuReference ? it.menuReference : undefined,
    }
  })
}

// Diner-facing wording for a failed restaurant-funded promo resolution — never
// shows the internal reason verbatim. Same two-tier approach as the FM-backed
// path's mapping (app/api/order/update|init/route.ts): a specific message for
// ordinary rejections the diner can act on, one generic fallback for everything
// else (including the two genuine config-problem reasons, invalid discount value
// and FAMILY_MEAL money-flow, which a diner can't do anything about besides
// removing the code).
function dinerMessageForNativePromoReason(reason: NativePromoReason): string {
  switch (reason) {
    case 'code not found':
    case 'inactive':
    case 'not yet valid':
    case 'expired':
    case 'invalid input':
      return 'This promo code is invalid or has expired.'
    case 'max uses reached':
    case 'per-user max uses reached':
      return 'This promo code has reached its usage limit.'
    case 'below minimum order subtotal':
      return 'This promo code doesn’t meet the minimum order requirement.'
    case 'not a first-time customer at this restaurant':
      return 'This promo code is for first-time customers only.'
    default:
      return 'This promo code can’t be applied right now. You can remove it and check out at full price.'
  }
}

// Price an FM-shaped checkout DTO for a native restaurant and return the FM
// response envelope the client already understands. Delivery is third-party (Disco
// uses Expedite for all delivery); own-delivery + real delivery fees arrive with
// Stage 6 settings.
export async function priceNativeFmDto(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const restaurantRef = String(body?.restaurantRef || body?.restaurantReference || '')
  const orderType = String(body?.orderType || 'PICKUP') === 'DELIVERY' ? 'DELIVERY' : 'PICKUP'
  const tipsType = String(body?.tipsType || 'PERCENTAGE')
  const tips = Number(body?.tips) || 0
  const items = fmItemsToNativeCart(body?.items as FmDtoItem[])
  const restaurantPromoCode = typeof body?.restaurantPromoCode === 'string' ? body.restaurantPromoCode : null

  // Same priceNativeCart() the real placement path calls (native-place-checkout.ts) —
  // resolves the promo, prices delivery off the DISCOUNTED subtotal, then prices the
  // whole order. No address here (the preview has never geocoded anything); own-
  // delivery's distance-based fee stays deferred to /validate-address, unchanged.
  const priced = await priceNativeCart({
    restaurantReference: restaurantRef,
    customerEmail: '', // total is lead-gen-independent; place() resolves the real customer
    items,
    orderType,
    tip: tipsType === 'CUSTOM' ? { custom: true, amount: tips } : { custom: false, pct: tips },
    restaurantPromoCode,
  })
  const b = priced.breakdown
  const tipsInPrice = round2(b.tipsInPrice + b.thirdPartyDeliveryTips)
  return {
    native: true,
    data: {
      orderReference: 'native',
      checkoutPublicResponseDto: {
        subtotal: b.subtotal,
        fee: b.familyMealFee,
        serviceCharge: b.serviceCharge,
        stateSalesTaxInPrice: b.stateTax,
        localSalesTaxInPrice: b.localTax,
        otherSalesTaxInPrice: b.otherTax,
        deliveryFee: priced.deliveryFee,
        tipsInPrice,
        discount: b.discount,
        total: b.total,
      },
    },
    // Sibling of `data`, not nested inside the FM-shaped DTO — same convention as
    // the FM-backed path's restaurantPromoError (app/api/order/update|init).
    // Present ONLY when a code was submitted and failed to resolve; a diner who
    // submitted no code never sees this key at all.
    ...(restaurantPromoCode && priced.promoError ? { restaurantPromoError: dinerMessageForNativePromoReason(priced.promoError) } : {}),
  }
}

async function nextNativeOrderNumber(): Promise<number> {
  const rows = (await sql`SELECT nextval('disco_native_order_seq')::bigint AS n`) as { n: string | number }[]
  return Number(rows[0].n)
}

function fulfillmentToTypes(f: Fulfillment): { orderType: 'PICKUP' | 'DELIVERY'; deliveryType: string | null } {
  if (f === 'PICKUP') return { orderType: 'PICKUP', deliveryType: 'PICKUP' }
  if (f === 'OWN_DELIVERY') return { orderType: 'DELIVERY', deliveryType: 'OWN_DELIVERY' }
  return { orderType: 'DELIVERY', deliveryType: 'THIRD_PARTY_DELIVERY' }
}

export interface NativePlaceResult {
  orderId: number
  orderReference: string
  orderNumber: number
  breakdown: NativePricedOrder & { subtotal: number }
}

// Persist a placed native order: disco_orders (RESERVED) + disco_sale_transactions
// (INITIATED) with the full cent-exact breakdown. Zero FM. Payment (1f) creates the
// PaymentIntent and the webhook flips the order to DUE.
export async function placeNativeOrder(input: NativePlaceInput): Promise<NativePlaceResult> {
  // Money path: this used to eagerly await runDiscoOrderMigrations() (100
  // sequential round-trips) before any work, so a cold-lambda placement took
  // seconds and a migration error threw before the disco_orders row was ever
  // written — the buyer's order silently vanished. Probe with a cheap READ
  // instead: one round-trip normally, and it only migrates if the tables are
  // genuinely absent. Deliberately NOT wrapping the INSERT below — that must
  // never be retried. By the time it runs the suite is cached for this lambda.
  await withDiscoTables(() => sql`SELECT 1 FROM disco_orders LIMIT 1`)
  const b = await priceNativeCheckout(input)
  // Which menu this cart actually came from — stored on the order so dispatch
  // (dispatchExpediteForOrder) and any future read can check the real per-menu
  // delivery method instead of guessing. undefined (stored as NULL) when items
  // carry no tag, which dispatchExpediteForOrder must treat as "fall back to
  // delivery_type alone", not "assume OWN_DELIVERY" or "assume THIRD_PARTY".
  const menuReference = resolveCartMenuReference(input.items)
  // Authoritative guard — this is the pricer whose breakdown actually gets
  // persisted/charged below, and it's reached by every placement path (the
  // primary checkout flow, the invoice flow, recurring occurrences), not just
  // native-place-checkout.ts's own earlier check. No real tax rate → refuse
  // rather than insert an order priced at a fabricated 0% tax.
  if (!b.taxReliable) {
    throw new Error("Can't price this order — no real tax rate is on file for this restaurant yet.")
  }
  const { orderType, deliveryType } = fulfillmentToTypes(input.fulfillment)
  const orderNumber = await nextNativeOrderNumber()
  const initialStatus = input.orderStatus ?? 'RESERVED'
  // Snapshot the restaurant's delivery time-window granularity for DELIVERY orders
  // so emails/PDF/confirmation render the range (via formatTimeWindow), not just the
  // exact start time. Pickup orders always show the exact time → null.
  const deliveryTimeWindow = input.fulfillment === 'PICKUP' ? null : await loadDeliveryTimeWindow(input.restaurantReference)

  const fee = input.deliveryFee ?? 0
  const ownDeliveryFee = input.fulfillment === 'OWN_DELIVERY' ? fee : 0
  const thirdPartyDeliveryFee = input.fulfillment === 'THIRD_PARTY_DELIVERY' ? fee : 0
  const thirdPartyDeliverySubsiding = input.fulfillment === 'THIRD_PARTY_DELIVERY' ? round2(input.thirdPartyDeliverySubsiding ?? 0) : 0
  const tipsTotal = round2(b.tipsInPrice + b.thirdPartyDeliveryTips)
  const da = input.deliveryAddress ?? {}
  const daZip = da.zip ?? da.zipcode ?? null
  const daLat = typeof da.latitude === 'number' ? da.latitude : null
  const daLng = typeof da.longitude === 'number' ? da.longitude : null

  // Snapshot the restaurant name/address/phone at order time so the order stays
  // fully viewable even if the restaurant is later renamed or deleted.
  let rName: string | null = null, rAddr: string | null = null, rPhone: string | null = null
  try {
    const rc = (await sql`SELECT name, address, phone FROM disco_restaurant_cache WHERE restaurant_reference = ${input.restaurantReference} LIMIT 1`) as { name: string | null; address: string | null; phone: string | null }[]
    rName = rc[0]?.name ?? null; rAddr = rc[0]?.address ?? null; rPhone = rc[0]?.phone ?? null
  } catch { /* best-effort snapshot — placement never blocks on it */ }

  const orderRows = (await sql`
    INSERT INTO disco_orders (
      order_number, order_status, order_type, delivery_type, source_of_order,
      restaurant_reference, restaurant_name, restaurant_address, restaurant_phone,
      customer_email, customer_first_name, customer_last_name, customer_phone,
      order_date, order_time, delivery_time_window, tips, tips_type,
      delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
      delivery_lat, delivery_lng, subtotal, total, fee, note, delivery_instructions, company_name, persons, menu_reference, created_at, updated_at
    ) VALUES (
      ${orderNumber}::bigint, ${initialStatus}, ${orderType}, ${deliveryType}, ${input.sourceOfOrder ?? 'DISCO'},
      ${input.restaurantReference}::uuid, ${rName}, ${rAddr}, ${rPhone},
      ${input.customerEmail}, ${input.customerFirstName ?? null}, ${input.customerLastName ?? null}, ${input.customerPhone ?? null},
      ${input.orderDate}::date, ${input.orderTime}::time, ${deliveryTimeWindow}, ${tipsTotal}, ${input.tip?.custom ? 'CUSTOM' : 'PERCENTAGE'},
      ${da.addressLine1 ?? null}, ${da.addressLine2 ?? null}, ${da.city ?? null}, ${da.state ?? null}, ${daZip},
      ${daLat}, ${daLng}, ${b.subtotal}, ${b.total}, ${b.familyMealFee}, ${input.note ?? null}, ${input.deliveryInstructions ?? null}, ${input.companyName ?? null}, ${input.persons ?? null}, ${menuReference ?? null}::uuid, NOW(), NOW()
    )
    RETURNING id, reference, order_number
  `) as { id: number; reference: string; order_number: string | number }[]
  const order = orderRows[0]

  // Line items → disco_order_items. The confirmation page, account order-detail
  // panel, and invoice PDF all read these; native placement previously skipped
  // them, leaving native orders with empty item lists. Runs before payment, so a
  // failure here aborts placeAndPayNativeOrder before any charge is created.
  for (const it of input.items || []) {
    const qty = Math.max(1, Math.trunc(Number(it.quantity) || 1))
    // Store the BASE unit price; add-ons are their own rows (never baked in), so the
    // PDF/emails can show itemized "+" sub-lines. When there are no add-ons,
    // basePrice === price, so this is identical to before.
    const base = round2(Number(it.basePrice ?? it.price) || 0)
    const itemRows = (await sql`
      INSERT INTO disco_order_items (order_id, meal_package_reference, name, quantity, price_per_unit, total_price)
      VALUES (${order.id}, ${it.reference ?? null}, ${it.name || 'Item'}, ${qty}, ${base}, ${round2(base * qty)})
      RETURNING id
    `) as { id: number }[]
    const orderItemId = itemRows[0]?.id
    if (orderItemId && Array.isArray(it.addOns) && it.addOns.length) {
      for (const a of it.addOns) {
        await sql`
          INSERT INTO disco_order_item_addons (order_item_id, name, price, quantity)
          VALUES (${orderItemId}, ${a.name || 'Add-on'}, ${round2(Number(a.price) || 0)}, ${Math.max(1, Math.trunc(Number(a.quantity) || 1))})
        `
      }
    }
  }

  // Full breakdown → disco_sale_transactions (the money-of-record row the portal
  // dashboards read). money_flow DIRECT: restaurant is merchant-of-record.
  await sql`
    INSERT INTO disco_sale_transactions (
      order_id, transaction_status, transaction_type, subtotal, total, fee, service_charge, stripe_fee,
      state_tax, local_tax, other_tax, tips_in_price, third_party_delivery_tips,
      own_delivery_fee, third_party_delivery_fee, third_party_delivery_subsiding, discount,
      lead_gen_one_disco_fee, lead_gen_two_disco_fee, money_flow, source, created_at, updated_at
    ) VALUES (
      ${order.id}, 'INITIATED', 'ORIGINAL', ${b.subtotal}, ${b.total}, ${b.familyMealFee}, ${b.serviceCharge}, ${b.stripeFee},
      ${b.stateTax}, ${b.localTax}, ${b.otherTax}, ${b.tipsInPrice}, ${b.thirdPartyDeliveryTips},
      ${ownDeliveryFee}, ${thirdPartyDeliveryFee}, ${thirdPartyDeliverySubsiding}, ${b.discount},
      ${b.leadGenTier === 1 ? b.leadGen : 0}, ${b.leadGenTier === 2 ? b.leadGen : 0}, 'DIRECT', 'NATIVE_CHECKOUT', NOW(), NOW()
    )
  `

  return { orderId: order.id, orderReference: order.reference, orderNumber: Number(order.order_number), breakdown: b }
}

export interface NativePlaceAndPayResult extends NativePlaceResult {
  paymentIntentId: string
  clientSecret: string | null
  withheld: boolean
}

// Place a native order AND create its PaymentIntent (destination charge). The PI is
// created UNCONFIRMED (client_secret returned) for the browser to confirm with
// Stripe.js; the existing Stripe webhook flips the order RESERVED→DUE on
// payment_intent.succeeded (it looks the order up via disco_stripe_payments).
export async function placeAndPayNativeOrder(
  input: NativePlaceInput,
  stripe: Stripe,
  opts?: { customerId?: string; onBehalfOf?: boolean },
): Promise<NativePlaceAndPayResult> {
  const placed = await placeNativeOrder(input)
  const pay = await getRestaurantPayoutConfig(input.restaurantReference)
  // Attach the diner to the charge: prefer an explicit test-supplied customerId,
  // otherwise resolve/create a real Stripe Customer from the diner's email so the
  // charge is never customer-less in the Stripe dashboard.
  const dinerName = [input.customerFirstName, input.customerLastName].filter(Boolean).join(' ').trim() || null
  const customerId = opts?.customerId ?? (await getOrCreateStripeCustomer(stripe, input.customerEmail, dinerName)) ?? undefined
  const pi = await createNativeOrderPaymentIntent(stripe, {
    totalDollars: placed.breakdown.total,
    transferDollars: placed.breakdown.transfer,
    connectedAccountId: pay.connectedAccountId,
    withholdPayouts: pay.withholdPayouts,
    customerId,
    receiptEmail: input.customerEmail || undefined,
    onBehalfOf: opts?.onBehalfOf ?? true, // production: restaurant is merchant-of-record
    metadata: { orderReference: placed.orderReference, orderNumber: String(placed.orderNumber), kind: 'native_order' },
    description: `Disco Cater order #${placed.orderNumber}`,
  })
  // Link the PaymentIntent → order so the webhook can find and complete it.
  await sql`
    INSERT INTO disco_stripe_payments (order_reference, restaurant_reference, stripe_payment_intent_id, status, subtotal, total, created_at)
    VALUES (${placed.orderReference}::uuid, ${input.restaurantReference}::uuid, ${pi.id}, 'INITIATED', ${placed.breakdown.subtotal}, ${placed.breakdown.total}, NOW())
    ON CONFLICT (stripe_payment_intent_id) DO NOTHING
  `
  await sql`UPDATE disco_sale_transactions SET stripe_payment_intent_id = ${pi.id} WHERE order_id = ${placed.orderId}`
  return { ...placed, paymentIntentId: pi.id, clientSecret: pi.client_secret, withheld: pay.withholdPayouts || !pay.connectedAccountId }
}

export interface NativeInvoiceResult extends NativePlaceResult {
  stripeInvoiceId: string | null
  hostedInvoiceUrl: string | null
  withheld: boolean
}

// M7 — place a native order as an INVOICE (unpaid, no PaymentIntent) and bill the
// customer via a Stripe invoice on the PLATFORM account. The order is created
// UNPAID; on invoice.payment_succeeded the webhook flips it to DUE, dispatches
// confirmations, and TRANSFERS the restaurant's payout to their connected account
// (mirrors the card flow's destination-charge money model: platform collects the
// total, keeps total−transfer, pays the Stripe fee). The invoice metadata carries
// the payout the webhook must move, so it never re-prices. Gated by the caller
// behind NATIVE_INVOICE_ENABLED until live-verified in Stripe test mode.
export async function placeNativeInvoiceOrder(input: NativePlaceInput, stripe: Stripe): Promise<NativeInvoiceResult> {
  const placed = await placeNativeOrder({ ...input, orderStatus: 'UNPAID' })
  const pay = await getRestaurantPayoutConfig(input.restaurantReference)
  const total = placed.breakdown.total
  const transfer = placed.breakdown.transfer

  let stripeInvoiceId: string | null = null
  let hostedInvoiceUrl: string | null = null
  const dinerName = [input.customerFirstName, input.customerLastName].filter(Boolean).join(' ').trim() || null
  const customerId = await getOrCreateStripeCustomer(stripe, input.customerEmail, dinerName)
  if (customerId) {
    // Create the invoice first, then attach the line item to it directly (the same
    // ordering the order-edit invoice flow uses — a pending item on an empty draft
    // finalized $0.00 under the pinned API version). auto_advance off so the draft
    // can't finalize before the line item lands.
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: 'send_invoice',
      days_until_due: 7,
      auto_advance: false,
      description: `Disco Cater order #${placed.orderNumber}`,
      metadata: {
        orderReference: placed.orderReference,
        orderNumber: String(placed.orderNumber),
        restaurantReference: input.restaurantReference,
        kind: 'native_order_invoice',
        // Everything the webhook needs to move funds on payment WITHOUT re-pricing.
        transferDollars: String(transfer),
        connectedAccountId: pay.connectedAccountId ?? '',
        withholdPayouts: pay.withholdPayouts ? '1' : '0',
      },
    })
    await stripe.invoiceItems.create({
      customer: customerId, invoice: invoice.id, amount: cents(total), currency: 'usd',
      description: `Disco Cater order #${placed.orderNumber}`,
    })
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id)
    await stripe.invoices.sendInvoice(invoice.id).catch(() => {})
    stripeInvoiceId = invoice.id
    hostedInvoiceUrl = (finalized.hosted_invoice_url as string) || null
    await sql`UPDATE disco_orders SET stripe_invoice_id = ${invoice.id}, stripe_invoice_status = 'open', updated_at = NOW() WHERE id = ${placed.orderId}`
  }

  return { ...placed, stripeInvoiceId, hostedInvoiceUrl, withheld: pay.withholdPayouts || !pay.connectedAccountId }
}

export interface NativeRecurringResult {
  outcome: 'placed' | 'charge_failed'
  orderId?: number
  orderReference?: string
  orderNumber?: number
  paymentIntentId?: string
  declineCode?: string | null
}

// B1 — charge + place a native recurring occurrence. Unlike placeAndPayNativeOrder
// (which creates an UNCONFIRMED PI for the browser to confirm), this confirms the
// destination charge server-side OFF-SESSION against the saved card, then sets the
// order DUE directly — the Stripe webhook won't retroactively flip it, because the
// order row is created here around an already-confirmed charge. Funds route to the
// restaurant's connected account exactly like a one-time native order. On decline /
// non-success the just-created RESERVED order is rolled back so no orphan remains.
export async function chargeAndPlaceNativeRecurringOrder(
  input: NativePlaceInput,
  stripe: Stripe,
  opts: { customerId: string; paymentMethodId: string; idempotencyKey: string },
): Promise<NativeRecurringResult> {
  const placed = await placeNativeOrder(input)

  const rollback = async () => {
    try {
      await sql`DELETE FROM disco_order_items WHERE order_id = ${placed.orderId}`
      await sql`DELETE FROM disco_sale_transactions WHERE order_id = ${placed.orderId}`
      await sql`DELETE FROM disco_orders WHERE id = ${placed.orderId}`
    } catch (e) { console.error('[native-recurring] rollback failed:', e instanceof Error ? e.message : e) }
  }

  const pay = await getRestaurantPayoutConfig(input.restaurantReference)
  let pi: Stripe.PaymentIntent
  try {
    pi = await createNativeOrderPaymentIntent(stripe, {
      totalDollars: placed.breakdown.total,
      transferDollars: placed.breakdown.transfer,
      connectedAccountId: pay.connectedAccountId,
      withholdPayouts: pay.withholdPayouts,
      customerId: opts.customerId,
      paymentMethodId: opts.paymentMethodId,
      receiptEmail: input.customerEmail || undefined,
      onBehalfOf: true,
      confirm: true,
      offSession: true,
      metadata: { orderReference: placed.orderReference, orderNumber: String(placed.orderNumber), kind: 'native_recurring_order' },
      description: `Recurring Disco Cater order #${placed.orderNumber}`,
    }, opts.idempotencyKey)
  } catch (err) {
    await rollback()
    const code = (err as { code?: string })?.code ?? null
    return { outcome: 'charge_failed', declineCode: code }
  }

  if (pi.status !== 'succeeded') {
    await rollback()
    return { outcome: 'charge_failed', paymentIntentId: pi.id, declineCode: pi.status }
  }

  // Link PI → order and mark paid/DUE (mirrors placeAndPayNativeOrder + the webhook's
  // payment_intent.succeeded handler, done inline since the webhook can't do it here).
  // Best-effort: the charge already SUCCEEDED, so a post-charge DB hiccup must never
  // throw back to the caller (that would misroute a paid order). The disco_stripe_
  // payments link also lets the webhook flip DUE as a backup if any of these missed.
  try {
    await sql`
      INSERT INTO disco_stripe_payments (order_reference, restaurant_reference, stripe_payment_intent_id, status, subtotal, total, created_at)
      VALUES (${placed.orderReference}::uuid, ${input.restaurantReference}::uuid, ${pi.id}, 'SUCCEEDED', ${placed.breakdown.subtotal}, ${placed.breakdown.total}, NOW())
      ON CONFLICT (stripe_payment_intent_id) DO NOTHING
    `
    await sql`UPDATE disco_sale_transactions SET stripe_payment_intent_id = ${pi.id}, transaction_status = 'PAID', updated_at = NOW() WHERE order_id = ${placed.orderId}`
    await sql`UPDATE disco_orders SET order_status = 'DUE', updated_at = NOW() WHERE id = ${placed.orderId}`
  } catch (e) {
    console.error('[native-recurring] post-charge link/DUE failed (charge succeeded, order exists):', e instanceof Error ? e.message : e)
  }

  return { outcome: 'placed', orderId: placed.orderId, orderReference: placed.orderReference, orderNumber: placed.orderNumber, paymentIntentId: pi.id }
}
