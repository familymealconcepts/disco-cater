import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { getRestaurantRole } from '../../../../../../lib/restaurant-auth'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import {
  getDiscoOrder, loadOrderBaseline,
  hoursUntil, isEditableStatus, MAX_EDITS, syncExpediteOnEdit, type FmOrderItem,
  isOrderInPast, loadRestaurantTimeZone,
} from '../../../../../../lib/order-edit'
import {
  sendOrderUpdated, sendOrderUpdatedRestaurant, sendOrderEditRefundIssued,
  sendOrderEditPaymentRequired, sendOrderEditPendingRestaurant, type EditItem,
} from '../../../../../../lib/email/notifications'
import { buildOrderPdfByReference } from '../../../../../../lib/order/order-pdf'
import { orderPdfFilename } from '../../../../../../lib/download-filename'
import { isDiscoNativeRestaurant, loadRestaurantServiceChargePct } from '../../../../../../lib/order/native-checkout'
import { createNativeOrderPaymentIntent, getRestaurantPayoutConfig, type RestaurantPayoutConfig } from '../../../../../../lib/order/native-payment'
import { refundNativeOrder } from '../../../../../../lib/order/native-refund'
import { priceNativeOrderAtSubtotal, type Fulfillment, type FrozenEditContext } from '../../../../../../lib/pricing/native-order'
import type { Breakdown } from '../../../../../../lib/promo-pricing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FEE_RATE = 0.03 // 3% platform fee on subtotal

interface ActiveLineAddOn { name: string; price: number; count?: number; quantity?: number }
interface ActiveLine {
  reference: string; name: string; price: number; quantity: number; serves?: string | number | null
  addOns?: ActiveLineAddOn[]
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
function fmtTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '')
  if (!m) return t || ''
  let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12
  return `${h}:${m[2]} ${ap}`
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  // Admin portal (fm_admin_token) gets the same full edit as a restaurant
  // SUPER_ADMIN: when there's no restaurant session, fall back to admin auth and
  // resolve the order's restaurant from the order row itself (not the session).
  const ctx = await getRestaurantAuthContext()
  let isAdminEdit = false
  if (!ctx) {
    try { await getAdminAuthHeader(); isAdminEdit = true }
    catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  } else {
    // Restaurant session: only edit (and charge/refund) its own order. Admin
    // portal (isAdminEdit) is exempt — it resolves the restaurant from the order.
    const scope = await assertOrderInScope(ref, ctx)
    if (!scope.ok) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }
  try { await runDiscoOrderMigrations() } catch { /* best-effort */ }

  let body: { activeLines?: ActiveLine[]; orderDate?: string; orderTime?: string; editorEmail?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }

  const activeLines: ActiveLine[] = Array.isArray(body.activeLines) ? body.activeLines : []
  const orderDate = String(body.orderDate || '').slice(0, 10) // YYYY-MM-DD
  const orderTime = String(body.orderTime || '')             // HH:MM:SS
  const editorEmail = String(body.editorEmail || '')
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
  const effTime = orderTime || base.orderTime

  // What changed (drives edit_type + the reschedule 24h rule).
  const origMap = new Map<string, number>()
  for (const i of base.items) origMap.set(i.reference, (origMap.get(i.reference) || 0) + i.count)
  const newMap = new Map<string, number>()
  for (const l of activeLines) newMap.set(l.reference, (newMap.get(l.reference) || 0) + l.quantity)
  let itemsChanged = origMap.size !== newMap.size
  if (!itemsChanged) for (const [k, v] of newMap) if (origMap.get(k) !== v) { itemsChanged = true; break }
  const dateChanged = (!!orderDate && orderDate !== base.orderDateIso) || (!!orderTime && orderTime.slice(0, 5) !== (base.orderTime || '').slice(0, 5))
  const editType: 'RESCHEDULE' | 'ITEMS' | 'BOTH' = itemsChanged && dateChanged ? 'BOTH' : itemsChanged ? 'ITEMS' : 'RESCHEDULE'

  // RESCHEDULE rule: the NEW pickup must be ≥24h away (SUPER_ADMIN exempt).
  if (!isSuperAdmin && dateChanged && hoursUntil(effDate, effTime) < 24) {
    return NextResponse.json({ error: 'New pickup must be at least 24 hours from now.' }, { status: 400 })
  }

  const restaurantRef = base.restaurantRef || discoOrder?.restaurant_reference || ctx?.restaurantReference || ''
  const isNative = restaurantRef ? await isDiscoNativeRestaurant(restaurantRef) : false

  // ── 2. RECALCULATE MONEY ────────────────────────────────────────────────────
  // Native orders: run the SAME cent-exact tiered engine placement uses (tax
  // rates, lead-gen %, service charge, real Stripe fee) instead of a flat 3%,
  // and derive the restaurant-payout delta (`nativeTransferDelta`) so the Stripe
  // charge/refund below can route it through Connect. Non-native (FM-backed)
  // orders keep the original flat-rate/blended-tax-rate math unchanged — this
  // route's Stripe logic was never wired to FM's own PaymentIntents anyway.
  // Add-ons count toward the subtotal too — an item whose real price lives
  // entirely on an add-on (base price $0.00, e.g. #900000086's "jojos") would
  // otherwise recompute to $0 here, understating the charge/refund delta below
  // by the exact amount the item-only formula used to miss.
  const newSubtotal = round2(activeLines.reduce((a, l) => {
    const lineBase = (Number(l.price) || 0) * (Number(l.quantity) || 0)
    const lineAddOns = Array.isArray(l.addOns)
      ? l.addOns.reduce((s, ao) => s + (Number(ao.price) || 0) * Math.max(1, Math.trunc(Number(ao.quantity ?? ao.count) || 1)), 0)
      : 0
    return a + lineBase + lineAddOns
  }, 0))
  let newTaxes: number, newFee: number, newTotal: number, delta: number
  let nativeTransferDelta = 0
  let nativeBreakdown: Breakdown | null = null
  let nativePay: RestaurantPayoutConfig | null = null
  let nativeCtx: FrozenEditContext | null = null
  let nativeLeadGenTier: 1 | 2 | 0 = 0

  if (isNative && discoOrder) {
    const [delRows, origRows] = await Promise.all([
      sql`SELECT delivery_type, menu_reference FROM disco_orders WHERE id = ${discoOrder.id} LIMIT 1`.catch(() => []),
      sql`
        SELECT subtotal, discount, own_delivery_fee, third_party_delivery_fee, third_party_delivery_subsiding,
               lead_gen_one_disco_fee, lead_gen_two_disco_fee
        FROM disco_sale_transactions WHERE order_id = ${discoOrder.id} AND transaction_type = 'ORIGINAL' LIMIT 1
      `.catch(() => []),
    ]) as [
      { delivery_type: string | null; menu_reference: string | null }[],
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
    const fulfillment: Fulfillment = deliveryType === 'OWN_DELIVERY' ? 'OWN_DELIVERY' : deliveryType === 'THIRD_PARTY_DELIVERY' ? 'THIRD_PARTY_DELIVERY' : 'PICKUP'
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
      ownDeliveryFee: Number(orig?.own_delivery_fee) || 0,
      thirdPartyDeliveryFee: Number(orig?.third_party_delivery_fee) || 0,
      thirdPartyDeliverySubsiding: Number(orig?.third_party_delivery_subsiding) || 0,
      tipDollars: Number(discoOrder.tips) || 0,
      discountPct, leadGenPct, scPct,
      orderType: base.orderType === 'DELIVERY' ? 'DELIVERY' : 'PICKUP',
    }
    nativeCtx = editCtx
    const oldB = await priceNativeOrderAtSubtotal(restaurantRef, base.subtotal, editCtx)
    const newB = await priceNativeOrderAtSubtotal(restaurantRef, newSubtotal, editCtx)
    // Same guard as the FM-backed branch below (#61848359's fix, mirrored): a
    // native restaurant with no real tax rate on file would otherwise recompute
    // this edit's charge/refund delta at a fabricated 0% tax.
    if (!newB.taxReliable) {
      return NextResponse.json({
        error: "Can't recalculate this order's tax right now — no real tax rate is on file for this restaurant. Contact support if this persists.",
      }, { status: 409 })
    }
    newTaxes = round2(newB.stateTax + newB.localTax + newB.otherTax)
    newFee = newB.familyMealFee
    newTotal = newB.total
    delta = round2(newB.total - oldB.total)
    nativeTransferDelta = round2(newB.transfer - oldB.transfer)
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
  const newItems: EditItem[] = activeLines.map(l => ({ count: l.quantity, name: l.name, price: l.price }))
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
  let paymentAction: 'charge' | 'refund' | 'invoice' | 'none' = 'none'
  let paymentStatus: 'succeeded' | 'refunded' | 'invoiced' | 'pending' | 'failed' | 'none' = 'none'
  let stripePaymentIntentId = ''
  let stripeRefundId = ''
  let stripeInvoiceId = ''

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
        INSERT INTO disco_order_items (order_id, meal_package_reference, name, quantity, price_per_unit, total_price, serves)
        VALUES (${discoOrder.id}, ${l.reference || null}, ${l.name}, ${Math.max(1, Math.trunc(Number(l.quantity) || 1))},
                ${unit}, ${round2(unit * (Number(l.quantity) || 0))}, ${servesToInt(l.serves)})
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
        order_date = ${effDate}::date, order_time = ${effTime}::time,
        edit_count = COALESCE(edit_count,0) + 1, edit_status = NULL, updated_at = NOW()
      WHERE id = ${discoOrder.id}
    `.catch(e => console.error('[orders/edit] disco_orders update:', e))
  }

  // Record the Stripe action in disco_stripe_payments (charges) + a
  // disco_sale_transactions row (ADDITIONAL / REFUND). For native orders this
  // stores the full recalculated breakdown (service charge, Stripe fee, tax
  // split, lead-gen by tier) instead of leaving those columns NULL, so
  // downstream reporting/exports that sum them stay accurate for edited orders.
  async function recordStripe(): Promise<void> {
    if (!discoOrder || (paymentAction !== 'charge' && paymentAction !== 'refund')) return
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
    await sql`
      INSERT INTO disco_sale_transactions (
        order_id, transaction_type, transaction_status, subtotal, total, fee, stripe_payment_intent_id, transaction_date, paid_at,
        service_charge, stripe_fee, state_tax, local_tax, other_tax, tips_in_price, third_party_delivery_tips,
        own_delivery_fee, third_party_delivery_fee, third_party_delivery_subsiding, discount,
        lead_gen_one_disco_fee, lead_gen_two_disco_fee, source
      ) VALUES (
        ${discoOrder.id}, ${paymentAction === 'charge' ? 'ADDITIONAL' : 'REFUND'}, 'PAID',
        ${newSubtotal}, ${Math.abs(delta)}, ${newFee}, ${stripePaymentIntentId || null}, NOW()::date, NOW(),
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
    await recordStripe()

    await sql`
      INSERT INTO disco_order_edits (
        fm_order_reference, edit_number, editor_email, edited_by, edit_type,
        original_items, new_items, original_total, previous_total, new_total, delta,
        original_date, previous_date, new_date, original_time, new_time,
        payment_action, payment_status, stripe_payment_intent_id, stripe_invoice_id, stripe_refund_id
      ) VALUES (
        ${ref}::uuid, ${newEditNumber}, ${editorEmail || null}, ${editorEmail || null}, ${editType},
        ${JSON.stringify(origItems)}::jsonb, ${JSON.stringify(newItems)}::jsonb,
        ${base.total}, ${base.total}, ${newTotal}, ${delta},
        ${base.orderDateIso || null}::date, ${base.orderDateIso || null}::date, ${effDate || null}::date,
        ${base.orderTime || null}::time, ${effTime || null}::time,
        ${paymentAction}, ${paymentStatus},
        ${stripePaymentIntentId || null}, ${stripeInvoiceId || null}, ${stripeRefundId || null}
      )
    `.catch(e => console.error('[orders/edit] disco_order_edits insert:', e))

    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${discoOrder?.reference || ref}::uuid, 'ORDER_EDITED',
              ${JSON.stringify({ editNumber: newEditNumber, editType, delta, newTotal, paymentAction, paymentStatus })}::jsonb, 'DISCO_EDIT')
    `.catch(e => console.error('[orders/edit] event insert:', e))

    const dateStr = fmtDate(effDate)
    const timeStr = fmtTime(effTime)
    if (customerEmail) {
      sendOrderUpdated({ to: customerEmail, firstName, orderNumber, businessName, orderDate: dateStr, orderTime: timeStr, items: newItems, newTotal, delta }).catch(() => {})
      if (paymentAction === 'refund' && delta < 0) {
        sendOrderEditRefundIssued({ to: customerEmail, firstName, orderNumber, businessName, refundAmount: Math.abs(delta) }).catch(() => {})
      }
    }
    const restaurantEmail = discoOrder?.restaurant_email || ''
    if (restaurantEmail) {
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
      sendOrderUpdatedRestaurant({ to: restaurantEmail, orderNumber, businessName, orderDate: dateStr, orderTime: timeStr, items: newItems, newTotal, delta, attachments }).catch(() => {})
    }

    // Expedite — push the updated date/time/items to the courier (best-effort).
    if (discoOrder) await syncExpediteOnEdit(discoOrder.id, discoOrder.reference)

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
      fmRef: ref, restaurantRef, orderType: base.orderType,
      activeLines: activeLines.map(l => ({ reference: l.reference, quantity: l.quantity, name: l.name, price: l.price })),
      orderDateIso: effDate, orderTime: effTime, tips: base.tipsRaw, tipsType: base.tipsType,
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
            order_date = ${effDate}::date, order_time = ${effTime}::time,
            edit_status = 'pending_payment', pending_edit_data = ${JSON.stringify(pending)}::jsonb,
            pending_edit_delta = ${delta}, pending_stripe_invoice_id = ${stripeInvoiceId || null}, updated_at = NOW()
        WHERE id = ${discoOrder.id}
      `.catch(e => console.error('[orders/edit] pending update:', e))
    }
    await sql`
      INSERT INTO disco_order_edits (
        fm_order_reference, edit_number, editor_email, edited_by, edit_type,
        original_items, new_items, original_total, previous_total, new_total, delta,
        original_date, previous_date, new_date, original_time, new_time,
        payment_action, payment_status, stripe_invoice_id
      ) VALUES (
        ${ref}::uuid, ${newEditNumber}, ${editorEmail || null}, ${editorEmail || null}, ${editType},
        ${JSON.stringify(origItems)}::jsonb, ${JSON.stringify(newItems)}::jsonb,
        ${base.total}, ${base.total}, ${newTotal}, ${delta},
        ${base.orderDateIso || null}::date, ${base.orderDateIso || null}::date, ${effDate || null}::date,
        ${base.orderTime || null}::time, ${effTime || null}::time,
        'invoice', 'pending', ${stripeInvoiceId || null}
      )
    `.catch(e => console.error('[orders/edit] pending edit insert:', e))

    if (customerEmail) sendOrderEditPaymentRequired({ to: customerEmail, firstName, orderNumber, businessName, amountDue: delta, invoiceUrl: invoiceUrl || undefined }).catch(() => {})
    const restaurantEmail = discoOrder?.restaurant_email || ''
    if (restaurantEmail) sendOrderEditPendingRestaurant({ to: restaurantEmail, orderNumber, businessName, amountDue: delta }).catch(() => {})

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

    // delta < 0 → refund against the original payment intent. Native: reuse
    // refundNativeOrder (the same helper the dedicated full-refund routes use) so
    // a transfer_data-backed charge gets reverse_transfer:true — the restaurant's
    // payout shrinks proportionally instead of Disco absorbing the whole refund.
    paymentAction = 'refund'
    if (stripe && isNative && discoOrder) {
      try {
        // Pass the EXACT tiered-engine transfer delta rather than letting Stripe
        // auto-compute a proportional reversal — verified empirically that the
        // auto-proportional split under-reverses once Stripe's flat $0.30 fee is
        // in the mix (it assumes the transfer scales linearly with the total).
        const r = await refundNativeOrder(stripe, discoOrder.reference, Math.abs(delta), Math.abs(nativeTransferDelta))
        stripeRefundId = r.refundId; paymentStatus = 'refunded'
      } catch (e) {
        console.error('[orders/edit] native refund failed:', e instanceof Error ? e.message : e)
        paymentStatus = 'failed'
      }
    } else if (stripe && originalPaymentIntentId) {
      try {
        const refund = await stripe.refunds.create({ payment_intent: originalPaymentIntentId, amount: Math.round(Math.abs(delta) * 100) })
        stripeRefundId = refund.id; paymentStatus = 'refunded'
      } catch (e) {
        console.error('[orders/edit] refund failed:', e instanceof Error ? e.message : e)
        paymentStatus = 'failed'
      }
    } else {
      console.warn('[orders/edit] refund requested but no original payment intent / Stripe — recording as failed')
      paymentStatus = 'failed'
    }
    return await confirmEdit()
  } catch (e) {
    console.error('[orders/edit] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to commit the edit.' }, { status: 500 })
  }
}
