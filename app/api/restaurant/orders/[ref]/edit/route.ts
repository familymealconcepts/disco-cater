// ORDER EDIT — DELIBERATELY EXEMPT FROM THE CUSTOMER-FACING ORDER GATES.
//
// This route does NOT run, and must not be "fixed" to run:
//   • checkCartMinimums          (item min_quantity + required group min_selected)
//   • the order-value minimum    (pickup/delivery_order_minimum)
//   • checkItemInventoryAvailability (max_inventory_per_day)
//   • anything else in buildNativePlaceInput
//
// Those rules exist to stop a CUSTOMER self-serving an order the kitchen can't
// fill. This route is the restaurant adjusting an order on a customer's behalf —
// usually because the customer phoned to change something, and usually with the
// kitchen already looking at it. A restaurant must be able to drop a tray, split a
// Side below its own stated minimum, or take an order past its own daily cap,
// because the restaurant is the authority those minimums were protecting in the
// first place. Blocking it would mean telling a restaurant it isn't allowed to do
// what it just agreed to do on the phone.
//
// So the asymmetry is the design, not an oversight. Confirmed intentional
// 2026-08-27 when the minimum gates were added to the placement path.
import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { getRestaurantEmail } from '../../../../../../lib/restaurant-auth'
import { getAdminEmail } from '../../../../../../lib/admin-auth'
import Stripe from 'stripe'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { resolveOrderAccess } from '../../../../../../lib/order/order-scope'
import { getRestaurantRole } from '../../../../../../lib/restaurant-auth'
import {
  getDiscoOrder, loadOrderBaseline,
  hoursUntil, isEditableStatus, MAX_EDITS, type FmOrderItem,
  isOrderInPast, loadRestaurantTimeZone,
} from '../../../../../../lib/order-edit'
import {
  sendOrderUpdated, sendOrderUpdatedRestaurant, sendOrderEditRefundIssued,
  sendOrderEditPaymentRequired, sendOrderEditPendingRestaurant, type EditItem,
} from '../../../../../../lib/email/notifications'
import { resolveRestaurantNotificationEmails, sendOrderUpdateEmails, type OrderUpdateEmail } from '../../../../../../lib/order-notifications'
import { repriceEditLinesFromMenu, storedLinesIfUnchanged, remapLinesToRestaurant } from '../../../../../../lib/order/native-cart-reprice'
import { buildOrderPdfByReference } from '../../../../../../lib/order/order-pdf'
import { orderPdfFilename } from '../../../../../../lib/download-filename'
import { fulfillmentToTypes, isDiscoNativeRestaurant, loadDeliveryTimeWindow, loadThirdPartyShiftMinutes, loadMenuFulfillmentAvailability, loadMenuOrderMinimums, loadRestaurantServiceChargePct } from '../../../../../../lib/order/native-checkout'
import { assertFiniteMoney, discountedBase } from '../../../../../../lib/promo-pricing'
import { createNativeOrderPaymentIntent, getRestaurantPayoutConfig, type RestaurantPayoutConfig } from '../../../../../../lib/order/native-payment'
import { refundNativeOrder, refundPaymentFromRestaurant, RefundRefusedError } from '../../../../../../lib/order/native-refund'
import { voidUnpaidOrderInvoice } from '../../../../../../lib/order/invoice-void'
import { alertEditVoidFailed, alertEditReissueFailed, alertEditRefundImpossible } from '../../../../../../lib/order/money-alerts'
import { decideEditPaymentAction } from '../../../../../../lib/order/edit-payment-action'
import { priceNativeOrderAtSubtotal, type Fulfillment, type FrozenEditContext } from '../../../../../../lib/pricing/native-order'
import type { Breakdown } from '../../../../../../lib/promo-pricing'
import { cancelCourierAndReport, syncCourierAndReport } from '../../../../../../lib/order/courier-sync'
import { alertOps } from '../../../../../../lib/ops-alert'
import { orderLink } from '../../../../../../lib/ops-alert-format'
import { fulfillmentLabel } from '../../../../../../lib/order/fulfillment-label'
import { validateNativeDelivery } from '../../../../../../lib/order/native-delivery'
import { loadCurrentBreakdown } from '../../../../../../lib/order/current-breakdown'
import { dispatchExpediteForOrder, nativeDispatchEnabled } from '../../../../../../lib/expedite'
import { formatTime12 } from '../../../../../../lib/utils/time'
import { timeAfterFulfillmentSwitch } from '../../../../../../lib/scheduling/cutoffs'
import { cartSubtotal } from '../../../../../../lib/pricing/cart'

// Shared 12-hour formatter (lib/utils/time.ts). Local alias keeps call sites unchanged.
const fmtTime = formatTime12

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FEE_RATE = 0.03 // 3% platform fee on subtotal

interface ActiveLineAddOn { name: string; price: number; count?: number; quantity?: number }
interface ActiveLine {
  reference: string; name: string; price: number; quantity: number; serves?: string | number | null
  addOns?: ActiveLineAddOn[]
  /** Per-item Special Instructions → disco_order_items.notes. */
  note?: string
}

// Per-item Special Instructions on an edited line. Every save deletes and
// re-inserts disco_order_items, so a line that arrives without its note loses
// it — including one the customer left at checkout (5b6de13 started storing
// them; this route's replace never carried them).
function lineNote(l: { note?: unknown }): string | null {
  const t = typeof l.note === 'string' ? l.note.trim() : ''
  return t || null
}

// Live by default. `testMode` (SUPER_ADMIN E2E only — see POST) swaps in the
// Stripe TEST secret so the harness can settle test charges through this same
// route without touching the live payment path. Falls back to no client if the
// requested key is unset.
function stripeClient(testMode = false): Stripe | null {
  const key = testMode ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
function servesToInt(s: unknown): number | null {
  if (s == null) return null
  const m = String(s).match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}
function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '')
  if (!m) return iso || ''
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  // Admin portal (fm_admin_token) gets the same full edit as a restaurant
  // SUPER_ADMIN, and is detected independently of any restaurant cookie (see
  // resolveOrderAccess); it resolves the order's restaurant from the order row
  // itself, not the session. A restaurant session may only edit (and
  // charge/refund) an order inside its own scope.
  const access = await resolveOrderAccess(ref)
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status as number })
  const ctx = access.ctx
  const isAdminEdit = access.isAdmin
  try { await runDiscoOrderMigrations() } catch { /* best-effort */ }

  let body: {
    activeLines?: ActiveLine[]; orderDate?: string; orderTime?: string; editorEmail?: string; tip?: { type?: string; value?: unknown }
    fulfillment?: { type?: string; address?: { addressLine1?: string; addressLine2?: string; city?: string; state?: string; zip?: string }; instructions?: string }
  }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }

  // ── A NEW TIP (Peter, 2026-11-02) ─────────────────────────────────────────
  // Optional. A dollar amount, or a percentage of the order's discounted
  // subtotal — the base checkout prices a percentage tip on (computeBreakdown).
  // Absent means the tip is kept exactly as it is, as every edit did before.
  const tipReq = body.tip && typeof body.tip === 'object'
    ? { type: String(body.tip.type || '').toUpperCase(), value: Number(body.tip.value) }
    : null
  if (tipReq) {
    if ((tipReq.type !== 'AMOUNT' && tipReq.type !== 'PERCENTAGE') || !Number.isFinite(tipReq.value) || tipReq.value < 0
      || (tipReq.type === 'PERCENTAGE' && tipReq.value > 100) || (tipReq.type === 'AMOUNT' && tipReq.value > 10000)) {
      return NextResponse.json({ error: 'Enter a tip of $0 or more, or a percentage from 0 to 100.' }, { status: 400 })
    }
  }

  // ── PICKUP ↔ DELIVERY (Peter, 2026-11-06) ────────────────────────────────
  // Optional. Switches the order's fulfillment the way checkout would set it:
  // delivery needs an address checkout's own range check accepts, and takes the
  // menu's delivery fee (and minimum); going back to pickup drops the delivery fee
  // and, for a courier delivery, the courier tip. Absent keeps the fulfillment.
  const fulReq = body.fulfillment && typeof body.fulfillment === 'object'
    ? {
        type: String(body.fulfillment.type || '').toUpperCase(),
        address: {
          addressLine1: String(body.fulfillment.address?.addressLine1 || '').trim(),
          addressLine2: String(body.fulfillment.address?.addressLine2 || '').trim(),
          city: String(body.fulfillment.address?.city || '').trim(),
          state: String(body.fulfillment.address?.state || '').trim(),
          zip: String(body.fulfillment.address?.zip || '').trim(),
        },
        instructions: String(body.fulfillment.instructions || '').trim().slice(0, 1000),
      }
    : null
  if (fulReq && fulReq.type !== 'PICKUP' && fulReq.type !== 'DELIVERY') {
    return NextResponse.json({ error: 'Choose pickup or delivery.' }, { status: 400 })
  }
  if (fulReq?.type === 'DELIVERY' && (!fulReq.address.addressLine1 || !fulReq.address.city || !fulReq.address.state || !fulReq.address.zip)) {
    return NextResponse.json({ error: 'Enter the delivery address: street, city, state and ZIP.' }, { status: 400 })
  }

  const activeLines: ActiveLine[] = Array.isArray(body.activeLines) ? body.activeLines : []
  const orderDate = String(body.orderDate || '').slice(0, 10) // YYYY-MM-DD
  const orderTime = String(body.orderTime || '')             // HH:MM:SS
  // Who made the edit comes from the SERVER's identity for the caller, not the
  // body (22 Oct 2026): the audit row and the customer email named whatever
  // editorEmail the client sent. Admin portal → the verified Super Admin;
  // restaurant session → its account / FM-verified email. The body is used
  // only when neither yields one.
  const serverEditor = isAdminEdit
    ? (await getAdminEmail().catch(() => null))
    : (ctx?.email || (ctx ? await getRestaurantEmail().catch(() => null) : null))
  const editorEmail = String(serverEditor || body.editorEmail || '')
  if (!activeLines.length) return NextResponse.json({ error: 'At least one item is required.' }, { status: 400 })

  // SUPER_ADMIN bypasses the 24-hour pickup-proximity restriction (only). All
  // other eligibility — edit-count cap, order status — applies to every role.
  // An admin-portal session is treated as SUPER_ADMIN for this purpose.
  // Use the already-resolved ctx for a Disco-native session (getRestaurantRole()
  // only decodes the FM JWT, so it's always null there — the same gap fixed in
  // manage/bulk-pricing/page.tsx) and fall back to the FM decode for FM sessions.
  const isSuperAdmin = isAdminEdit
    || (ctx?.authType === 'disco' ? ctx.role === 'SUPER_ADMIN' : (await getRestaurantRole()) === 'SUPER_ADMIN')

  // ── 1. VALIDATION + edit_count gate ─────────────────────────────────────────
  const discoOrder = await getDiscoOrder(ref)
  const editCount = discoOrder?.edit_count ?? 0
  if (editCount >= MAX_EDITS) {
    return NextResponse.json({ error: 'Maximum edits reached for this order.' }, { status: 400 })
  }
  if (!isSuperAdmin && discoOrder && hoursUntil(String(discoOrder.order_date).slice(0, 10), discoOrder.order_time) < 24) {
    return NextResponse.json({ error: 'Order cannot be edited within 24 hours of pickup.' }, { status: 400 })
  }
  // ONE UNPAID EDIT AT A TIME. Only the edit screen's status check stopped a
  // second edit while the first's invoice was open; a direct request went through
  // and stacked a second invoice on the first (pending_edit_data holds one).
  if (discoOrder?.edit_status === 'pending_payment') {
    return NextResponse.json({ error: 'This order has an edit waiting for the customer to pay its invoice. It can be edited again once that invoice is paid.' }, { status: 409 })
  }
  if (discoOrder && !isEditableStatus(discoOrder.order_status)) {
    return NextResponse.json({ error: `This order is ${discoOrder.order_status.toLowerCase()} and can no longer be edited.` }, { status: 400 })
  }

  // Absolute past-date block — an order whose pickup datetime has already passed
  // (in the restaurant's tz) can NEVER be edited, by ANY role including SUPER_ADMIN.
  // Distinct from the <24h future-proximity rule above. Defense-in-depth: even if a
  // request bypasses the client gate, it is rejected here.
  if (discoOrder) {
    const tz = await loadRestaurantTimeZone(discoOrder.restaurant_reference)
    if (isOrderInPast(String(discoOrder.order_date), String(discoOrder.order_time), tz)) {
      return NextResponse.json({ error: "This order's date has already passed and can no longer be edited." }, { status: 400 })
    }
  }

  // Neon-first baseline for original money/items/pickup. Neon owns the current
  // state (post prior edits); FM is read-only and only fills structural rates +
  // customer/restaurant meta it still holds.
  const loadedBaseline = await loadOrderBaseline(ref, discoOrder)
  if (!loadedBaseline) return NextResponse.json({ error: 'Could not load the order.' }, { status: 502 })
  const base = loadedBaseline // non-null; narrowing survives into the nested closures below
  if (base.status && !isEditableStatus(base.status)) {
    return NextResponse.json({ error: `This order is ${base.status.toLowerCase()} and can no longer be edited.` }, { status: 400 })
  }

  const effDate = orderDate || base.orderDateIso
  // `let`: a pickup ↔ third-party switch on a shifted menu moves the time to
  // keep the food-ready time (see the switch block below).
  let effTime = orderTime || base.orderTime

  // What changed (drives edit_type + the reschedule 24h rule).
  const origMap = new Map<string, number>()
  for (const i of base.items) origMap.set(i.reference, (origMap.get(i.reference) || 0) + i.count)
  const newMap = new Map<string, number>()
  for (const l of activeLines) newMap.set(l.reference, (newMap.get(l.reference) || 0) + l.quantity)
  let itemsChanged = origMap.size !== newMap.size
  if (!itemsChanged) for (const [k, v] of newMap) if (origMap.get(k) !== v) { itemsChanged = true; break }
  const dateChanged = (!!orderDate && orderDate !== base.orderDateIso) || (!!orderTime && orderTime.slice(0, 5) !== (base.orderTime || '').slice(0, 5))
  // TIP is set below, once the new tip is priced: a tip-only edit.
  let editType: 'RESCHEDULE' | 'ITEMS' | 'BOTH' | 'TIP' | 'FULFILLMENT' = itemsChanged && dateChanged ? 'BOTH' : itemsChanged ? 'ITEMS' : 'RESCHEDULE'

  // ── A SAVE THAT CHANGES NOTHING IS NOT AN EDIT ────────────────────────────
  // editType fell back to RESCHEDULE when nothing differed, so pressing Save
  // again emailed the customer and every restaurant recipient and used one of
  // the order's 3 edits: #13539753's 2nd and 3rd saves were identical and left
  // it locked. Same items, quantities, options and item notes, same date and
  // time → nothing is written or sent.
  // A tip request that names the same dollar tip is not a change; a percentage
  // is compared after pricing, below.
  const tipMaybeChanged = !!tipReq && !(tipReq.type === 'AMOUNT' && Math.abs(round2(tipReq.value) - round2(Number(discoOrder?.tips) || 0)) < 0.005)
  const currentOrderType: 'PICKUP' | 'DELIVERY' = String(discoOrder?.order_type || base.orderType || '').toUpperCase() === 'DELIVERY' ? 'DELIVERY' : 'PICKUP'
  const fulfillmentChanged = !!fulReq && fulReq.type !== currentOrderType
  const NOTHING_CHANGED = { success: true, noChange: true, message: 'Nothing changed, so the order was not updated.' }
  let linesAndNotesSame = false
  if (!dateChanged && discoOrder) {
    const same = await storedLinesIfUnchanged(discoOrder.id, activeLines).catch(() => null)
    if (same) {
      const storedNotes = ((await sql`SELECT meal_package_reference::text AS ref, notes FROM disco_order_items WHERE order_id = ${discoOrder.id}`
        .catch(() => [])) as { ref: string | null; notes: string | null }[])
        .map(r => `${r.ref || ''}|${(r.notes || '').trim()}`).sort().join('\n')
      const postedNotes = activeLines.map(l => `${l.reference || ''}|${lineNote(l) || ''}`).sort().join('\n')
      linesAndNotesSame = storedNotes === postedNotes
      if (linesAndNotesSame && !tipMaybeChanged && !fulfillmentChanged) return NextResponse.json(NOTHING_CHANGED)
    }
  }

  // RESCHEDULE rule: the NEW pickup must be ≥24h away (SUPER_ADMIN exempt).
  if (!isSuperAdmin && dateChanged && hoursUntil(effDate, effTime) < 24) {
    return NextResponse.json({ error: 'New pickup must be at least 24 hours from now.' }, { status: 400 })
  }

  const restaurantRef = base.restaurantRef || discoOrder?.restaurant_reference || ctx?.restaurantReference || ''
  const isNative = restaurantRef ? await isDiscoNativeRestaurant(restaurantRef) : false

  // A tip is changed only on an order Disco took the payment for: its tip is in
  // Disco's own breakdown and payout. A FamilyMeal-processed order's tip was
  // charged and paid out by FamilyMeal.
  if (tipMaybeChanged && (!isNative || !discoOrder || discoOrder.fm_order_reference)) {
    return NextResponse.json({ error: "This order's payment was taken by FamilyMeal, so its tip can't be changed here. Contact Disco Cater to change it." }, { status: 409 })
  }
  if (fulfillmentChanged && (!isNative || !discoOrder || discoOrder.fm_order_reference)) {
    return NextResponse.json({ error: "This order's payment was taken by FamilyMeal, so it can't be switched between pickup and delivery here. Contact Disco Cater to change it." }, { status: 409 })
  }

  // ── PRICES COME FROM THE MENU, NOT FROM THE REQUEST ───────────────────────
  // Same weakness native checkout had: every figure below — the new subtotal,
  // the Stripe delta charged or refunded, the rows written to disco_order_items
  // — was computed from the `price` fields in the posted body, and nothing
  // re-read disco_menu_items. Prices are set at the menu level, so the menu is
  // the authority here too. Add-ons are validated as belonging to the item they
  // are attached to; an item no longer on the menu is refused.
  //
  // Native orders only: an FM-backed order's menu lives in FamilyMeal, which is
  // read-only and has no disco_menu_items rows to price against.
  //
  // Lines identical to what the order already holds (a date/time-only save)
  // keep their STORED prices and skip the menu check — see
  // storedLinesIfUnchanged. A transferred order's lines are first pointed at
  // the new location's same items — see remapLinesToRestaurant.
  if (isNative) {
    const unchanged = discoOrder ? await storedLinesIfUnchanged(discoOrder.id, activeLines) : null
    let lines = unchanged ?? activeLines
    if (discoOrder) {
      const transferred = (await sql`
        SELECT 1 FROM disco_order_events
         WHERE order_reference = ${discoOrder.reference}::uuid AND event_type = 'TRANSFERRED' LIMIT 1
      `) as unknown[]
      if (transferred.length) {
        const r = await remapLinesToRestaurant(restaurantRef, lines)
        if (r.remapped) console.log(`[orders/edit] transferred order: ${r.remapped} line(s) matched to ${restaurantRef}'s menu: order=${ref}`)
        lines = r.lines
      }
    }
    if (!unchanged) {
      const repriced = await repriceEditLinesFromMenu(restaurantRef, lines)
      if (!repriced.ok) return NextResponse.json({ error: repriced.error }, { status: repriced.status })
      if (repriced.corrected > 0) {
        console.warn(`[orders/edit] edit prices did not match the menu; used the menu's: order=${ref} corrections=${repriced.corrected}`)
      }
      lines = repriced.lines
    }
    activeLines.splice(0, activeLines.length, ...lines)
  }

  // ── 2. RECALCULATE MONEY ────────────────────────────────────────────────────
  // Native orders: run the SAME cent-exact tiered engine placement uses (tax
  // rates, lead-gen %, service charge, real Stripe fee) instead of a flat 3%,
  // and derive the restaurant-payout delta (`nativeTransferDelta`) so the Stripe
  // charge/refund below can route it through Connect. Non-native (FM-backed)
  // orders keep the original flat-rate/blended-tax-rate math unchanged — this
  // route's Stripe logic was never wired to FM's own PaymentIntents anyway.
  // THE canonical line rule, from lib/pricing/cart.ts:
  //
  //   lineTotal = (basePrice + Σ(modifier.price × modifier.count)) × quantity
  //
  // Quantity multiplies the base price AND every modifier on it, because the
  // modifiers are part of what ONE unit costs. Two trays of pasta at $50 with
  // two $10 chicken modifiers each is (50 + 20) × 2 = $140 — the diner receives
  // the chicken twice.
  //
  // This route used to compute Σ(price × quantity) + addOnTotal, adding the
  // modifiers ONCE PER LINE. It was the only implementation that disagreed with
  // checkout, the customer cart and this feature's own edit screen — and its
  // figure is what gets written and what drives the Stripe delta below, so the
  // restaurant saw the right number, saved, and the server committed a lower one
  // and refunded the difference. Verified on #900000151: stored $216.00, this
  // route computed $208.00, delta −$9.10 refunded and −$8.59 reversed out of the
  // restaurant's payout, on an edit that changed nothing.
  //
  // Calling the shared helper rather than fixing the formula in place is the
  // point: one implementation of this rule, not two that agree today.
  //
  // The map is a WIRE-SHAPE adapter, not arithmetic. EditOrderClient sends each
  // add-on as `quantity` (it holds them as `count` internally and renames on the
  // way out), while CartAddOn reads `count` — passing the payload straight in
  // would silently score every modifier as 0.
  const newSubtotal = round2(cartSubtotal(activeLines.map(l => ({
    price: Number(l.price) || 0,
    count: Number(l.quantity) || 0,
    addOns: (l.addOns ?? []).map(ao => ({
      price: Number(ao.price) || 0,
      count: Math.max(1, Math.trunc(Number(ao.quantity ?? ao.count) || 1)),
    })),
  }))))
  let newTaxes: number, newFee: number, newTotal: number, delta: number
  let nativeTransferDelta = 0
  let nativeBreakdown: Breakdown | null = null
  let nativePay: RestaurantPayoutConfig | null = null
  let nativeCtx: FrozenEditContext | null = null
  let nativeLeadGenTier: 1 | 2 | 0 = 0
  // The order's tip before and after this edit, in dollars (native orders).
  const oldTipDollars = round2(Number(discoOrder?.tips) || 0)
  let newTipDollars = oldTipDollars
  let tipChanged = false
  // Lowering a third-party delivery tip: that tip went to the courier through
  // Disco, never to the restaurant, so refunding it would spend Disco's money.
  let courierTipLowered = false
  // The fulfillment before and after this edit, and (a switch to delivery) the
  // address checkout's range check accepted. Set in the native block below.
  let oldFulfillment: Fulfillment = 'PICKUP'
  let fulfillmentAfter: Fulfillment = 'PICKUP'
  let newDelivery: {
    addressLine1: string; addressLine2: string; city: string; state: string; zip: string
    instructions: string; latitude: number | null; longitude: number | null; distanceMiles: number | null
  } | null = null
  let expediteToCancel: string | null = null

  if (isNative && discoOrder) {
    const [delRows, origRows] = await Promise.all([
      sql`SELECT delivery_type, menu_reference, expedite_delivery_id FROM disco_orders WHERE id = ${discoOrder.id} LIMIT 1`.catch(() => []),
      sql`
        SELECT subtotal, discount, own_delivery_fee, third_party_delivery_fee, third_party_delivery_subsiding,
               lead_gen_one_disco_fee, lead_gen_two_disco_fee
        FROM disco_sale_transactions WHERE order_id = ${discoOrder.id} AND transaction_type = 'ORIGINAL' LIMIT 1
      `.catch(() => []),
    ]) as [
      { delivery_type: string | null; menu_reference: string | null; expedite_delivery_id: string | null }[],
      {
        subtotal: string | number | null; discount: string | number | null
        own_delivery_fee: string | number | null; third_party_delivery_fee: string | number | null
        third_party_delivery_subsiding: string | number | null
        lead_gen_one_disco_fee: string | number | null; lead_gen_two_disco_fee: string | number | null
      }[],
    ]
    const deliveryType = delRows[0]?.delivery_type || null
    const orderMenuReference = delRows[0]?.menu_reference || undefined
    const orig = origRows[0]
    // The delivery fee the order carries NOW: an earlier edit that switched it
    // between pickup and delivery recorded the new fee on its MANUAL_EDIT row, and
    // the ORIGINAL row still holds the fee from checkout. Same row the PDF reads.
    const feeRow = (await loadCurrentBreakdown(discoOrder.id).catch(() => ({ row: null }))).row || orig
    // Through the shared label, which knows every courier value: FamilyMeal's
    // DLIVRD_DELIVERY used to fall through to PICKUP here, so any edit of such an
    // order re-priced it without its delivery fee (#13539753: $375.66 → $337.41,
    // emailed as "No change to your total").
    const fLabel = fulfillmentLabel(deliveryType, base.orderType)
    const fulfillment: Fulfillment = fLabel === 'Self-Delivery' ? 'OWN_DELIVERY' : fLabel === 'Third-Party Delivery' ? 'THIRD_PARTY_DELIVERY' : 'PICKUP'
    const origSubtotal = Number(orig?.subtotal) || 0
    const origDiscount = Number(orig?.discount) || 0
    const origBase = origSubtotal - origDiscount
    const discountPct = origSubtotal > 0 ? (origDiscount / origSubtotal) * 100 : 0
    const origLeadGenOne = Number(orig?.lead_gen_one_disco_fee) || 0
    const origLeadGenTwo = Number(orig?.lead_gen_two_disco_fee) || 0
    const leadGenAmt = origLeadGenOne + origLeadGenTwo
    const leadGenPct = origBase > 0 ? (leadGenAmt / origBase) * 100 : 0
    nativeLeadGenTier = origLeadGenOne > 0 ? 1 : origLeadGenTwo > 0 ? 2 : 0
    // The order's own stored menu_reference (frozen at placement) — the exact
    // menu this order came from, not a re-derivation from the edited lines.
    const scPct = await loadRestaurantServiceChargePct(restaurantRef, orderMenuReference)
    const editCtx: FrozenEditContext = {
      fulfillment,
      ownDeliveryFee: Number(feeRow?.own_delivery_fee) || 0,
      thirdPartyDeliveryFee: Number(feeRow?.third_party_delivery_fee) || 0,
      thirdPartyDeliverySubsiding: Number(feeRow?.third_party_delivery_subsiding) || 0,
      tipDollars: Number(discoOrder.tips) || 0,
      discountPct, leadGenPct, scPct,
      orderType: base.orderType === 'DELIVERY' ? 'DELIVERY' : 'PICKUP',
      // AN EXEMPT ORDER STAYS EXEMPT THROUGH AN EDIT. Derived from the order's
      // own stored exemption id rather than a re-entered flag: changing a line
      // would otherwise recompute tax from the live rate and silently reinstate
      // it on an order the customer is exempt on.
      taxExempt: !!(discoOrder as { tax_exempt_id?: string | null }).tax_exempt_id,
    }
    if (tipReq) {
      newTipDollars = tipReq.type === 'AMOUNT'
        ? round2(tipReq.value)
        : round2((newSubtotal - round2(newSubtotal * discountPct / 100)) * tipReq.value / 100)
      tipChanged = Math.abs(newTipDollars - oldTipDollars) >= 0.005
      courierTipLowered = tipChanged && newTipDollars < oldTipDollars && fulfillment === 'THIRD_PARTY_DELIVERY'
    }
    oldFulfillment = fulfillment
    fulfillmentAfter = fulfillment
    let newCtx: FrozenEditContext = { ...editCtx, tipDollars: newTipDollars }
    if (fulfillmentChanged && fulReq) {
      if (fulReq.type === 'DELIVERY') {
        // PICKUP → DELIVERY, held to what checkout holds a delivery order to: the
        // menu must offer delivery, the items must meet its delivery minimum (the
        // restaurant's own; Disco's courier floor is a customer-checkout rule, and
        // an edit is the restaurant's), and the address must pass checkout's own
        // range check, which also sets the fee from the menu's delivery settings.
        const avail = await loadMenuFulfillmentAvailability(restaurantRef, orderMenuReference)
        if (!avail.offersDelivery) {
          return NextResponse.json({ error: "This order's menu is pickup only, so it can't be switched to delivery." }, { status: 400 })
        }
        const mins = await loadMenuOrderMinimums(restaurantRef, orderMenuReference)
        if (mins.delivery > 0 && newSubtotal < mins.delivery) {
          return NextResponse.json({ error: `This menu's delivery minimum is $${mins.delivery.toFixed(2)}; the items come to $${newSubtotal.toFixed(2)}.` }, { status: 400 })
        }
        // The delivery TYPE and fee are the menu's, exactly as checkout sets them:
        // validateNativeDelivery reads the order's own menu's delivery_settings
        // (self-delivery → its distance rings, restaurant keeps the fee; courier →
        // 15% capped, less the restaurant's subsidy), fed the DISCOUNTED subtotal
        // like checkout. Nothing here picks the type itself.
        const q = await validateNativeDelivery(restaurantRef, fulReq.address, discountedBase(newSubtotal, discountPct), undefined, orderMenuReference)
        if (!q.valid) {
          return NextResponse.json({ error: q.message || 'That address is outside this restaurant’s delivery area.' }, { status: 400 })
        }
        fulfillmentAfter = q.fulfillment
        newDelivery = { ...fulReq.address, instructions: fulReq.instructions, latitude: q.latitude, longitude: q.longitude, distanceMiles: q.distanceMiles }
        newCtx = {
          ...newCtx,
          fulfillment: q.fulfillment,
          ownDeliveryFee: q.fulfillment === 'OWN_DELIVERY' ? q.deliveryFee : 0,
          thirdPartyDeliveryFee: q.fulfillment === 'THIRD_PARTY_DELIVERY' ? q.deliveryFee : 0,
          thirdPartyDeliverySubsiding: q.fulfillment === 'THIRD_PARTY_DELIVERY' ? q.thirdPartyDeliverySubsiding : 0,
          orderType: 'DELIVERY',
        }
      } else {
        // DELIVERY → PICKUP: the delivery fee comes off, and a courier delivery's
        // tip (the courier's, through Disco) comes off with it unless this same
        // edit names a new tip. The courier booking is cancelled on confirm.
        const avail = await loadMenuFulfillmentAvailability(restaurantRef, orderMenuReference)
        if (!avail.offersPickup) {
          return NextResponse.json({ error: "This order's menu is delivery only, so it can't be switched to pickup." }, { status: 400 })
        }
        fulfillmentAfter = 'PICKUP'
        if (fulfillment === 'THIRD_PARTY_DELIVERY' && !tipReq) {
          newTipDollars = 0
          tipChanged = oldTipDollars >= 0.005
        }
        // Lowering the tip here removes the courier's tip along with the courier;
        // it is not the refusal case below (a courier still being paid less).
        courierTipLowered = false
        newCtx = { ...newCtx, fulfillment: 'PICKUP', ownDeliveryFee: 0, thirdPartyDeliveryFee: 0, thirdPartyDeliverySubsiding: 0, orderType: 'PICKUP', tipDollars: newTipDollars }
        expediteToCancel = delRows[0]?.expedite_delivery_id || null
      }
    }
    // ── A SWITCH KEEPS THE FOOD-READY TIME ("Shift third-party delivery times") ─
    // Peter, 2026-11-10: on a menu whose third-party slots sit 30 minutes after
    // the ready time, a 10:00 pickup switched to third-party delivery becomes a
    // 10:30 delivery, and a 10:30 delivery switched to pickup becomes 10:00 — the
    // kitchen's deadline does not move. Applied only when this same edit did not
    // name a new time (a time picked in the dialog is used exactly as picked),
    // and never across midnight. Self-delivery is never shifted.
    if (fulfillmentChanged) {
      const menuShift = await loadThirdPartyShiftMinutes(restaurantRef, orderMenuReference)
      const fromShift = oldFulfillment === 'THIRD_PARTY_DELIVERY' ? menuShift : 0
      const toShift = fulfillmentAfter === 'THIRD_PARTY_DELIVERY' ? menuShift : 0
      const timeRequested = !!orderTime && orderTime.slice(0, 5) !== String(base.orderTime || '').slice(0, 5)
      if (!timeRequested && fromShift !== toShift) {
        const moved = timeAfterFulfillmentSwitch(effTime, fromShift, toShift)
        if (!moved) {
          return NextResponse.json({ error: 'Keeping the food-ready time would move this order past midnight. Reschedule it to a time on the same day, then switch.' }, { status: 400 })
        }
        effTime = moved
      }
    }
    nativeCtx = newCtx
    const oldB = await priceNativeOrderAtSubtotal(restaurantRef, base.subtotal, editCtx)
    const newB = await priceNativeOrderAtSubtotal(restaurantRef, newSubtotal, newCtx)
    // Same guard as the FM-backed branch below (#61848359's fix, mirrored): a
    // native restaurant with no real tax rate on file would otherwise recompute
    // this edit's charge/refund delta at a fabricated 0% tax.
    if (!newB.taxReliable) {
      return NextResponse.json({
        error: "Can't recalculate this order's tax right now — no real tax rate is on file for this restaurant. Contact support if this persists.",
      }, { status: 409 })
    }
    // A percentage that prices to the tip the order already has changes nothing.
    if (linesAndNotesSame && !tipChanged && !fulfillmentChanged) return NextResponse.json(NOTHING_CHANGED)
    if (tipChanged && !itemsChanged && !dateChanged) editType = 'TIP'
    if (fulfillmentChanged && !itemsChanged && !dateChanged) editType = 'FULFILLMENT'
    newTaxes = round2(newB.stateTax + newB.localTax + newB.otherTax)
    newFee = newB.familyMealFee
    newTotal = newB.total
    delta = round2(newB.total - oldB.total)
    nativeTransferDelta = round2(newB.transfer - oldB.transfer)
    // One edit is one payment: a charge carries a transfer to the restaurant and a
    // refund carries a reversal from it. A switch whose customer total goes up
    // while the restaurant's share goes down (a tipped pickup moving to a courier,
    // whose tip then goes to the courier) would need both at once.
    if (fulfillmentChanged && delta > 0 && nativeTransferDelta < -0.005) {
      return NextResponse.json({ error: "This switch raises the customer's total but lowers the restaurant's share, which one edit can't settle. Change the tip in a separate edit first, then switch the fulfillment." }, { status: 409 })
    }
    nativeBreakdown = newB
    nativePay = await getRestaurantPayoutConfig(restaurantRef)
  } else {
    // FM-backed orders recompute at the original blended tax rate — but only
    // when that rate is real. `base.taxReliable` is false when no live FM data
    // was available to derive it from (a bare order, FM unreachable); refusing
    // here is the fix for #61848359 — the old code fell back to inferring the
    // rate from whatever was left over after subtracting the other fields,
    // which silently absorbed a stale/zero stored tip as if it were tax.
    if (!base.taxReliable) {
      return NextResponse.json({
        error: "Can't recalculate this order's tax right now — its original breakdown isn't available from FamilyMeal. Try again shortly, or contact support if this persists.",
      }, { status: 409 })
    }
    // subtotal from items; fee = 3% of subtotal; taxes at the original tax rate;
    // tip + delivery preserved from the original order.
    const taxRate = base.taxRate
    newTaxes = round2(newSubtotal * taxRate)
    newFee = round2(newSubtotal * FEE_RATE)
    newTotal = round2(newSubtotal + newTaxes + newFee + base.tip + base.delivery)
    delta = round2(newTotal - base.total)
  }
  const customerEmail = base.customerEmail || discoOrder?.customer_email || ''
  const firstName = base.firstName || discoOrder?.customer_first_name || ''
  const businessName = base.restaurantName || discoOrder?.restaurant_name || 'the restaurant'
  const orderNumber = String(base.orderNumber || discoOrder?.order_number || '')
  const newEditNumber = editCount + 1
  // The order type the emails and the pending edit carry: the new one on a switch.
  const newOrderType = fulfillmentChanged && fulReq ? fulReq.type : base.orderType
  const newItems: EditItem[] = activeLines.map(l => ({
    count: l.quantity, name: l.name, price: l.price,
    ...(l.addOns?.length ? { addOns: l.addOns.map(a => ({ name: a.name, price: Number(a.price) || 0, count: Math.max(1, Math.trunc(Number(a.quantity ?? a.count) || 1)) })) } : {}),
    ...(lineNote(l) ? { comment: lineNote(l)! } : {}),
  }))
  const origItems: FmOrderItem[] = base.items
  const NO_DELTA = Math.abs(delta) < 0.01

  // Stripe identity (saved card) + original payment intent (refunds).
  let pmRow: { stripe_customer_id: string; stripe_payment_method_id: string } | null = null
  if (customerEmail) {
    const pms = (await sql`
      SELECT stripe_customer_id, stripe_payment_method_id FROM disco_customer_payment_methods
      WHERE customer_email = ${customerEmail} AND is_default = true LIMIT 1
    `.catch(() => [])) as { stripe_customer_id: string; stripe_payment_method_id: string }[]
    pmRow = pms[0] ?? null
  }
  let originalPaymentIntentId = ''
  if (discoOrder) {
    const pays = (await sql`
      SELECT stripe_payment_intent_id FROM disco_stripe_payments
      WHERE order_reference = ${discoOrder.reference}::uuid AND stripe_payment_intent_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `.catch(() => [])) as { stripe_payment_intent_id: string }[]
    originalPaymentIntentId = pays[0]?.stripe_payment_intent_id || ''
  }

  // Test-mode Stripe is allowed ONLY for an admin (SUPER_ADMIN) caller that
  // explicitly opts in via X-Stripe-Test — used by the E2E harness (step 7c) to
  // settle test charges through this route. Restaurant-level callers can NEVER
  // trigger it (isAdminEdit is false for them), so the live path is untouched.
  const useTestStripe = isAdminEdit
    && req.headers.get('x-stripe-test') === 'true'
    && !!process.env.STRIPE_TEST_SECRET_KEY
  const stripe = stripeClient(useTestStripe)
  let paymentAction: 'charge' | 'refund' | 'invoice' | 'void-reissue' | 'none' = 'none'
  let paymentStatus: 'succeeded' | 'refunded' | 'invoiced' | 'pending' | 'failed' | 'none' = 'none'
  // Emails a payment branch decides on before confirmEdit (the reissued invoice);
  // confirmEdit sends them with its own, so one edit is one recorded batch.
  const earlyEmails: OrderUpdateEmail[] = []
  let stripePaymentIntentId = ''
  let stripeRefundId = ''
  let stripeInvoiceId = ''

  // A FamilyMeal-processed order's date/time changed here reaches neither
  // FamilyMeal nor the courier it booked. Ops uses Disco for these because
  // FamilyMeal refuses edits inside 24 hours; the edit screen warned before
  // saving, and ops is told so the courier gets moved by hand.
  async function alertFamilyMealDateChange(): Promise<void> {
    if (!dateChanged || (discoOrder && !discoOrder.fm_order_reference)) return
    const from = `${base.orderDateIso} ${formatTime12(String(base.orderTime || ''))}`
    const to = `${effDate} ${formatTime12(String(effTime || ''))}`
    await alertOps({
      severity: 'urgent',
      headline: `FamilyMeal order rescheduled in Disco — #${orderNumber}`,
      lines: [
        `${businessName}: moved from ${from} to ${to}${editorEmail ? ` by ${editorEmail}` : ''}.`,
        "FamilyMeal and the Expedite courier were NOT updated.",
      ],
      action: 'update the courier at Expedite by hand (and the date in FamilyMeal if it allows).',
      link: orderLink(discoOrder?.reference || ref, orderNumber),
      context: { ref, orderNumber, from, to },
    }).catch(e => console.error('[orders/edit] FamilyMeal date-change alert (non-fatal):', e instanceof Error ? e.message : e))
  }

  // Replace disco_order_items with the edited lines. Shared by the confirm path
  // (immediate apply) and the pending/invoice path (so the order reflects the
  // edited items right away, even while the delta invoice is outstanding).
  async function writeNeonItems(): Promise<void> {
    if (!discoOrder) return
    // disco_order_item_addons has no FK/cascade on order_item_id — deleting
    // disco_order_items alone (as this used to do) orphans the old add-on rows
    // permanently disconnected from any current item, silently losing that
    // money on save (confirmed live: order #900000086's entire $11.00
    // subtotal lived on one add-on). Clear them explicitly, in the SAME
    // transaction as the item delete+recreate, so this can't happen again.
    const oldItemRows = (await sql`SELECT id FROM disco_order_items WHERE order_id = ${discoOrder.id}`.catch(() => [])) as { id: number }[]
    const oldItemIds = oldItemRows.map(r => r.id)

    // Atomic replace so a failed insert can't leave the order with missing items (I4).
    const stmts = [sql`DELETE FROM disco_order_items WHERE order_id = ${discoOrder.id}`]
    if (oldItemIds.length) stmts.push(sql`DELETE FROM disco_order_item_addons WHERE order_item_id = ANY(${oldItemIds})`)
    for (const l of activeLines) {
      const unit = Number(l.price) || 0
      stmts.push(sql`
        INSERT INTO disco_order_items (order_id, meal_package_reference, name, quantity, price_per_unit, total_price, serves, notes)
        VALUES (${discoOrder.id}, ${l.reference || null}, ${l.name}, ${Math.max(1, Math.trunc(Number(l.quantity) || 1))},
                ${unit}, ${round2(unit * (Number(l.quantity) || 0))}, ${servesToInt(l.serves)}, ${lineNote(l)})
      `)
    }
    await sql.transaction(stmts).catch(e => console.error('[orders/edit] items replace failed:', e))

    // Add-ons, attached after: re-read the just-inserted items (same order as
    // activeLines — both insertion-ordered) to get their new ids, then write
    // each line's add-ons. Best-effort/logged, same two-phase shape
    // lib/order/native-checkout.ts already uses at initial placement (item
    // insert first to get its id, add-ons attached right after) — the I4
    // guarantee above covers the items themselves; a single add-on failing to
    // write is logged, not silently dropped, and never blocks the item replace.
    if (activeLines.some(l => Array.isArray(l.addOns) && l.addOns.length)) {
      const newItemRows = (await sql`
        SELECT id FROM disco_order_items WHERE order_id = ${discoOrder.id} ORDER BY id
      `.catch(() => [])) as { id: number }[]
      for (let i = 0; i < activeLines.length && i < newItemRows.length; i++) {
        const line = activeLines[i]
        if (!Array.isArray(line.addOns) || !line.addOns.length) continue
        const itemId = newItemRows[i].id
        for (const a of line.addOns) {
          await sql`
            INSERT INTO disco_order_item_addons (order_item_id, name, price, quantity)
            VALUES (${itemId}, ${a.name || 'Add-on'}, ${round2(Number(a.price) || 0)}, ${Math.max(1, Math.trunc(Number(a.quantity ?? a.count) || 1))})
          `.catch(e => console.error('[orders/edit] addon insert failed:', e))
        }
      }
    }
  }

  // Persist the edited items into disco_order_items (replace) + the recalculated
  // money/date onto disco_orders. Used by the CONFIRM path — bumps edit_count and
  // clears edit_status. Only when the order is mirrored in Neon.
  async function writeNeonOrder(): Promise<void> {
    if (!discoOrder) return
    await writeNeonItems()
    await sql`
      UPDATE disco_orders SET
        subtotal = ${newSubtotal}, total = ${newTotal}, fee = ${newFee},
        -- The tip in dollars, as native checkout stores it (CUSTOM).
        tips = CASE WHEN ${tipChanged} THEN ${newTipDollars} ELSE tips END,
        tips_type = CASE WHEN ${tipChanged} THEN 'CUSTOM' ELSE tips_type END,
        -- A moved order gets a fresh restaurant reminder (lib/order/order-reminders.ts).
        admin_reminder_sent = CASE WHEN order_date IS DISTINCT FROM ${effDate}::date OR order_time IS DISTINCT FROM ${effTime}::time
          THEN false ELSE admin_reminder_sent END,
        order_date = ${effDate}::date, order_time = ${effTime}::time,
        edit_count = COALESCE(edit_count,0) + 1, edit_status = NULL, updated_at = NOW()
      WHERE id = ${discoOrder.id}
    `.catch(e => console.error('[orders/edit] disco_orders update:', e))
  }

  // A pickup ↔ delivery switch: the order's type, delivery type and address,
  // written the way native checkout writes them (fulfillmentToTypes), with the
  // delivery time-window snapshot a delivery order carries. Going to pickup
  // clears the address. Written with the items, in both the confirm and the
  // pending-invoice paths.
  async function writeFulfillment(): Promise<void> {
    if (!discoOrder || !fulfillmentChanged) return
    const { orderType, deliveryType } = fulfillmentToTypes(fulfillmentAfter)
    const d = fulfillmentAfter === 'PICKUP' ? null : newDelivery
    const timeWindow = fulfillmentAfter === 'PICKUP' ? null : await loadDeliveryTimeWindow(restaurantRef)
    await sql`
      UPDATE disco_orders SET
        order_type = ${orderType}, delivery_type = ${deliveryType}, delivery_time_window = ${timeWindow},
        delivery_address_line1 = ${d?.addressLine1 || null}, delivery_address_line2 = ${d?.addressLine2 || null},
        delivery_city = ${d?.city || null}, delivery_state = ${d?.state || null}, delivery_zip = ${d?.zip || null},
        delivery_lat = ${d?.latitude ?? null}, delivery_lng = ${d?.longitude ?? null},
        delivery_instructions = ${d ? (d.instructions || null) : null}, updated_at = NOW()
      WHERE id = ${discoOrder.id}
    `.catch(e => console.error('[orders/edit] fulfillment update:', e))
  }

  // The courier side of a switch. Off a courier delivery: stand the courier down
  // (recorded on the order, ops alerted if Expedite refuses) and, once Expedite
  // confirms, clear the booking from the order. Onto a courier delivery: book one
  // the way payment does — dispatchExpediteForOrder, which books only a
  // THIRD_PARTY_DELIVERY order whose own menu says third-party, so a
  // self-delivery menu can never get a courier. Booked at once on an invoiced
  // edit too, as an invoiced courier order is (expedite-dispatch-sweep.ts).
  async function switchCourier(): Promise<void> {
    if (!discoOrder || !fulfillmentChanged) return
    if (oldFulfillment === 'THIRD_PARTY_DELIVERY' && expediteToCancel) {
      const r = await cancelCourierAndReport(discoOrder.reference, 'PORTAL_EDIT', 'cancelled')
      if (r.success) {
        await sql`
          UPDATE disco_orders SET expedite_delivery_id = NULL, expedite_delivery_fee = NULL, expedite_provider_delivery_id = NULL, updated_at = NOW()
          WHERE id = ${discoOrder.id} AND expedite_delivery_id = ${expediteToCancel}
        `.catch(e => console.error('[orders/edit] clear courier booking:', e))
      }
    }
    if (fulfillmentAfter === 'THIRD_PARTY_DELIVERY' && nativeDispatchEnabled()) {
      waitUntil(dispatchExpediteForOrder(discoOrder.id))
    }
  }

  // Record the Stripe action in disco_stripe_payments (charges) + a
  // disco_sale_transactions row (ADDITIONAL / REFUND). For native orders this
  // stores the full recalculated breakdown (service charge, Stripe fee, tax
  // split, lead-gen by tier) instead of leaving those columns NULL, so
  // downstream reporting/exports that sum them stay accurate for edited orders.
  async function recordStripe(): Promise<void> {
    // void-reissue also gets the breakdown row: the reissued invoice replaces the
    // checkout one, so without it the PDF, details and reports kept the voided
    // checkout figures (#900000663: $376.82 shown, $336.54 billed). Its row is
    // INITIATED (nothing collected yet) and its total is the signed change.
    if (!discoOrder || (paymentAction !== 'charge' && paymentAction !== 'refund' && paymentAction !== 'void-reissue')) return
    if (paymentAction === 'charge' && stripePaymentIntentId) {
      await sql`
        INSERT INTO disco_stripe_payments (order_reference, restaurant_reference, stripe_payment_intent_id, status, total)
        VALUES (${discoOrder.reference}::uuid, ${restaurantRef}::uuid, ${stripePaymentIntentId}, 'SUCCEEDED', ${Math.abs(delta)})
        ON CONFLICT (stripe_payment_intent_id) DO NOTHING
      `.catch(e => console.error('[orders/edit] stripe_payments insert:', e))
    }
    const b = nativeBreakdown
    const ownDeliveryFee = b && nativeCtx?.fulfillment === 'OWN_DELIVERY' ? nativeCtx.ownDeliveryFee : null
    const thirdPartyDeliveryFee = b && nativeCtx?.fulfillment === 'THIRD_PARTY_DELIVERY' ? nativeCtx.thirdPartyDeliveryFee : null
    const thirdPartyDeliverySubsiding = b ? (nativeCtx?.thirdPartyDeliverySubsiding ?? null) : null
    const leadGenOne = b ? (nativeLeadGenTier === 1 ? b.leadGen : 0) : null
    const leadGenTwo = b ? (nativeLeadGenTier === 2 ? b.leadGen : 0) : null

    // ── REFUSE TO PERSIST A NON-FINITE MONEY VALUE ──────────────────────────
    // Postgres `numeric` accepts 'NaN' silently, and one NaN poisons every SUM
    // that touches it: orders 900000097-900000101 turned two restaurants' gross
    // AND the fleet total into NaN in reporting. placeNativeOrder has guarded
    // this since those orders were written; THIS path — the only other place a
    // recalculated breakdown reaches disco_sale_transactions — did not.
    //
    // Placed above the INSERT so a bad amount leaves no row behind. The Stripe
    // action has already happened by this point, so throwing here is the lesser
    // harm: a missing ledger row is visible and repairable, a NaN one silently
    // corrupts every report that sums it.
    assertFiniteMoney({
      newSubtotal, delta, newFee,
      serviceCharge: b?.serviceCharge, stripeFee: b?.stripeFee,
      stateTax: b?.stateTax, localTax: b?.localTax, otherTax: b?.otherTax,
      tipsInPrice: b?.tipsInPrice, thirdPartyDeliveryTips: b?.thirdPartyDeliveryTips,
      ownDeliveryFee, thirdPartyDeliveryFee, thirdPartyDeliverySubsiding,
      discount: b?.discount, leadGenOne, leadGenTwo,
    }, `orders/edit recordStripe(order=${discoOrder.reference})`)

    await sql`
      INSERT INTO disco_sale_transactions (
        order_id, transaction_type, transaction_status, subtotal, total, fee, stripe_payment_intent_id, transaction_date, paid_at,
        service_charge, stripe_fee, state_tax, local_tax, other_tax, tips_in_price, third_party_delivery_tips,
        own_delivery_fee, third_party_delivery_fee, third_party_delivery_subsiding, discount,
        lead_gen_one_disco_fee, lead_gen_two_disco_fee, source
      ) VALUES (
        ${discoOrder.id}, ${paymentAction === 'refund' ? 'REFUND' : 'ADDITIONAL'}, ${paymentAction === 'void-reissue' ? 'INITIATED' : 'PAID'},
        ${newSubtotal}, ${paymentAction === 'void-reissue' ? delta : Math.abs(delta)}, ${newFee}, ${stripePaymentIntentId || null}, NOW()::date,
        ${paymentAction === 'void-reissue' ? null : new Date().toISOString()}::timestamptz,
        ${b?.serviceCharge ?? null}, ${b?.stripeFee ?? null}, ${b?.stateTax ?? null}, ${b?.localTax ?? null}, ${b?.otherTax ?? null},
        ${b?.tipsInPrice ?? null}, ${b?.thirdPartyDeliveryTips ?? null},
        ${ownDeliveryFee}, ${thirdPartyDeliveryFee}, ${thirdPartyDeliverySubsiding}, ${b?.discount ?? null},
        ${leadGenOne}, ${leadGenTwo}, 'MANUAL_EDIT'
      )
    `.catch(e => console.error('[orders/edit] sale_transactions insert:', e))
  }

  // Shared "edit applied" tail: Neon writes → audit → emails. FM is read-only —
  // the edit is never pushed back to FamilyMeal.
  async function confirmEdit(): Promise<NextResponse> {
    await writeNeonOrder()
    await writeFulfillment()
    await recordStripe()

    await sql`
      INSERT INTO disco_order_edits (
        fm_order_reference, edit_number, editor_email, edited_by, edit_type,
        original_items, new_items, original_total, previous_total, new_total, delta,
        original_date, previous_date, new_date, original_time, new_time,
        payment_action, payment_status, stripe_payment_intent_id, stripe_invoice_id, stripe_refund_id,
        previous_tip, new_tip, previous_fulfillment, new_fulfillment, delivery_address
      ) VALUES (
        ${ref}::uuid, ${newEditNumber}, ${editorEmail || null}, ${editorEmail || null}, ${editType},
        ${JSON.stringify(origItems)}::jsonb, ${JSON.stringify(newItems)}::jsonb,
        ${base.total}, ${base.total}, ${newTotal}, ${delta},
        ${base.orderDateIso || null}::date, ${base.orderDateIso || null}::date, ${effDate || null}::date,
        ${base.orderTime || null}::time, ${effTime || null}::time,
        ${paymentAction}, ${paymentStatus},
        ${stripePaymentIntentId || null}, ${stripeInvoiceId || null}, ${stripeRefundId || null},
        ${tipChanged ? oldTipDollars : null}, ${tipChanged ? newTipDollars : null},
        ${fulfillmentChanged ? oldFulfillment : null}, ${fulfillmentChanged ? fulfillmentAfter : null}, ${fulfillmentChanged && newDelivery ? JSON.stringify(newDelivery) : null}::jsonb
      )
    `.catch(e => console.error('[orders/edit] disco_order_edits insert:', e))

    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${discoOrder?.reference || ref}::uuid, 'ORDER_EDITED',
              ${JSON.stringify({ editNumber: newEditNumber, editType, delta, newTotal, paymentAction, paymentStatus, ...(tipChanged ? { previousTip: oldTipDollars, newTip: newTipDollars } : {}), ...(fulfillmentChanged ? { previousFulfillment: oldFulfillment, newFulfillment: fulfillmentAfter, deliveryAddress: newDelivery } : {}) })}::jsonb, 'DISCO_EDIT')
    `.catch(e => console.error('[orders/edit] event insert:', e))

    const dateStr = fmtDate(effDate)
    const timeStr = fmtTime(effTime)
    // Every email this edit sends, sent together under waitUntil below (see
    // sendOrderUpdateEmails for why they are no longer fire-and-forget).
    const emails: OrderUpdateEmail[] = [...earlyEmails]
    if (customerEmail) {
      emails.push({ kind: 'customer', to: customerEmail, email: 'order_updated', send: () => sendOrderUpdated({ to: customerEmail, firstName, orderNumber, businessName, orderDate: dateStr, orderTime: timeStr, orderType: newOrderType, items: newItems, newTotal, delta, paymentOutcome: { action: paymentAction, status: paymentStatus } }) })
      // GATED ON paymentStatus, NOT paymentAction. This used to read
      // `paymentAction === 'refund'`, which is set BEFORE the refund is
      // attempted — so a refund that failed still told the customer their money
      // was on its way. Order #900000303 (Apollo Bagels - Kips Bay, 2026-10-06)
      // was an UNPAID invoice order edited downward: there was no PaymentIntent
      // to refund, the route correctly recorded payment_status='failed', and
      // Roxana was emailed "A refund of $172.29 has been issued... allow 5-10
      // business days" against an invoice that had never been paid.
      if (paymentStatus === 'refunded' && delta < 0) {
        emails.push({ kind: 'customer', to: customerEmail, email: 'refund_issued', send: () => sendOrderEditRefundIssued({ to: customerEmail, firstName, orderNumber, businessName, refundAmount: Math.abs(delta) }) })
      }
    }
    // EVERY configured recipient, not disco_orders.restaurant_email. That column
    // is empty on all 109 native orders (the native placement path never writes
    // it), so this branch used to skip silently and the kitchen was never told
    // its delivery had moved — while the customer's email went out fine.
    // FamilyMeal sends the ORDER CHANGE email to the customer AND to every
    // address in getRestaurantNotificationEmailsDeduplicated; this is that list.
    const restaurantEmails = await resolveRestaurantNotificationEmails(
      discoOrder?.restaurant_reference ?? null, discoOrder?.restaurant_email ?? null,
    )
    if (!restaurantEmails.length) {
      console.warn('[orders/edit] no restaurant recipient at any fallback level — restaurant not told of edit:', ref)
    }
    if (restaurantEmails.length) {
      // Attach the updated order PDF (best-effort — never blocks the email).
      let attachments: { filename: string; content: Uint8Array; contentType: string }[] | undefined
      if (discoOrder?.reference) {
        try {
          const pdf = await buildOrderPdfByReference(discoOrder.reference)
          // Shared naming helper — same filename the PDF route and the
          // confirmation email produce, so an edited order's attachment does
          // not arrive under a different scheme from the original.
          if (pdf) attachments = [{ filename: orderPdfFilename(businessName, orderNumber, discoOrder.reference), content: pdf, contentType: 'application/pdf' }]
        } catch (e) { console.error('[orders/edit] order PDF build failed:', e instanceof Error ? e.message : e) }
      }
      for (const to of restaurantEmails) {
        emails.push({ kind: 'restaurant', to, email: 'order_updated', send: () => sendOrderUpdatedRestaurant({ to, orderNumber, businessName, orderDate: dateStr, orderTime: timeStr, orderType: newOrderType, items: newItems, newTotal, delta, attachments, paymentOutcome: { action: paymentAction, status: paymentStatus } }) })
      }
    }
    waitUntil(sendOrderUpdateEmails(discoOrder?.reference || ref, 'DISCO_EDIT', emails))

    // Expedite — push the updated date/time/items to the courier (best-effort).
    // Recorded on the order; a refusal alerts ops (lib/order/courier-sync.ts).
    // A switch books or stands down the courier instead.
    if (discoOrder && fulfillmentChanged) await switchCourier()
    else if (discoOrder) await syncCourierAndReport(discoOrder.reference, 'PORTAL_EDIT')
    await alertFamilyMealDateChange()

    return NextResponse.json({ status: 'confirmed', editType, newTotal, delta, editNumber: newEditNumber })
  }

  // No saved card and a positive delta → invoice the customer; the edit is held
  // until invoice.paid (webhook applies it).
  async function goPending(): Promise<NextResponse> {
    paymentAction = 'invoice'; paymentStatus = 'invoiced'
    let invoiceUrl = ''
    if (stripe && customerEmail) {
      try {
        let customerId = pmRow?.stripe_customer_id || ''
        if (!customerId) {
          const cust = await stripe.customers.create({ email: customerEmail, name: [firstName, discoOrder?.customer_last_name].filter(Boolean).join(' ') || undefined })
          customerId = cust.id
        }
        // delta is already round2'd (dollars); Stripe wants integer cents.
        const deltaCents = Math.round(delta * 100)
        console.log('[orders/edit] creating edit invoice', { orderNumber, customerId, delta, deltaCents })
        // Create the invoice FIRST, then attach the line item directly to it via
        // `invoice: invoice.id`. Creating a "pending" invoice item and relying on
        // invoices.create to auto-collect it left the invoice empty ($0.00) under
        // the pinned 2025-01-27 API. auto_advance is off during creation so the
        // draft can't finalize before the line item is attached.
        // Native orders: stash the payout delta in metadata so the invoice.paid
        // webhook can move the restaurant's share via a manual Connect transfer
        // once the customer actually pays — mirrors placeNativeInvoiceOrder's
        // M7 pattern (metadata carries the payout so the webhook never re-prices).
        const invoice = await stripe.invoices.create({
          customer: customerId, collection_method: 'send_invoice', days_until_due: 7, auto_advance: false,
          metadata: {
            orderReference: discoOrder?.reference || ref, fmOrderReference: ref, orderNumber, kind: 'order_edit',
            ...(isNative && nativePay ? {
              transferDollars: String(nativeTransferDelta),
              connectedAccountId: nativePay.connectedAccountId ?? '',
              withholdPayouts: nativePay.withholdPayouts ? '1' : '0',
              ...(nativePay.holdSource ? { holdSource: nativePay.holdSource } : {}),
            } : {}),
          },
        })
        await stripe.invoiceItems.create({
          customer: customerId, invoice: invoice.id, amount: deltaCents, currency: 'usd',
          description: `Order #${orderNumber} update — additional amount due`,
        })
        const finalized = await stripe.invoices.finalizeInvoice(invoice.id)
        console.log('[orders/edit] edit invoice finalized', { invoiceId: invoice.id, amountDue: finalized.amount_due, total: finalized.total })
        await stripe.invoices.sendInvoice(invoice.id).catch(() => {})
        stripeInvoiceId = invoice.id
        invoiceUrl = (finalized.hosted_invoice_url as string) || ''
      } catch (e) {
        console.error('[orders/edit] invoice creation failed:', e instanceof Error ? e.message : e)
      }
    }

    // A positive delta REQUIRES collecting payment. If no invoice was created
    // (Stripe unavailable, no customer email, or an error above), do NOT park the
    // order in 'pending_payment' with a null invoice id — that left it stuck
    // non-editable forever. Abort before any Neon mutation (nothing to roll back).
    if (!stripeInvoiceId) {
      console.error('[orders/edit] no invoice created for positive delta — aborting pending edit', { orderNumber })
      return NextResponse.json({ error: 'Unable to process payment for this edit. Please try again.' }, { status: 502 })
    }

    const pending = {
      fmRef: ref, restaurantRef, orderType: newOrderType,
      // Add-ons and notes travel with the lines: applyPendingEdit re-saves the
      // items from these if the order no longer matches them, and without the
      // add-ons it saved the lines bare (#900000228 lost $188 of platter sizes,
      // #900000522 a $16 jelly add-on).
      activeLines: activeLines.map(l => ({
        reference: l.reference, quantity: l.quantity, name: l.name, price: l.price, serves: l.serves ?? null,
        addOns: l.addOns?.length ? l.addOns : undefined,
        note: lineNote(l) ?? undefined,
      })),
      // The full post-edit breakdown (native orders) — the same figures the
      // card-charge path writes on its ADDITIONAL row. applyPendingEdit records
      // it when the invoice is paid, so the PDF and order details can show the
      // edited order's real taxes/fees instead of the checkout ones.
      breakdown: nativeBreakdown ? {
        subtotal: newSubtotal, fee: newFee,
        serviceCharge: nativeBreakdown.serviceCharge, stripeFee: nativeBreakdown.stripeFee,
        stateTax: nativeBreakdown.stateTax, localTax: nativeBreakdown.localTax, otherTax: nativeBreakdown.otherTax,
        tipsInPrice: nativeBreakdown.tipsInPrice, thirdPartyDeliveryTips: nativeBreakdown.thirdPartyDeliveryTips,
        ownDeliveryFee: nativeCtx?.fulfillment === 'OWN_DELIVERY' ? nativeCtx.ownDeliveryFee : null,
        thirdPartyDeliveryFee: nativeCtx?.fulfillment === 'THIRD_PARTY_DELIVERY' ? nativeCtx.thirdPartyDeliveryFee : null,
        thirdPartyDeliverySubsiding: nativeCtx?.thirdPartyDeliverySubsiding ?? null,
        discount: nativeBreakdown.discount,
        leadGenOne: nativeLeadGenTier === 1 ? nativeBreakdown.leadGen : 0,
        leadGenTwo: nativeLeadGenTier === 2 ? nativeBreakdown.leadGen : 0,
      } : null,
      orderDateIso: effDate, orderTime: effTime,
      tips: tipChanged ? newTipDollars : base.tipsRaw, tipsType: tipChanged ? 'CUSTOM' : base.tipsType,
      newItems, newTotal, delta, editNumber: newEditNumber, editorEmail,
      origItems, origTotal: base.total, origDateIso: base.orderDateIso, origTime: base.orderTime,
      customerEmail, firstName, orderNumber, businessName,
    }
    if (discoOrder) {
      // Apply the edited items + recalculated money/date to Neon immediately so
      // disco_order_items and disco_orders.total reflect the edit right away (a
      // native order has no Disco-vaulted card, so an increase always lands here
      // — without this the order would look unchanged until the invoice is paid).
      // edit_count is intentionally NOT bumped here; the invoice.paid handler
      // (applyPendingEdit) bumps it once when the delta is collected.
      await writeNeonItems()
      await sql`
        UPDATE disco_orders
        SET subtotal = ${newSubtotal}, total = ${newTotal}, fee = ${newFee},
            tips = CASE WHEN ${tipChanged} THEN ${newTipDollars} ELSE tips END,
            tips_type = CASE WHEN ${tipChanged} THEN 'CUSTOM' ELSE tips_type END,
            -- A moved order gets a fresh restaurant reminder (lib/order/order-reminders.ts).
            admin_reminder_sent = CASE WHEN order_date IS DISTINCT FROM ${effDate}::date OR order_time IS DISTINCT FROM ${effTime}::time
              THEN false ELSE admin_reminder_sent END,
            order_date = ${effDate}::date, order_time = ${effTime}::time,
            edit_status = 'pending_payment', pending_edit_data = ${JSON.stringify(pending)}::jsonb,
            pending_edit_delta = ${delta}, pending_stripe_invoice_id = ${stripeInvoiceId || null}, updated_at = NOW()
        WHERE id = ${discoOrder.id}
      `.catch(e => console.error('[orders/edit] pending update:', e))
      await writeFulfillment()
      await switchCourier()
    }
    await sql`
      INSERT INTO disco_order_edits (
        fm_order_reference, edit_number, editor_email, edited_by, edit_type,
        original_items, new_items, original_total, previous_total, new_total, delta,
        original_date, previous_date, new_date, original_time, new_time,
        payment_action, payment_status, stripe_invoice_id, previous_tip, new_tip,
        previous_fulfillment, new_fulfillment, delivery_address
      ) VALUES (
        ${ref}::uuid, ${newEditNumber}, ${editorEmail || null}, ${editorEmail || null}, ${editType},
        ${JSON.stringify(origItems)}::jsonb, ${JSON.stringify(newItems)}::jsonb,
        ${base.total}, ${base.total}, ${newTotal}, ${delta},
        ${base.orderDateIso || null}::date, ${base.orderDateIso || null}::date, ${effDate || null}::date,
        ${base.orderTime || null}::time, ${effTime || null}::time,
        'invoice', 'pending', ${stripeInvoiceId || null},
        ${tipChanged ? oldTipDollars : null}, ${tipChanged ? newTipDollars : null},
        ${fulfillmentChanged ? oldFulfillment : null}, ${fulfillmentChanged ? fulfillmentAfter : null}, ${fulfillmentChanged && newDelivery ? JSON.stringify(newDelivery) : null}::jsonb
      )
    `.catch(e => console.error('[orders/edit] pending edit insert:', e))

    const pendingEmails: OrderUpdateEmail[] = []
    if (customerEmail) pendingEmails.push({ kind: 'customer', to: customerEmail, email: 'payment_required', send: () => sendOrderEditPaymentRequired({ to: customerEmail, firstName, orderNumber, businessName, amountDue: delta, invoiceUrl: invoiceUrl || undefined }) })
    // Same resolver as the applied-edit tail above — see its comment.
    const pendingRestaurantEmails = await resolveRestaurantNotificationEmails(
      discoOrder?.restaurant_reference ?? null, discoOrder?.restaurant_email ?? null,
    )
    for (const to of pendingRestaurantEmails) {
      pendingEmails.push({ kind: 'restaurant', to, email: 'edit_pending_payment', send: () => sendOrderEditPendingRestaurant({ to, orderNumber, businessName, amountDue: delta }) })
    }
    waitUntil(sendOrderUpdateEmails(discoOrder?.reference || ref, 'DISCO_EDIT', pendingEmails))

    await alertFamilyMealDateChange()
    return NextResponse.json({ status: 'pending_payment', editType, delta, amountDue: delta, invoiceUrl, editNumber: newEditNumber })
  }

  // ── 3. PAYMENT DELTA → apply ────────────────────────────────────────────────
  try {
    if (NO_DELTA) {
      paymentAction = 'none'; paymentStatus = 'none'
      return await confirmEdit()
    }

    if (delta > 0) {
      // Charge the saved card; on success confirm, else fall back to an invoice.
      if (stripe && pmRow?.stripe_customer_id && pmRow?.stripe_payment_method_id) {
        try {
          // Native: route the delta through Connect transfer_data (same helper
          // placement uses) so the restaurant actually receives its share of an
          // upsell instead of the whole delta landing on Disco's platform balance.
          // Non-native (FM-backed): unchanged raw charge — this route's Stripe
          // logic was never wired to FM's own PaymentIntents either way.
          const pi = isNative && nativePay
            ? await createNativeOrderPaymentIntent(stripe, {
                totalDollars: delta,
                transferDollars: nativeTransferDelta,
                connectedAccountId: nativePay.connectedAccountId,
                withholdPayouts: nativePay.withholdPayouts,
                holdSource: nativePay.holdSource,
                customerId: pmRow.stripe_customer_id,
                paymentMethodId: pmRow.stripe_payment_method_id,
                offSession: true, confirm: true, onBehalfOf: true,
                description: `Order #${orderNumber} update — additional amount`,
                metadata: { orderReference: discoOrder?.reference || ref, fmOrderReference: ref, kind: 'order_edit' },
              })
            : await stripe.paymentIntents.create({
                amount: Math.round(delta * 100), currency: 'usd',
                customer: pmRow.stripe_customer_id, payment_method: pmRow.stripe_payment_method_id,
                off_session: true, confirm: true,
                description: `Order #${orderNumber} update — additional amount`,
                metadata: { orderReference: discoOrder?.reference || ref, fmOrderReference: ref, kind: 'order_edit' },
              })
          if (pi.status === 'succeeded') {
            paymentAction = 'charge'; paymentStatus = 'succeeded'; stripePaymentIntentId = pi.id
            return await confirmEdit()
          }
          return await goPending()
        } catch (e) {
          console.error('[orders/edit] charge failed, invoicing:', e instanceof Error ? e.message : e)
          return await goPending()
        }
      }
      return await goPending() // no card on file → invoice
    }

    // ── UNPAID INVOICE ORDER, REDUCED → VOID AND REISSUE, NEVER REFUND ──────
    // Decided by lib/order/edit-payment-action.ts so the rule is testable
    // without firing a Stripe call or an email. Nothing has been collected on
    // this order, so there is no payment to refund — the stale invoice is
    // withdrawn and the correct one issued for the NEW TOTAL (not the delta;
    // the original invoice billed the whole order, so its replacement must).
    if (decideEditPaymentAction({
      delta, orderStatus: discoOrder?.order_status ?? null,
      invoiceId: discoOrder?.stripe_invoice_id ?? null,
      invoiceStatus: discoOrder?.stripe_invoice_status ?? null,
    }) === 'void-reissue') {
      paymentAction = 'void-reissue'
      const voided = await voidUnpaidOrderInvoice(discoOrder?.reference || ref, stripe)
      if (voided.action === 'failed') {
        // Do NOT proceed: leaving the old invoice payable while Neon shows the
        // reduced total is exactly the state this fix exists to remove — the
        // customer could pay the higher, stale amount.
        console.error('[orders/edit] void failed, not reissuing:', voided.error)
        await alertEditVoidFailed(discoOrder?.reference || ref, discoOrder?.stripe_invoice_id ?? null, voided.error)
        return NextResponse.json({ error: 'Unable to update the invoice for this edit. Please try again.' }, { status: 502 })
      }

      let reissuedUrl = ''
      if (stripe && customerEmail) {
        try {
          let customerId = pmRow?.stripe_customer_id || ''
          if (!customerId) {
            const cust = await stripe.customers.create({ email: customerEmail, name: [firstName, discoOrder?.customer_last_name].filter(Boolean).join(' ') || undefined })
            customerId = cust.id
          }
          const inv = await stripe.invoices.create({
            customer: customerId, collection_method: 'send_invoice', days_until_due: 7, auto_advance: false,
            metadata: {
              orderReference: discoOrder?.reference || ref, fmOrderReference: ref, orderNumber, kind: 'order_edit_reissue',
              ...(isNative && nativePay ? {
                // The payout for the WHOLE reduced order, not a delta — this
                // invoice replaces the original, so the webhook must transfer
                // the restaurant's share of the new total when it is paid.
                transferDollars: String(nativeBreakdown?.transfer ?? 0),
                connectedAccountId: nativePay.connectedAccountId ?? '',
                withholdPayouts: nativePay.withholdPayouts ? '1' : '0',
                ...(nativePay.holdSource ? { holdSource: nativePay.holdSource } : {}),
              } : {}),
            },
          })
          await stripe.invoiceItems.create({
            customer: customerId, invoice: inv.id, amount: Math.round(newTotal * 100), currency: 'usd',
            description: `Order #${orderNumber} — updated total`,
          })
          const finalized = await stripe.invoices.finalizeInvoice(inv.id)
          await stripe.invoices.sendInvoice(inv.id).catch(() => {})
          stripeInvoiceId = inv.id
          reissuedUrl = (finalized.hosted_invoice_url as string) || ''
          paymentStatus = 'invoiced'
          await sql`
            UPDATE disco_orders SET stripe_invoice_id = ${inv.id}, stripe_invoice_status = 'open', updated_at = NOW()
            WHERE reference = ${discoOrder?.reference || ref}::uuid
          `.catch(e => console.error('[orders/edit] reissue invoice id update:', e))
        } catch (e) {
          console.error('[orders/edit] reissue failed after void:', e instanceof Error ? e.message : e)
          paymentStatus = 'failed'
          await alertEditReissueFailed(discoOrder?.reference || ref, newTotal, e)
        }
      }
      // An updated-invoice email, never a refund email. Nothing was refunded.
      if (customerEmail && paymentStatus === 'invoiced') {
        earlyEmails.push({ kind: 'customer', to: customerEmail, email: 'payment_required', send: () => sendOrderEditPaymentRequired({
          to: customerEmail, firstName, orderNumber, businessName,
          amountDue: newTotal, invoiceUrl: reissuedUrl,
        }) })
      }
      return await confirmEdit()
    }

    // delta < 0 → refund against the original payment intent. Native: reuse
    // refundNativeOrder (the same helper the dedicated full-refund routes use) so
    // a transfer_data-backed charge gets reverse_transfer:true — the restaurant's
    // payout shrinks proportionally instead of Disco absorbing the whole refund.
    // A LOWER COURIER TIP IS NOT REFUNDED HERE. It went to the courier through
    // Disco, so the restaurant has none of it to give back, and Disco's money
    // moves only with Peter's explicit OK (CLAUDE.md). Refused before anything
    // moves; the edit is refused whole.
    if (courierTipLowered) {
      return NextResponse.json({ error: "Contact Disco Cater to lower this order's tip. It is a courier tip held by Disco Cater, so it can't be refunded from here. Nothing was changed." }, { status: 409 })
    }
    // A courier delivery's fee and tip were collected by Disco Cater for the
    // courier, never paid to the restaurant, and every refund comes from the
    // restaurant: the refund for switching it to pickup is made by hand.
    if (fulfillmentChanged && oldFulfillment === 'THIRD_PARTY_DELIVERY') {
      return NextResponse.json({ error: "Contact Disco Cater to switch this courier delivery to pickup. Its delivery fee and courier tip were collected by Disco Cater for the courier, so they can't be refunded from here. Nothing was changed." }, { status: 409 })
    }
    paymentAction = 'refund'
    if (stripe && isNative && discoOrder) {
      try {
        // Pass the EXACT tiered-engine transfer delta rather than letting Stripe
        // auto-compute a proportional reversal — verified empirically that the
        // auto-proportional split under-reverses once Stripe's flat $0.30 fee is
        // in the mix (it assumes the transfer scales linearly with the total).
        const r = await refundNativeOrder(stripe, discoOrder.reference, Math.abs(delta), Math.max(0, -nativeTransferDelta), { via: 'order_edit' })
        stripeRefundId = r.refundId; paymentStatus = 'refunded'
      } catch (e) {
        // Refused because the restaurant cannot give its share back: nothing moved,
        // so the edit is refused whole and its reason shown, rather than saved with
        // the customer owed a refund nobody was told about.
        if (e instanceof RefundRefusedError) return NextResponse.json({ error: e.message }, { status: 409 })
        console.error('[orders/edit] native refund failed:', e instanceof Error ? e.message : e)
        paymentStatus = 'failed'
      }
    } else if (stripe && originalPaymentIntentId) {
      // A FamilyMeal-processed payment. This was a plain refunds.create with nothing
      // reversed, so Disco funded the whole refund. Now the restaurant's share comes
      // back the same way as a native refund, checked before anything moves, and a
      // payment with no Stripe transfer to reverse is refused (Peter, 2 Nov 2026).
      try {
        const r = await refundPaymentFromRestaurant(stripe, discoOrder?.reference || ref, originalPaymentIntentId, Math.abs(delta), 'order_edit')
        stripeRefundId = r.refundId; paymentStatus = 'refunded'
      } catch (e) {
        if (e instanceof RefundRefusedError) return NextResponse.json({ error: e.message }, { status: 409 })
        console.error('[orders/edit] refund failed:', e instanceof Error ? e.message : e)
        paymentStatus = 'failed'
      }
    } else {
      // ALERT, not a console.warn. This is the state that produced the false
      // refund email on #900000303 and it was invisible: the route logged a
      // warning nobody reads, recorded payment_status='failed', and the
      // customer was told money was coming. Reaching here now means an order
      // that is NOT an unpaid invoice order still has no PaymentIntent to
      // refund — genuinely anomalous, and worth waking someone.
      console.warn('[orders/edit] refund requested but no original payment intent / Stripe — recording as failed')
      paymentStatus = 'failed'
      await alertEditRefundImpossible(discoOrder?.reference || ref, Math.abs(delta))
    }
    return await confirmEdit()
  } catch (e) {
    console.error('[orders/edit] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to commit the edit.' }, { status: 500 })
  }
}
