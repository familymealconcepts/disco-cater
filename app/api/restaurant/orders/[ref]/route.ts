import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../lib/order/order-scope'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'
import { loadFmOrderDetails, fmDateToIso, isUuid } from '../../../../../lib/order-edit'
import { displayEmail } from '../../../../../lib/customer-email-guard'
import { loadOrderItemsWithAddOns, type OrderItemWithAddOns } from '../../../../../lib/order-items'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS_TRANSITIONS: Record<string, string[]> = {
  DUE: ['COMPLETED', 'CANCELED'],
  PAID: ['COMPLETED', 'CANCELED'],
  UNPAID: ['CANCELED'],
  RESERVED: ['DUE', 'CANCELED'],
  COMPLETED: ['REOPEN'],
  // Refunded orders stay active; Complete is the only allowed transition.
  REFUNDED: ['COMPLETED'],
  REFUND: ['COMPLETED'],
  PARTIAL_REFUND: ['COMPLETED'],
}
// Refundable states. CANCELED/CANCELLED and VOID/VOIDED are INCLUDED deliberately:
// a cancelled or voided order can still be holding a real charge, and gating the
// portal's Refund button on this set meant the button vanished at exactly the moment
// it was needed — cancel an order and the only UI for giving the money back
// disappears with it (order 900000104, $293.40 cancelled and still captured).
// Cancelling now refunds automatically (see the status route), so this is the
// backstop for anything cancelled before that shipped, or refunded manually.
const REFUNDABLE = new Set(['DUE', 'PAID', 'COMPLETED', 'CANCELED', 'CANCELLED', 'VOID', 'VOIDED'])

interface DiscoFull {
  id: number
  reference: string
  fm_order_reference: string | null
  order_number: string
  order_status: string
  order_type: string
  delivery_type: string | null
  source_of_order: string
  restaurant_reference: string | null
  restaurant_name: string | null
  customer_email: string | null
  customer_first_name: string | null
  customer_last_name: string | null
  customer_phone: string | null
  order_date: string
  order_time: string
  order_drop_off_time: string | null
  subtotal: string | null
  total: string | null
  fee: string | null
  tips: string | null
  refund: string | null
  note: string | null
  delivery_address_line1: string | null
  delivery_address_line2: string | null
  delivery_city: string | null
  delivery_state: string | null
  delivery_zip: string | null
  tax_exempt_id: string | null
  tax_exempt_state: string | null
  created_at: string | null
  placed_at: string | null
  persons: number | null
  company_name: string | null
}
interface DiscoTxn {
  service_charge: string | null; stripe_fee: string | null
  state_tax: string | null; local_tax: string | null; other_tax: string | null
  tips_in_price: string | null; third_party_delivery_tips: string | null
  own_delivery_fee: string | null; third_party_delivery_fee: string | null
  discount: string | null; lead_gen_one_disco_fee: string | null; lead_gen_two_disco_fee: string | null
}

function num(v: unknown): number { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : 0 }

// GET — order details for the portal drawer. Reads Neon (disco_orders +
// disco_order_items) as the source of truth and, for FM-backed orders,
// overlays FM /details (service auth) for fields Neon doesn't store (tax
// breakdown, restaurant address, etc.) — FM stays live and correct for those
// permanently (restaurants convert to native one at a time; FM keeps running
// for everyone else). Never called for Disco-native orders — FM never had
// them, so calling it was pure waste (the actual policy violation this fixed).
// Falls back to FM-only when the order isn't mirrored in Neon yet at all.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Ownership: don't disclose another restaurant's order / customer PII.
  const scope = await assertOrderInScope(ref, ctx)
  if (!scope.ok) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  try { await runDiscoOrderMigrations() } catch { /* best-effort */ }

  // Neon first — source of truth for native orders, and (once mirrored) for
  // FM-backed ones too. Populated by native checkout, the order-edit route,
  // and the FM order-detail backfill/sync.
  let disco: DiscoFull | null = null
  let items: OrderItemWithAddOns[] = []
  let txn: DiscoTxn | null = null
  if (isUuid(ref)) {
    const rows = (await sql`
      SELECT id, reference, fm_order_reference, order_number, order_status, order_type, delivery_type,
             source_of_order, restaurant_reference, restaurant_name, customer_email, customer_first_name, customer_last_name, customer_phone,
             to_char(order_date,'YYYY-MM-DD') AS order_date, order_time::text AS order_time, order_drop_off_time::text AS order_drop_off_time,
             subtotal, total, fee, tips, refund, note,
             delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip, tax_exempt_id, tax_exempt_state,
             created_at, placed_at, persons, company_name
      FROM disco_orders
      WHERE fm_order_reference = ${ref}::uuid OR reference = ${ref}::uuid
      LIMIT 1
    `.catch(() => [])) as DiscoFull[]
    disco = rows[0] ?? null
    if (disco) {
      items = await loadOrderItemsWithAddOns(disco.id)
      const txnRows = (await sql`
        SELECT service_charge, stripe_fee, state_tax, local_tax, other_tax,
               tips_in_price, third_party_delivery_tips, own_delivery_fee, third_party_delivery_fee,
               discount, lead_gen_one_disco_fee, lead_gen_two_disco_fee
        FROM disco_sale_transactions WHERE order_id = ${disco.id} AND transaction_type = 'ORIGINAL' LIMIT 1
      `.catch(() => [])) as DiscoTxn[]
      txn = txnRows[0] ?? null
    }
  }

  // FM details — only when Neon's data is actually incomplete, not just
  // because the order happens to be FM-sourced. Was gated on
  // `source_of_order !== 'DISCO'` alone, which called FM live for every one of
  // ~24,200 FM-sourced orders on every lookup — including the ~23,100 that
  // already have a complete transaction row AND items in Neon and never
  // needed it. Confirmed empirically that "a transaction row exists" is NOT
  // sufficient on its own: 69 real orders have a disco_sale_transactions row
  // but zero disco_order_items (syncOrderItemsFromDetails bails early on an
  // empty items array while syncSaleTransactionFromDetails writes
  // unconditionally — see lib/fm-orders-sync.ts) — so both are checked. Never
  // for Disco-native orders regardless (FM never had them; calling FM anyway
  // was the actual policy violation this fixed). Falls back to FM as the only
  // source when Neon doesn't have the order yet at all.
  //
  // NOT verified complete by this check: per-item add-ons. A real order can
  // legitimately have zero add-ons, so an empty disco_order_item_addons set
  // can't be distinguished from "add-on sync failed for this item" without
  // FM's own data — which is exactly what skipping the FM call means not
  // fetching. This is a pre-existing, latent gap (nothing before this change
  // detected it either); not made worse here, just not newly closed.
  const needsFm = !disco || (disco.source_of_order !== 'DISCO' && (!txn || items.length === 0))
  const fmDetails = needsFm ? await loadFmOrderDetails(ref) : null
  const fmOrder = (((fmDetails?.data as Record<string, unknown>)?.order as Record<string, unknown>)
    ?? (fmDetails?.order as Record<string, unknown>)
    ?? fmDetails
    ?? null) as Record<string, unknown> | null

  if (!disco && !fmOrder) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  // FM-only fallback: order not mirrored in Neon yet → return FM order flat.
  if (!disco && fmOrder) {
    const out = { ...fmOrder }
    if (typeof out.orderDate === 'string') out.orderDate = fmDateToIso(out.orderDate)
    return NextResponse.json(out)
  }

  // Neon-first merge: start from FM (rich extras), override core with Neon.
  const d = disco as DiscoFull
  const base: Record<string, unknown> = fmOrder ? { ...fmOrder } : {}

  base.orderNumber = Number(d.order_number)
  base.orderStatus = d.order_status
  base.orderType = d.order_type
  base.deliveryType = d.delivery_type || base.deliveryType || ''
  base.orderDate = String(d.order_date).slice(0, 10) // YYYY-MM-DD (drawer expects ISO)
  base.orderTime = d.order_time
  if (d.order_drop_off_time) base.orderDropOffTime = d.order_drop_off_time
  base.firstName = d.customer_first_name || base.firstName || ''
  base.lastName = d.customer_last_name || base.lastName || ''
  base.email = displayEmail(d.customer_email) || base.email || ''
  if (d.customer_phone) base.phoneNumber = d.customer_phone
  base.sourceoforder = d.source_of_order
  // Order Placed + headcount — Neon-first. placed_at is FM's real order-creation
  // timestamp (backfilled for pre-freeze orders, populated going forward by the
  // fixed sync) — created_at is Neon sync time, which for FM-mirrored orders can
  // trail real placement by hours to years.
  const orderPlaced = d.placed_at || d.created_at
  if (orderPlaced) { base.createdDate = orderPlaced; base.orderCreatedDate = orderPlaced }
  if (d.persons != null) base.persons = d.persons
  if (d.company_name != null) base.companyName = d.company_name
  if (d.note != null) base.note = d.note
  if (d.subtotal != null) base.subtotal = num(d.subtotal)
  if (d.total != null) { base.total = num(d.total); base.transactionsTotal = num(d.total) }
  if (d.fee != null) base.fee = num(d.fee)
  if (d.refund != null) base.refund = num(d.refund)
  // Tax-exempt id — Neon-first, else keep FM's (taxExempt/taxExemptId).
  if (d.tax_exempt_id) { base.taxExemptId = d.tax_exempt_id; base.taxExempt = true }
  // Display-only label (e.g. "NJ") — captured at native-checkout placement
  // time, never exposed by FM's live order-details endpoint (checked
  // directly: no tax/exempt field of any kind in its response) or present in
  // the frozen fm_backup snapshot (only tax_exempt_id exists there). Doesn't
  // affect whether tax is charged — isTaxExempt is taxExemptId-driven, above —
  // just which state's exemption is shown. Blank for FM-only orders is the
  // real, permanent state of FM's own data, not a gap this route introduces.
  if (d.tax_exempt_state) base.taxExemptState = d.tax_exempt_state
  // Full financial breakdown — Neon-first when a transaction row exists (native
  // checkout, a manual edit, or a completed FM backfill), else keep FM's own
  // paymentDetails fields. Same flat key names FM's OrderPublicResponseDto uses,
  // so the drawer (orders/page.tsx) and the PDF need no changes to consume this.
  if (txn) {
    base.serviceCharge = num(txn.service_charge)
    base.stripeFee = num(txn.stripe_fee)
    base.stateSalesTaxInPrice = num(txn.state_tax)
    base.localSalesTaxInPrice = num(txn.local_tax)
    base.otherSalesTaxInPrice = num(txn.other_tax)
    base.tipsInPrice = num(txn.tips_in_price)
    base.thirdPartyDeliveryTipsInPrice = num(txn.third_party_delivery_tips)
    base.ownDeliveryFee = num(txn.own_delivery_fee)
    base.thirdPartyDeliveryFee = num(txn.third_party_delivery_fee)
    base.discount = num(txn.discount)
    base.leadGenOneDiscoFee = num(txn.lead_gen_one_disco_fee)
    base.leadGenTwoDiscoFee = num(txn.lead_gen_two_disco_fee)
  }
  // Restaurant identity for the drawer + PDF. Canonical name/address/phone live
  // in disco_restaurant_cache (native orders have no FM restaurant, and
  // disco_orders.restaurant_name is often null). Prefer any FM values already on
  // base.restaurant; fall back to the cache.
  {
    const r = (base.restaurant as Record<string, unknown>) || {}
    let cacheName = ''
    let cacheAddress = ''
    let cachePhone = ''
    if (d.restaurant_reference) {
      try {
        const rc = (await sql`
          SELECT name, address, phone FROM disco_restaurant_cache
          WHERE restaurant_reference = ${d.restaurant_reference} LIMIT 1
        `.catch(() => [])) as { name: string | null; address: string | null; phone: string | null }[]
        cacheName = rc[0]?.name || ''
        cacheAddress = rc[0]?.address || ''
        cachePhone = rc[0]?.phone || ''
      } catch { /* best-effort */ }
    }
    const businessName = (r.businessName as string) || d.restaurant_name || cacheName || ''
    const fmAddr = (r.address as Record<string, unknown> | undefined)
    // Keep FM's structured address when present; otherwise synthesize one from the
    // cache so the PDF/drawer show the store address + phone.
    const address = fmAddr && (fmAddr.addressLine1 || fmAddr.city)
      ? { ...fmAddr, phoneNumber: fmAddr.phoneNumber || cachePhone || undefined }
      : (cacheAddress || cachePhone ? { addressLine1: cacheAddress || undefined, phoneNumber: cachePhone || undefined } : fmAddr)
    if (businessName || address) {
      base.restaurant = { ...r, ...(businessName ? { businessName } : {}), ...(address ? { address } : {}) }
    }
  }
  // Delivery address — prefer FM's; fall back to Neon's stored address.
  if (!base.deliveryAddress && d.delivery_address_line1) {
    base.deliveryAddress = {
      addressLine1: d.delivery_address_line1, addressLine2: d.delivery_address_line2 || undefined,
      city: d.delivery_city || '', state: d.delivery_state || '', zipcode: d.delivery_zip || '',
    }
  }

  // Line items — Neon is source of truth when present, else keep FM's.
  if (items.length) {
    // FM's own field names (count/price), matching lib/pricing/lineItem.ts's
    // OrderLineModifier — the drawer/popout already renders this shape
    // correctly (including a $0.00 add-on as its own sub-line, never
    // filtered out) for FM-native orders; it was only ever missing here.
    base.orderMealPackages = items.map(it => ({
      name: it.name, count: it.quantity, price: it.pricePerUnit,
      mealPackageReference: it.mealPackageReference || undefined,
      orderAddOns: it.addOns.length ? it.addOns.map(a => ({ name: a.name, count: a.quantity, price: a.price })) : undefined,
    }))
    base.orderClassics = []
  }

  // Whether money was ACTUALLY taken — a SUCCEEDED PaymentIntent, not merely a
  // status that implies one. Drives the portal's "customer is still charged" notice
  // on a cancelled order; a cancellation that was never paid (cancelled while
  // RESERVED, or an unpaid invoice) must not show it.
  try {
    const paid = (await sql`
      SELECT 1 FROM disco_stripe_payments
      WHERE order_reference = ${d.reference}::uuid
        AND status = 'SUCCEEDED' AND stripe_payment_intent_id IS NOT NULL
      LIMIT 1
    `) as unknown[]
    base.wasCharged = paid.length > 0
  } catch { /* best-effort — absence just means no notice is shown */ }

  base.orderStatusesToChange = STATUS_TRANSITIONS[d.order_status] || []
  if (base.maxAllowedRefundAmount == null) {
    base.maxAllowedRefundAmount = REFUNDABLE.has(d.order_status) ? Math.max(0, num(d.total) - num(d.refund)) : 0
  }

  return NextResponse.json(base)
}
