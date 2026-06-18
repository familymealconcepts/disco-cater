import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import {
  getDiscoOrder, loadFmOrderDetails, parseFmOrder, applyFmOrderUpdate,
  hoursUntil, isEditableStatus, MAX_EDITS, type FmOrderItem,
} from '../../../../../../lib/order-edit'
import {
  sendOrderUpdated, sendOrderUpdatedRestaurant, sendOrderEditRefundIssued,
  sendOrderEditPaymentRequired, sendOrderEditPendingRestaurant, type EditItem,
} from '../../../../../../lib/email/notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FEE_RATE = 0.03 // 3% platform fee on subtotal

interface ActiveLine { reference: string; name: string; price: number; quantity: number; serves?: string | number | null }

function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
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

  // ── 1. VALIDATION + edit_count gate ─────────────────────────────────────────
  const discoOrder = await getDiscoOrder(ref)
  const editCount = discoOrder?.edit_count ?? 0
  if (editCount >= MAX_EDITS) {
    return NextResponse.json({ error: 'Maximum edits reached. Contact the customer directly.' }, { status: 400 })
  }
  if (discoOrder && hoursUntil(String(discoOrder.order_date).slice(0, 10), discoOrder.order_time) < 24) {
    return NextResponse.json({ error: 'Order cannot be edited within 24 hours of pickup.' }, { status: 400 })
  }
  if (discoOrder && !isEditableStatus(discoOrder.order_status)) {
    return NextResponse.json({ error: `This order is ${discoOrder.order_status.toLowerCase()} and can no longer be edited.` }, { status: 400 })
  }

  // FM details are authoritative for original money/items/pickup.
  const details = await loadFmOrderDetails(ref)
  if (!details) return NextResponse.json({ error: 'Could not load the order from FamilyMeal.' }, { status: 502 })
  const fm = parseFmOrder(details)
  if (fm.status && !isEditableStatus(fm.status)) {
    return NextResponse.json({ error: `This order is ${fm.status.toLowerCase()} and can no longer be edited.` }, { status: 400 })
  }

  const effDate = orderDate || fm.orderDateIso
  const effTime = orderTime || fm.orderTime

  // What changed (drives edit_type + the reschedule 24h rule).
  const origMap = new Map<string, number>()
  for (const i of fm.items) origMap.set(i.reference, (origMap.get(i.reference) || 0) + i.count)
  const newMap = new Map<string, number>()
  for (const l of activeLines) newMap.set(l.reference, (newMap.get(l.reference) || 0) + l.quantity)
  let itemsChanged = origMap.size !== newMap.size
  if (!itemsChanged) for (const [k, v] of newMap) if (origMap.get(k) !== v) { itemsChanged = true; break }
  const dateChanged = (!!orderDate && orderDate !== fm.orderDateIso) || (!!orderTime && orderTime.slice(0, 5) !== (fm.orderTime || '').slice(0, 5))
  const editType: 'RESCHEDULE' | 'ITEMS' | 'BOTH' = itemsChanged && dateChanged ? 'BOTH' : itemsChanged ? 'ITEMS' : 'RESCHEDULE'

  // RESCHEDULE rule: the NEW pickup must be ≥24h away.
  if (dateChanged && hoursUntil(effDate, effTime) < 24) {
    return NextResponse.json({ error: 'New pickup must be at least 24 hours from now.' }, { status: 400 })
  }

  // ── 2. RECALCULATE MONEY ────────────────────────────────────────────────────
  // subtotal from items; fee = 3% of subtotal; taxes at the original tax rate;
  // tip + delivery preserved from the original order.
  const newSubtotal = round2(activeLines.reduce((a, l) => a + (Number(l.price) || 0) * (Number(l.quantity) || 0), 0))
  const taxRate = fm.subtotal > 0 ? fm.tax / fm.subtotal : 0
  const newTaxes = round2(newSubtotal * taxRate)
  const newFee = round2(newSubtotal * FEE_RATE)
  const newTotal = round2(newSubtotal + newTaxes + newFee + fm.tip + fm.delivery)
  const delta = round2(newTotal - fm.total)

  const restaurantRef = fm.restaurantRef || discoOrder?.restaurant_reference || ctx.restaurantReference || ''
  const customerEmail = fm.customerEmail || discoOrder?.customer_email || ''
  const firstName = fm.firstName || discoOrder?.customer_first_name || ''
  const businessName = fm.restaurantName || discoOrder?.restaurant_name || 'the restaurant'
  const orderNumber = String(fm.orderNumber || discoOrder?.order_number || '')
  const newEditNumber = editCount + 1
  const newItems: EditItem[] = activeLines.map(l => ({ count: l.quantity, name: l.name, price: l.price }))
  const origItems: FmOrderItem[] = fm.items
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

  const stripe = stripeClient()
  let paymentAction: 'charge' | 'refund' | 'invoice' | 'none' = 'none'
  let paymentStatus: 'succeeded' | 'refunded' | 'invoiced' | 'pending' | 'failed' | 'none' = 'none'
  let stripePaymentIntentId = ''
  let stripeRefundId = ''
  let stripeInvoiceId = ''

  // Persist the edited items into disco_order_items (replace) + the recalculated
  // money/date onto disco_orders. Only when the order is mirrored in Neon.
  async function writeNeonOrder(): Promise<void> {
    if (!discoOrder) return
    await sql`DELETE FROM disco_order_items WHERE order_id = ${discoOrder.id}`.catch(e => console.error('[orders/edit] items delete:', e))
    for (const l of activeLines) {
      const unit = Number(l.price) || 0
      await sql`
        INSERT INTO disco_order_items (order_id, meal_package_reference, name, quantity, price_per_unit, total_price, serves)
        VALUES (${discoOrder.id}, ${l.reference || null}, ${l.name}, ${Math.max(1, Math.trunc(Number(l.quantity) || 1))},
                ${unit}, ${round2(unit * (Number(l.quantity) || 0))}, ${servesToInt(l.serves)})
      `.catch(e => console.error('[orders/edit] item insert:', e))
    }
    await sql`
      UPDATE disco_orders SET
        subtotal = ${newSubtotal}, total = ${newTotal}, fee = ${newFee},
        order_date = ${effDate}::date, order_time = ${effTime}::time,
        edit_count = COALESCE(edit_count,0) + 1, edit_status = NULL, updated_at = NOW()
      WHERE id = ${discoOrder.id}
    `.catch(e => console.error('[orders/edit] disco_orders update:', e))
  }

  // Record the Stripe action in disco_stripe_payments (charges) + a
  // disco_sale_transactions row (ADDITIONAL / REFUND).
  async function recordStripe(): Promise<void> {
    if (!discoOrder || (paymentAction !== 'charge' && paymentAction !== 'refund')) return
    if (paymentAction === 'charge' && stripePaymentIntentId) {
      await sql`
        INSERT INTO disco_stripe_payments (order_reference, restaurant_reference, stripe_payment_intent_id, status, total)
        VALUES (${discoOrder.reference}::uuid, ${restaurantRef}::uuid, ${stripePaymentIntentId}, 'SUCCEEDED', ${Math.abs(delta)})
        ON CONFLICT (stripe_payment_intent_id) DO NOTHING
      `.catch(e => console.error('[orders/edit] stripe_payments insert:', e))
    }
    await sql`
      INSERT INTO disco_sale_transactions (order_id, transaction_type, transaction_status, subtotal, total, fee, stripe_payment_intent_id, transaction_date, paid_at)
      VALUES (${discoOrder.id}, ${paymentAction === 'charge' ? 'ADDITIONAL' : 'REFUND'}, 'PAID',
              ${newSubtotal}, ${Math.abs(delta)}, ${newFee}, ${stripePaymentIntentId || null}, NOW()::date, NOW())
    `.catch(e => console.error('[orders/edit] sale_transactions insert:', e))
  }

  // Shared "edit applied" tail: best-effort FM PUT → Neon writes → audit → emails.
  async function confirmEdit(): Promise<NextResponse> {
    // Best-effort PUT to FM (merges new date in DD.MM.YYYY + items). Never fails.
    await applyFmOrderUpdate({
      fmRef: ref, restaurantRef, activeLines: activeLines.map(l => ({ reference: l.reference, quantity: l.quantity })),
      orderDateIso: effDate, orderTime: effTime, orderType: fm.orderType, tips: fm.tipsRaw, tipsType: fm.tipsType,
    })

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
        ${fm.total}, ${fm.total}, ${newTotal}, ${delta},
        ${fm.orderDateIso || null}::date, ${fm.orderDateIso || null}::date, ${effDate || null}::date,
        ${fm.orderTime || null}::time, ${effTime || null}::time,
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
      sendOrderUpdatedRestaurant({ to: restaurantEmail, orderNumber, businessName, orderDate: dateStr, orderTime: timeStr, items: newItems, newTotal, delta }).catch(() => {})
    }

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

    const pending = {
      fmRef: ref, restaurantRef, orderType: fm.orderType,
      activeLines: activeLines.map(l => ({ reference: l.reference, quantity: l.quantity, name: l.name, price: l.price })),
      orderDateIso: effDate, orderTime: effTime, tips: fm.tipsRaw, tipsType: fm.tipsType,
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
        ${fm.total}, ${fm.total}, ${newTotal}, ${delta},
        ${fm.orderDateIso || null}::date, ${fm.orderDateIso || null}::date, ${effDate || null}::date,
        ${fm.orderTime || null}::time, ${effTime || null}::time,
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
          return await goPending()
        } catch (e) {
          console.error('[orders/edit] charge failed, invoicing:', e instanceof Error ? e.message : e)
          return await goPending()
        }
      }
      return await goPending() // no card on file → invoice
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
