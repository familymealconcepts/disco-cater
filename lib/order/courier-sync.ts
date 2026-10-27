// Every Disco → Expedite call that changes an EXISTING booking goes through here,
// so each one is recorded on the order and a failure reaches ops.
//
// Before this, only the order-cancel path (applyNativeStatusChange) and the Super
// Admin date/time change recorded or alerted. The portal edit, the transfer, the
// refund routes, the void route and the Stripe refund webhook logged to the
// console only, so "was the courier told?" could not be answered: #900000724's
// transfer and reschedule were both refused by Expedite ("address modifications
// are not allowed") with nothing on the order, and #900000431's full refund left
// no trace of whether its courier was stood down.
//
// Best-effort and never throws: a courier API that is down must not fail the
// change the customer and the kitchen depend on. Nothing here retries, cancels
// or rebooks on its own — a failure is recorded and a person is told.
import { sql } from '../db'
import { alertOps, alertOnce, resolveAlert } from '../ops-alert'
import { orderLink, shortError } from '../ops-alert-format'
import { orderFacts, orderLine } from '../ops-alert-facts'
import { syncExpediteOnEdit, type ExpediteSyncResult } from '../order-edit'

type OrderKey = { id: number; reference: string; order_number: string; expedite_delivery_id: string | null }

async function findOrder(ref: string): Promise<OrderKey | null> {
  const rows = (await sql`
    SELECT id, reference::text AS reference, order_number::text AS order_number, expedite_delivery_id
      FROM disco_orders WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid LIMIT 1
  `.catch(() => [])) as OrderKey[]
  return rows[0] ?? null
}

/** Human name for the change that triggered the update, for the alert. */
const TRIGGER_LABEL: Record<string, string> = {
  PORTAL_EDIT: 'edited in the restaurant portal',
  ADMIN_DATE_TIME: "date/time was changed in Super Admin",
  TRANSFER: 'transferred to another location',
}

/**
 * Push the order's current date/time/items/pickup address to its Expedite
 * booking (the portal edit's own syncExpediteOnEdit), record the outcome, and on
 * failure record EXPEDITE_UPDATE_FAILED on the order and alert ops with Expedite's
 * reply. Orders without a courier booking are untouched.
 */
export async function syncCourierAndReport(ref: string, trigger: keyof typeof TRIGGER_LABEL): Promise<ExpediteSyncResult> {
  try {
    const o = await findOrder(ref)
    if (!o) return { attempted: false, success: false }
    const r = await syncExpediteOnEdit(o.id, o.reference)
    if (!r.attempted) return r
    await sql`
      INSERT INTO disco_expedite_deliveries
        (order_reference, order_id, event, external_delivery_id, ok, response_body, parsed_status)
      VALUES (${o.reference}::uuid, ${o.id}, 'delivery_modified', ${o.expedite_delivery_id}, ${r.success},
              ${(r.success ? 'modified' : String(r.error ?? 'unknown error')).slice(0, 500)}, ${r.success ? 'success' : 'failed'})
    `.catch(e => console.error('[courier-sync] modify log failed (non-fatal):', e instanceof Error ? e.message : e))
    if (!r.success) {
      const reply = r.error || 'no reply'
      await sql`
        INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
        VALUES (${o.reference}::uuid, 'EXPEDITE_UPDATE_FAILED', ${JSON.stringify({ error: reply, trigger })}::jsonb, ${trigger})
      `.catch(e => console.error('[courier-sync] failure event (non-fatal):', e instanceof Error ? e.message : e))
      const f = await orderFacts(o.reference)
      await alertOps({
        severity: 'urgent',
        headline: `Courier booking not updated — order #${o.order_number}`,
        lines: [
          orderLine(f, { amount: null }) || '',
          `The order was ${TRIGGER_LABEL[trigger] ?? 'changed'}, but Expedite did not accept the update, so the courier is still booked as before.`,
          `Expedite replied: ${shortError(reply, 200)}`,
        ],
        action: 'update or rebook the courier at Expedite by hand.',
        link: orderLink(o.reference, o.order_number),
        context: { reference: o.reference, orderNumber: o.order_number, trigger, error: reply },
      }).catch(e => console.error('[courier-sync] ops alert (non-fatal):', e instanceof Error ? e.message : e))
    }
    return r
  } catch (e) {
    console.error('[courier-sync] update failed (non-fatal):', e instanceof Error ? e.message : e)
    return { attempted: true, success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Stand down the order's courier, record the outcome on the order, and — for a
 * delivery that hasn't happened yet — alert ops when Expedite refuses. Moved
 * here unchanged from applyNativeStatusChange (where only cancels got it) so
 * refunds, voids and the Stripe refund webhook get the same treatment.
 *
 * `why` finishes "Courier still booked on a ___ order".
 */
export async function cancelCourierAndReport(
  ref: string,
  source: string,
  why: 'cancelled' | 'refunded' | 'voided' = 'cancelled',
): Promise<{ attempted: boolean; success: boolean }> {
  const o = await findOrder(ref)
  const deliveryId = o?.expedite_delivery_id
  if (!o || !deliveryId || deliveryId === 'PENDING') return { attempted: false, success: false }

  let okFlag = false
  let detail = ''
  try {
    const { cancelDelivery } = await import('../expedite')
    const res = await cancelDelivery(deliveryId)
    okFlag = !!res.success
    detail = res.success ? 'cancelled' : String(res.error ?? 'unknown error')
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e)
  }
  console.log(`[courier-sync] expedite cancel (${source}) for ${o.reference}: ${okFlag ? 'ok' : 'FAILED — ' + detail}`)
  await sql`
    INSERT INTO disco_expedite_deliveries
      (order_reference, order_id, event, external_delivery_id, ok, response_body, parsed_status)
    VALUES (${o.reference}::uuid, ${o.id}, 'delivery_cancel', ${deliveryId}, ${okFlag},
            ${detail.slice(0, 500)}, ${okFlag ? 'success' : 'failed'})
  `.catch(e => console.error('[courier-sync] expedite cancel log failed (non-fatal):', e instanceof Error ? e.message : e))

  const key = `courier-cancel:${o.reference.toLowerCase()}`
  if (okFlag) {
    // Closes the thread a previous failed cancel opened, if there was one.
    await resolveAlert(key, 'Resolved: Expedite confirmed the cancellation.').catch(() => false)
    return { attempted: true, success: true }
  }
  // A courier can only still turn up for a delivery that hasn't happened.
  // Disco never receives Expedite's delivery status, so the delivery date
  // decides: past → Expedite's refusal is recorded on the order and nobody is
  // paged (23 Oct: three Apollo Bagels deliveries from 28 Sep–12 Oct paged ops
  // for "NOT stood down"); upcoming → the alert stands.
  const { fulfillmentFacts } = await import('./native-status-change')
  const facts = await fulfillmentFacts(o.reference)
  if (facts?.past) {
    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${o.reference}::uuid, 'EXPEDITE_CANCEL_AFTER_DELIVERY',
              ${JSON.stringify({ expediteDeliveryId: deliveryId, reply: detail.slice(0, 300), deliveryWas: facts.when })}::jsonb, ${source})
    `.catch(e => console.error('[courier-sync] expedite after-delivery note failed (non-fatal):', e instanceof Error ? e.message : e))
  } else {
    const f = await orderFacts(o.reference)
    const n = f?.orderNumber ?? facts?.orderNumber ?? o.order_number
    await alertOnce(key, {
      severity: 'urgent',
      headline: `Courier still booked on a ${why} order — #${n}`,
      lines: [
        orderLine(f, { amount: null }),
        `The order was ${why} but Expedite rejected the cancellation (${shortError(detail, 80).replace(/^expedite (\d{3})$/i, 'error $1')}), so a driver may still turn up and Disco may still be charged the fee.`,
      ],
      action: 'cancel the delivery with Expedite directly.',
      link: orderLink(o.reference, n),
      context: { orderReference: o.reference, expediteDeliveryId: deliveryId, error: detail.slice(0, 200), source },
    }).catch(() => false)
  }
  return { attempted: true, success: false }
}
