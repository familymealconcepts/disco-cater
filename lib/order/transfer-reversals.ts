import type Stripe from 'stripe'
import { sql } from '../db'

// Stripe's transfer.reversed, recorded against the Disco order the transfer paid, so NM OS's ops watch can
// see that a payout was taken back and close its "payout not reversed" suggestion itself
// (noise-machine src/lib/opsWatch.ts; the failure is recorded in disco_money_failures, migration 009).
// Approved by Kevin, 2026-10-23 (orchestrator item #42).
//
// One disco_order_events row per delivered event, event_type 'TRANSFER_REVERSED'. No migration: that
// table has no CHECK on event_type, and NM OS already reads it.
//
// THE PLATFORM ACCOUNT IS SHARED WITH FAMILYMEAL, so this endpoint also receives FamilyMeal's own
// reversals. A transfer is recorded only when it resolves to a Disco order; anything else is skipped
// with no row.
//
// The row lists EVERY reversal on the transfer with its id, amount and time, not just "the latest":
// Stripe retries webhooks and a transfer can carry an earlier, unrelated reversal (a previous partial
// refund), so a reader counts distinct reversal ids created after the failure it cares about. No
// personal data: Stripe ids, amounts and times only.

export const TRANSFER_REVERSED_EVENT = 'TRANSFER_REVERSED'

export type TransferReversalItem = { id: string; amountCents: number; created: string }

export type TransferReversedPayload = {
  stripeEventId: string
  transferId: string
  transferGroup: string | null
  amountCents: number
  amountReversedCents: number
  fullyReversed: boolean
  currency: string
  reversals: TransferReversalItem[]
}

/** The stored payload: every reversal, de-duplicated by id, oldest first. Pure. */
export function transferReversedPayload(
  eventId: string,
  transfer: Pick<Stripe.Transfer, 'id' | 'amount' | 'amount_reversed' | 'reversed' | 'currency' | 'transfer_group'>,
  reversals: ReadonlyArray<Pick<Stripe.TransferReversal, 'id' | 'amount' | 'created'>>,
): TransferReversedPayload {
  const byId = new Map<string, TransferReversalItem>()
  for (const r of reversals) {
    if (r?.id && !byId.has(r.id)) byId.set(r.id, { id: r.id, amountCents: r.amount, created: new Date(r.created * 1000).toISOString() })
  }
  return {
    stripeEventId: eventId,
    transferId: transfer.id,
    transferGroup: transfer.transfer_group ?? null,
    amountCents: transfer.amount,
    amountReversedCents: transfer.amount_reversed ?? 0,
    fullyReversed: transfer.reversed === true,
    currency: transfer.currency,
    reversals: [...byId.values()].sort((a, b) => a.created.localeCompare(b.created)),
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A transfer_group is only worth looking up when it can be an order reference. Pure. */
export function orderReferenceCandidate(transferGroup: string | null | undefined): string | null {
  const g = (transferGroup ?? '').trim()
  return UUID.test(g) ? g.toLowerCase() : null
}

/**
 * The Disco order a transfer paid, or null when it is not Disco's. In order: a recorded payout failure
 * for the transfer, the payment row that recorded it, then the transfer_group (Disco's manual invoice
 * transfers set it to the order reference), only if that order exists.
 */
export async function resolveTransferOrder(transferId: string, transferGroup: string | null): Promise<string | null> {
  const failure = (await sql`
    SELECT order_reference FROM disco_money_failures
     WHERE stripe_transfer_id = ${transferId} ORDER BY occurred_at DESC LIMIT 1
  `) as { order_reference: string }[]
  if (failure.length) return failure[0].order_reference
  const payment = (await sql`
    SELECT order_reference::text AS order_reference FROM disco_stripe_payments
     WHERE stripe_transfer_id = ${transferId} LIMIT 1
  `) as { order_reference: string }[]
  if (payment.length) return payment[0].order_reference
  const candidate = orderReferenceCandidate(transferGroup)
  if (!candidate) return null
  const order = (await sql`SELECT reference::text AS reference FROM disco_orders WHERE reference = ${candidate}::uuid LIMIT 1`) as { reference: string }[]
  return order.length ? order[0].reference : null
}

/** Every reversal on the transfer: the embedded list, and the rest from Stripe when it was cut short. */
async function allReversals(stripe: Stripe, transfer: Stripe.Transfer): Promise<Stripe.TransferReversal[]> {
  const embedded = transfer.reversals?.data ?? []
  if (!transfer.reversals?.has_more) return embedded
  const out: Stripe.TransferReversal[] = []
  for await (const r of stripe.transfers.listReversals(transfer.id, { limit: 100 })) out.push(r)
  return out
}

/** The webhook's transfer.reversed case. Records one row for a Disco transfer; skips anything else. */
export async function recordTransferReversed(stripe: Stripe, event: Stripe.Event): Promise<void> {
  const transfer = event.data.object as Stripe.Transfer
  const orderReference = await resolveTransferOrder(transfer.id, transfer.transfer_group ?? null)
  if (!orderReference) {
    console.log('[Webhook] transfer.reversed — not a Disco transfer, skipping:', transfer.id)
    return
  }
  const payload = transferReversedPayload(event.id, transfer, await allReversals(stripe, transfer))
  // A redelivered event writes nothing. Best-effort (no unique index); readers de-duplicate by reversal
  // id anyway, so a duplicate row cannot double-count.
  await sql`
    INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
    SELECT ${orderReference}::uuid, ${TRANSFER_REVERSED_EVENT}, ${JSON.stringify(payload)}::jsonb, 'STRIPE_WEBHOOK'
     WHERE NOT EXISTS (SELECT 1 FROM disco_order_events
                        WHERE event_type = ${TRANSFER_REVERSED_EVENT} AND event_data->>'stripeEventId' = ${event.id})
  `
  console.log('[Webhook] transfer.reversed recorded:', transfer.id, orderReference, payload.amountReversedCents)
}
