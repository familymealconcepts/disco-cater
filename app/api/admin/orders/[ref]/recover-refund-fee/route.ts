import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../../lib/admin-auth'
import { sql } from '../../../../../../lib/db'
import { stripeClient } from '../../../../../../lib/order/native-payment'
import { recoverOutstandingRefundFees } from '../../../../../../lib/order/refund-stripe-fee'

export const runtime = 'nodejs'

// Super Admin's "Recover Stripe fee" (Peter, 29 Oct 2026). When a refund's Stripe
// fee could not be taken back from the restaurant at refund time — no payout or
// balance with room — Disco covered it and ops was alerted. This takes what is
// still owed from the restaurant's newest payouts with room, by transfer
// reversal, bounded by its Stripe balance, and records each reversal on the
// order (lib/order/refund-stripe-fee.ts). Moves the restaurant's money only.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  const rows = (await sql`
    SELECT reference::text AS reference FROM disco_orders WHERE reference::text = ${ref} OR fm_order_reference::text = ${ref} LIMIT 1
  `.catch(() => [])) as { reference: string }[]
  const orderRef = rows[0]?.reference
  if (!orderRef) return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
  const stripe = stripeClient(process.env.STRIPE_SECRET_KEY)
  if (!stripe) return NextResponse.json({ error: 'Payments are not configured.' }, { status: 500 })
  const actor = await getAdminEmail().catch(() => null)
  try {
    const r = await recoverOutstandingRefundFees(stripe, orderRef, actor)
    // Recorded on the order (REFUND_STRIPE_FEE_RECOVERY_ATTEMPT, with who ran it).
    const msg = r.recoveredCents > 0
      ? `Recovered $${(r.recoveredCents / 100).toFixed(2)} from the restaurant's payouts.${r.stillOwedCents > 0 ? ` $${(r.stillOwedCents / 100).toFixed(2)} is still owed — no payout or balance has room yet.` : ''}`
      : r.stillOwedCents > 0
        ? `Nothing recovered: the restaurant has no payout or balance with room for $${(r.stillOwedCents / 100).toFixed(2)} yet. Try again after its next payout.`
        : 'Nothing is owed on this order.'
    return NextResponse.json({ ok: true, recovered: r.recoveredCents / 100, stillOwed: r.stillOwedCents / 100, message: msg })
  } catch (e) {
    console.error('[admin/recover-refund-fee] failed:', orderRef, e instanceof Error ? e.message : e)
    return NextResponse.json({ error: `Recovery failed: ${e instanceof Error ? e.message : 'unknown error'}` }, { status: 500 })
  }
}
