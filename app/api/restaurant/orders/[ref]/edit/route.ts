import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import {
  getDiscoOrder, loadFmOrderDetails, parseFmOrder, applyFmOrderUpdate, computeNewTotals,
  hoursUntil, isEditableStatus, MAX_EDITS, type FmOrderItem,
} from '../../../../../../lib/order-edit'
import {
  sendOrderUpdated, sendOrderUpdatedRestaurant, sendOrderEditRefundIssued,
  sendOrderEditPaymentRequired, sendOrderEditPendingRestaurant, type EditItem,
} from '../../../../../../lib/email/notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.discocater.com'

interface ActiveLine { reference: string; name: string; price: number; quantity: number; serves?: string | number | null }

function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])
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
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try { await runDiscoOrderMigrations() } catch { /* best-effort */ }

  let body: { activeLines?: ActiveLine[]; orderDate?: string; orderTime?: string; editorEmail?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }

  const activeLines: ActiveLine[] = Array.isArray(body.activeLines) ? body.activeLines : []
  const orderDate = String(body.orderDate || '').slice(0, 10) // YYYY-MM-DD
  const orderTime = String(body.orderTime || '')             // HH:MM:SS
  const editorEmail = String(body.editorEmail || '')
  if (!activeLines.length) return NextResponse.json({ error: 'At least one item is required.' }, { status: 400 })

  // ── 1. VALIDATION ──────────────────────────────────────────────────────────
  // Disco-side guards first (fail fast; also exercisable without a live FM order).
  const discoOrder = await getDiscoOrder(ref)
  const editCount = discoOrder?.edit_count ?? 0
  if (editCount >= MAX_EDITS) return NextResponse.json({ error: 'Maximum edits reached' }, { status: 400 })
  if (discoOrder && hoursUntil(String(discoOrder.order_date).slice(0, 10), discoOrder.order_time) < 24) {
    return NextResponse.json({ error: 'Order cannot be edited within 24 hours of pickup' }, { status: 400 })
  }
  if (discoOrder && !isEditableStatus(discoOrder.order_status)) {
    return NextResponse.json({ error: `This order is ${discoOrder.order_status.toLowerCase()} and can no longer be edited.` }, { status: 400 })
  }

  // FM details are authoritative for money/items/pickup.
  const details = await loadFmOrderDetails(ref)
  if (!details) return NextResponse.json({ error: 'Could not load the order from FamilyMeal.' }, { status: 502 })
  const fm = parseFmOrder(details)
  if (hoursUntil(fm.orderDateIso, fm.orderTime) < 24) {
    return NextResponse.json({ error: 'Order cannot be edited within 24 hours of pickup' }, { status: 400 })
  }
  if (fm.status && !isEditableStatus(fm.status)) {
    return NextResponse.json({ error: `This order is ${fm.status.toLowerCase()} and can no longer be edited.` }, { status: 400 })
  }

  // ── 2. COMPUTE DELTA ────────────────────────────────────────────────────────
  const { newSubtotal, newTaxAndFee, newTotal, delta } = computeNewTotals(activeLines, {
    subtotal: fm.subtotal, total: fm.total, tip: fm.tip, delivery: fm.delivery, taxRate: fm.taxRate,
  })
  void newSubtotal; void newTaxAndFee

  const restaurantRef = fm.restaurantRef || discoOrder?.restaurant_reference || ctx.restaurantReference || ''
  const customerEmail = fm.customerEmail || discoOrder?.customer_email || ''
  const firstName = fm.firstName || discoOrder?.customer_first_name || ''
  const businessName = fm.restaurantName || discoOrder?.restaurant_name || 'the restaurant'
  const orderNumber = String(fm.orderNumber || discoOrder?.order_number || '')
  const newEditNumber = editCount + 1

  const newItems: EditItem[] = activeLines.map(l => ({ count: l.quantity, name: l.name, price: l.price }))
  const origItems: FmOrderItem[] = fm.items

  // ── 3. DATE/TIME-ONLY / NO-DELTA CHECK ───────────────────────────────────────
  // A negligible delta (date/time change, or items priced the same) skips payment.
  const NO_DELTA = Math.abs(delta) < 0.01

  // Stripe identity (default saved card) + the original payment intent (refunds).
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

  const stripe = stripeClient()

  // ── 4. PAYMENT HANDLING ──────────────────────────────────────────────────────
  let paymentAction: 'charge' | 'refund' | 'invoice' | 'none' = 'none'
  let paymentStatus: 'succeeded' | 'refunded' | 'invoiced' | 'pending' | 'failed' | 'none' = 'none'
  let stripePaymentIntentId = ''
  let stripeRefundId = ''
  let stripeInvoiceId = ''

  // Re-applies the edit to FM + Neon and emails — the shared "confirm" tail used
  // by the no-delta, charge-succeeded, and refund paths.
  async function confirmEdit(): Promise<NextResponse> {
    // ── 5. UPDATE FM ORDER (best-effort) ──
    await applyFmOrderUpdate({
      fmRef: ref, restaurantRef, activeLines: activeLines.map(l => ({ reference: l.reference, quantity: l.quantity })),
      orderDateIso: orderDate || fm.orderDateIso, orderTime: orderTime || fm.orderTime, orderType: fm.orderType,
      tips: fm.tipsRaw, tipsType: fm.tipsType,
    })

    // ── 6. UPDATE NEON ──
    if (discoOrder) {
      await sql`
        UPDATE disco_orders
        SET edit_count = COALESCE(edit_count,0) + 1,
            order_date = ${orderDate || fm.orderDateIso}::date,
            order_time = ${orderTime || fm.orderTime}::time,
            edit_status = NULL,
            updated_at = NOW()
        WHERE id = ${discoOrder.id}
      `.catch(e => console.error('[orders/edit] disco_orders update failed:', e))
    }
    await sql`
      INSERT INTO disco_order_edits (
        fm_order_reference, edit_number, editor_email, original_items, new_items,
        original_total, new_total, delta, original_date, new_date, original_time, new_time,
        payment_action, payment_status, stripe_payment_intent_id, stripe_invoice_id, stripe_refund_id
      ) VALUES (
        ${ref}::uuid, ${newEditNumber}, ${editorEmail || null},
        ${JSON.stringify(origItems)}::jsonb, ${JSON.stringify(newItems)}::jsonb,
        ${fm.total}, ${newTotal}, ${delta},
        ${fm.orderDateIso || null}::date, ${(orderDate || fm.orderDateIso) || null}::date,
        ${fm.orderTime || null}::time, ${(orderTime || fm.orderTime) || null}::time,
        ${paymentAction}, ${paymentStatus},
        ${stripePaymentIntentId || null}, ${stripeInvoiceId || null}, ${stripeRefundId || null}
      )
    `.catch(e => console.error('[orders/edit] disco_order_edits insert failed:', e))
    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${discoOrder?.reference || ref}::uuid, 'ORDER_EDITED',
              ${JSON.stringify({ editNumber: newEditNumber, delta, newTotal, paymentAction, paymentStatus })}::jsonb, 'DISCO_EDIT')
    `.catch(e => console.error('[orders/edit] event insert failed:', e))

    // ── 7. EMAILS ──
    const dateStr = fmtDate(orderDate || fm.orderDateIso)
    const timeStr = fmtTime(orderTime || fm.orderTime)
    if (customerEmail) {
      sendOrderUpdated({ to: customerEmail, firstName, orderNumber, businessName, orderDate: dateStr, orderTime: timeStr, items: newItems, newTotal, delta }).catch(() => {})
      if (paymentAction === 'refund' && delta < 0) {
        sendOrderEditRefundIssued({ to: customerEmail, firstName, orderNumber, businessName, refundAmount: Math.abs(delta) }).catch(() => {})
      }
    }
    const restaurantEmail = discoOrder?.restaurant_email || ''
    if (restaurantEmail) {
      sendOrderUpdatedRestaurant({ to: restaurantEmail, orderNumber, businessName, orderDate: dateStr, orderTime: timeStr, items: newItems, newTotal, delta }).catch(() => {})
    }

    // ── 8. RETURN ──
    return NextResponse.json({ status: 'confirmed', newTotal, delta, editNumber: newEditNumber })
  }

  // Pending-payment path: invoice the customer for a positive delta we couldn't
  // collect on a saved card. Stores the proposed edit for the webhook to apply.
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
        await stripe.invoiceItems.create({ customer: customerId, amount: Math.round(delta * 100), currency: 'usd', description: `Order #${orderNumber} update — additional amount due` })
        const invoice = await stripe.invoices.create({
          customer: customerId, collection_method: 'send_invoice', days_until_due: 7, auto_advance: true,
          metadata: { orderReference: discoOrder?.reference || ref, fmOrderReference: ref, orderNumber, kind: 'order_edit' },
        })
        const finalized = await stripe.invoices.finalizeInvoice(invoice.id)
        await stripe.invoices.sendInvoice(invoice.id).catch(() => {})
        stripeInvoiceId = invoice.id
        invoiceUrl = (finalized.hosted_invoice_url as string) || ''
      } catch (e) {
        console.error('[orders/edit] invoice creation failed:', e instanceof Error ? e.message : e)
      }
    }

    // Persist the proposed edit for the webhook to apply on invoice.paid.
    const pending = {
      fmRef: ref, restaurantRef, orderType: fm.orderType,
      activeLines: activeLines.map(l => ({ reference: l.reference, quantity: l.quantity, name: l.name, price: l.price })),
      orderDateIso: orderDate || fm.orderDateIso, orderTime: orderTime || fm.orderTime,
      tips: fm.tipsRaw, tipsType: fm.tipsType,
      newItems, newTotal, delta, editNumber: newEditNumber, editorEmail,
      origItems, origTotal: fm.total, origDateIso: fm.orderDateIso, origTime: fm.orderTime,
      customerEmail, firstName, orderNumber, businessName,
    }
    if (discoOrder) {
      await sql`
        UPDATE disco_orders
        SET edit_status = 'pending_payment', pending_edit_data = ${JSON.stringify(pending)}::jsonb,
            pending_edit_delta = ${delta}, pending_stripe_invoice_id = ${stripeInvoiceId || null}, updated_at = NOW()
        WHERE id = ${discoOrder.id}
      `.catch(e => console.error('[orders/edit] pending update failed:', e))
    }
    await sql`
      INSERT INTO disco_order_edits (
        fm_order_reference, edit_number, editor_email, original_items, new_items,
        original_total, new_total, delta, original_date, new_date, original_time, new_time,
        payment_action, payment_status, stripe_invoice_id
      ) VALUES (
        ${ref}::uuid, ${newEditNumber}, ${editorEmail || null},
        ${JSON.stringify(origItems)}::jsonb, ${JSON.stringify(newItems)}::jsonb,
        ${fm.total}, ${newTotal}, ${delta},
        ${fm.orderDateIso || null}::date, ${(orderDate || fm.orderDateIso) || null}::date,
        ${fm.orderTime || null}::time, ${(orderTime || fm.orderTime) || null}::time,
        'invoice', 'pending', ${stripeInvoiceId || null}
      )
    `.catch(e => console.error('[orders/edit] pending edit insert failed:', e))

    if (customerEmail) sendOrderEditPaymentRequired({ to: customerEmail, firstName, orderNumber, businessName, amountDue: delta, invoiceUrl: invoiceUrl || undefined }).catch(() => {})
    const restaurantEmail = discoOrder?.restaurant_email || ''
    if (restaurantEmail) sendOrderEditPendingRestaurant({ to: restaurantEmail, orderNumber, businessName, amountDue: delta }).catch(() => {})

    return NextResponse.json({ status: 'pending_payment', delta, amountDue: delta, invoiceUrl, editNumber: newEditNumber })
  }

  try {
    if (NO_DELTA) {
      paymentAction = 'none'; paymentStatus = 'none'
      return await confirmEdit()
    }

    if (delta > 0) {
      // Charge the saved card if present; on success confirm, otherwise invoice.
      if (stripe && pmRow?.stripe_customer_id && pmRow?.stripe_payment_method_id) {
        try {
          const pi = await stripe.paymentIntents.create({
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
          return await goPending() // requires_action / etc.
        } catch (e) {
          console.error('[orders/edit] charge failed, invoicing:', e instanceof Error ? e.message : e)
          return await goPending()
        }
      }
      // No card on file → invoice.
      return await goPending()
    }

    // delta < 0 → refund against the original payment intent.
    paymentAction = 'refund'
    if (stripe && originalPaymentIntentId) {
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
