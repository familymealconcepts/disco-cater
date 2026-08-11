import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAdminRole } from '../../../../../lib/admin-auth'
import { sql } from '../../../../../lib/db'
import { notifyStripeConnectedIfNewlyFullyConnected } from '../../../stripe/webhook/route'

export const runtime = 'nodejs'

const TEST_ACCOUNT_ID = 'acct_test_stripe_connected_verification'

// TEMPORARY — end-to-end test of notifyStripeConnectedIfNewlyFullyConnected
// using a fake, clearly-labeled test restaurant row (never a real Stripe
// account) so the real Almost Home data isn't touched again. Inserts the test
// row, calls the real notify function TWICE (first should Slack + set the
// guard, second should no-op), then reports both outcomes plus the guard
// column's final state. Delete this whole route after verification.
export async function POST() {
  const role = await getAdminRole()
  if (role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  await sql`
    INSERT INTO disco_restaurant_accounts (email, password_hash, restaurant_reference, restaurant_name, stripe_account_id, stripe_onboarding_complete, is_disco_native)
    VALUES ('test-stripe-connected-verification@discocater.com', 'x', gen_random_uuid()::text, 'TEST — Stripe Connected Verification (delete me)', ${TEST_ACCOUNT_ID}, true, true)
    ON CONFLICT (email) DO UPDATE SET stripe_connected_notified_at = NULL, stripe_account_id = ${TEST_ACCOUNT_ID}
  `

  const fakeAccount = { id: TEST_ACCOUNT_ID, charges_enabled: true, payouts_enabled: true, details_submitted: true } as Stripe.Account

  await notifyStripeConnectedIfNewlyFullyConnected(fakeAccount)
  const afterFirst = (await sql`SELECT stripe_connected_notified_at FROM disco_restaurant_accounts WHERE stripe_account_id = ${TEST_ACCOUNT_ID}`) as { stripe_connected_notified_at: string | null }[]

  await notifyStripeConnectedIfNewlyFullyConnected(fakeAccount)
  const afterSecond = (await sql`SELECT stripe_connected_notified_at FROM disco_restaurant_accounts WHERE stripe_account_id = ${TEST_ACCOUNT_ID}`) as { stripe_connected_notified_at: string | null }[]

  return NextResponse.json({
    firstCallSetGuardAt: afterFirst[0]?.stripe_connected_notified_at ?? null,
    secondCallGuardUnchanged: afterFirst[0]?.stripe_connected_notified_at === afterSecond[0]?.stripe_connected_notified_at,
    note: 'Check the stripe-connected Slack channel for exactly ONE message from this test — not two.',
  })
}

// TEMPORARY — makes a small, safe metadata update to Almost Home's REAL connected
// account to trigger a REAL account.updated event, so delivery through the newly
// created Connect-scoped endpoint can be confirmed end-to-end (not simulated).
export async function PATCH() {
  const role = await getAdminRole()
  if (role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const key = process.env.STRIPE_SECRET_KEY || ''
  const stripe = new Stripe(key, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])
  const almostHomeAcct = 'acct_1U2yeD3XIxT2pODU'

  const before = (await sql`SELECT MAX(id) AS max_id FROM disco_order_events`) as { max_id: number }[]

  const updated = await stripe.accounts.update(almostHomeAcct, {
    metadata: { source: 'disco-become-a-partner', webhook_test_ping: String(Date.now()) },
  })

  await new Promise(r => setTimeout(r, 6000))
  const after = (await sql`
    SELECT id, event_type, event_data, created_at FROM disco_order_events
    WHERE id > ${before[0].max_id} ORDER BY id
  `) as { id: number; event_type: string; event_data: unknown; created_at: string }[]

  return NextResponse.json({ ok: true, accountId: updated.id, baselineMaxId: before[0].max_id, newRowsLogged: after })
}

// Cleanup — removes the fake test row.
export async function DELETE() {
  const role = await getAdminRole()
  if (role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  await sql`DELETE FROM disco_restaurant_accounts WHERE stripe_account_id = ${TEST_ACCOUNT_ID}`
  return NextResponse.json({ ok: true })
}
