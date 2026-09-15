import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql } from '../../../../lib/db'
import { classifyStripeAccount, type StripeAccountStatus } from '../../../../lib/stripe-account-status'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// LIVE Stripe status for a batch of restaurants, for the super-admin Ordering
// column. Read live rather than from disco_restaurant_overrides.stripe_connected,
// because that boolean cannot express "restricted" and goes stale silently — an
// account Stripe restricted an hour ago still reads connected there.
//
// POSTed with the references currently on screen rather than fetched for the whole
// fleet: 190 accounts have an id attached, and retrieving all of them costs ~190
// sequential Stripe reads. The page asks for the rows it is actually showing.
//
// READ-ONLY, and uses STRIPE_READONLY_KEY deliberately: nothing here should be
// able to mutate a connected account even by accident.
const CONCURRENCY = 8

export async function POST(req: NextRequest) {
  // Same gate as the sibling admin routes — this exposes Stripe account state.
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const key = process.env.STRIPE_READONLY_KEY || process.env.STRIPE_SECRET_KEY
  if (!key) return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })

  const body = (await req.json().catch(() => ({}))) as { references?: unknown }
  const refs = Array.isArray(body.references) ? body.references.map(String).slice(0, 500) : []
  if (!refs.length) return NextResponse.json({ statuses: {} })

  const rows = (await sql`
    SELECT restaurant_reference, stripe_account_id
      FROM disco_restaurant_overrides
     WHERE restaurant_reference = ANY(${refs}) AND stripe_account_id IS NOT NULL
  `.catch(() => [])) as { restaurant_reference: string; stripe_account_id: string }[]

  const stripe = new Stripe(key, { apiVersion: '2024-06-20' as never })
  const statuses: Record<string, StripeAccountStatus> = {}

  // Anything with no id at all is genuinely "no account" — a different problem
  // from a restricted one, and the whole reason this column needed a third state.
  for (const r of refs) statuses[r] = { state: 'no-account', reason: null, chargeCapable: false, accountId: null }

  let i = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    for (;;) {
      const idx = i++
      if (idx >= rows.length) return
      const row = rows[idx]
      try {
        const acct = await stripe.accounts.retrieve(row.stripe_account_id)
        statuses[row.restaurant_reference] = classifyStripeAccount(acct)
      } catch (e) {
        // An id we hold that Stripe will not return is NOT "not connected" — it is
        // an open question, and saying "unknown" is the honest answer.
        statuses[row.restaurant_reference] = {
          state: 'unknown',
          reason: `Stripe could not be read for this account: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown error'}`,
          chargeCapable: false,
          accountId: row.stripe_account_id,
        }
      }
    }
  }))

  return NextResponse.json({ statuses })
}
