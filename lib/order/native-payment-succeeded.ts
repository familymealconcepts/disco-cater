// Shared "a native order's PaymentIntent actually succeeded" handler — the
// complete RESERVED→DUE path (inventory decrement + exhaustion refund,
// transaction/order updates, confirmations, third-party dispatch). Extracted
// from the Stripe webhook's payment_intent.succeeded case so a SECOND caller
// (the stale-RESERVED expiry sweep, lib/order/native-reserved-expiry.ts) can
// reconcile an order whose webhook delivery was missed/failed without
// reimplementing a partial copy of this logic. Idempotent by construction —
// every write here already guards on real state (order id resolved from
// disco_stripe_payments, dispatchOrderConfirmations' own once-per-order
// guard), so calling this twice for the same PaymentIntent is safe.
import Stripe from 'stripe'
import { sql } from '../db'
import { dispatchOrderConfirmations, dispatchInventoryUnavailableNotification } from '../order-notifications'
import { applyOrderInventoryDecrements } from './native-inventory'
import { refundNativeOrder } from './native-refund'
import { dispatchExpediteForOrder, nativeDispatchEnabled } from '../expedite'
import { alertOps } from '../ops-alert'
import { waitUntil } from '@vercel/functions'

const round2 = (n: number) => Math.round(n * 100) / 100

// Inserts an audit/event row. order_reference is nullable — account-, payout-,
// subscription- and error-level events are not tied to a specific order.
export async function recordOrderEvent(
  orderReference: string | null,
  eventType: string,
  eventData: unknown,
  source: string | null,
): Promise<void> {
  await sql`
    INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
    VALUES (${orderReference}::uuid, ${eventType}, ${JSON.stringify(eventData)}::jsonb, ${source})
  `
}

// `source` tags the audit trail with who's calling this — 'STRIPE_WEBHOOK' for
// the normal path, 'RESERVED_EXPIRY_SWEEP' when the sweep is reconciling an
// order the webhook missed (so the two are distinguishable later).
export async function handleNativePaymentIntentSucceeded(pi: Stripe.PaymentIntent, stripe: Stripe, source: string): Promise<void> {
  const customer = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id ?? null
  console.log(`[${source}] payment_intent.succeeded:`, pi.id, pi.amount, customer)

  const payments = (await sql`
    SELECT order_reference FROM disco_stripe_payments
    WHERE stripe_payment_intent_id = ${pi.id} LIMIT 1
  `) as { order_reference: string }[]

  if (payments.length === 0) {
    console.log(`[${source}] payment_intent.succeeded — not a Disco order, skipping:`, pi.id)
    return
  }

  const orderReference = payments[0].order_reference

  await sql`
    UPDATE disco_stripe_payments
    SET status = 'SUCCEEDED', updated_at = NOW()
    WHERE stripe_payment_intent_id = ${pi.id}
  `

  const orders = (await sql`
    SELECT id, reference FROM disco_orders WHERE reference = ${orderReference}::uuid LIMIT 1
  `) as { id: number; reference: string }[]

  if (orders.length === 0) {
    // Payment row exists but order is missing — still log against the ref.
    console.warn(`[${source}] payment_intent.succeeded — payment found but order missing:`, orderReference)
    await recordOrderEvent(orderReference, 'PAYMENT_SUCCEEDED', { paymentIntentId: pi.id, amount: pi.amount }, source)
    return
  }

  const order = orders[0]

  // Max Inventory Per Day — the REAL enforcement point. Atomically decrement
  // every capped item in this order now that money has actually moved.
  // Uncapped items no-op inside applyOrderInventoryDecrements. If any item's
  // cap was exhausted by a concurrent order in the split-second before this
  // ran, refund immediately rather than leave the customer charged with an
  // unfulfillable order.
  const orderDateRows = (await sql`
    SELECT order_date::text AS order_date FROM disco_orders WHERE id = ${order.id} LIMIT 1
  `) as { order_date: string }[]
  const orderDate = orderDateRows[0]?.order_date
  const orderItemRows = orderDate ? (await sql`
    SELECT oi.meal_package_reference AS item_ref, oi.quantity, mi.name
    FROM disco_order_items oi
    JOIN disco_menu_items mi ON mi.reference = oi.meal_package_reference
    WHERE oi.order_id = ${order.id} AND oi.meal_package_reference IS NOT NULL
  `.catch(() => [])) as { item_ref: string; quantity: number; name: string }[] : []

  let inventoryFailedItem: string | null = null
  if (orderDate && orderItemRows.length > 0) {
    const result = await applyOrderInventoryDecrements(
      orderItemRows.map(oi => ({ itemRef: oi.item_ref, itemName: oi.name, quantity: oi.quantity })),
      orderDate,
    )
    if (!result.ok) inventoryFailedItem = result.failedItem.name
  }

  if (inventoryFailedItem) {
    const refundAmount = round2((pi.amount || 0) / 100)
    try {
      // refundNativeOrder (not a plain stripe.refunds.create) so the
      // restaurant's connected-account transfer share is correctly reversed
      // too — same helper every other native refund path uses.
      await refundNativeOrder(stripe, order.reference, refundAmount)
      await sql`UPDATE disco_orders SET order_status = 'REFUNDED', refund = ${refundAmount}, updated_at = NOW() WHERE id = ${order.id}`
      await recordOrderEvent(order.reference, 'INVENTORY_EXHAUSTED_REFUND', { itemName: inventoryFailedItem, refundAmount }, source)
      waitUntil(dispatchInventoryUnavailableNotification(order.id, inventoryFailedItem))
    } catch (refundErr) {
      console.error(`[${source}] inventory-exhausted refund FAILED:`, refundErr instanceof Error ? refundErr.message : refundErr)
      await alertOps(`URGENT: customer charged but "${inventoryFailedItem}" sold out (Max Inventory Per Day) and the automatic refund FAILED for order ${order.reference} (PI ${pi.id}) — manual refund needed.`)
    }
    return
  }

  await sql`
    UPDATE disco_orders SET order_status = 'DUE', updated_at = NOW() WHERE id = ${order.id}
  `

  const txns = (await sql`
    SELECT id FROM disco_sale_transactions
    WHERE order_id = ${order.id} AND transaction_type = 'ORIGINAL' LIMIT 1
  `) as { id: number }[]

  if (txns.length > 0) {
    await sql`
      UPDATE disco_sale_transactions
      SET transaction_status = 'PAID',
          stripe_payment_intent_id = ${pi.id},
          paid_at = NOW(),
          updated_at = NOW()
      WHERE id = ${txns[0].id}
    `
  }

  await recordOrderEvent(order.reference, 'PAYMENT_SUCCEEDED', { paymentIntentId: pi.id, amount: pi.amount, viaSource: source }, source)

  // Order confirmations (customer + restaurant email, SMS, Slack). waitUntil
  // keeps the send alive after the caller's response. Shared, idempotent
  // dispatch — the guard ensures it only ever fires once per order, so a
  // sweep-triggered call here is safe even if the webhook eventually also
  // fires for the same PaymentIntent.
  waitUntil(dispatchOrderConfirmations(order.id, source))

  // Native third-party-delivery orders complete here (not via the FM confirm-
  // payment path), so dispatch their courier here too. OFF by default (real
  // courier cost). Idempotent + strict THIRD_PARTY_DELIVERY guard inside.
  if (nativeDispatchEnabled()) waitUntil(dispatchExpediteForOrder(order.id))
}
