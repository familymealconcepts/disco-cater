import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { sql, runStripeCapabilityMigrations } from '../../../../lib/db'
import { classifyStripeAccount, type StripeAccountStatus } from '../../../../lib/stripe-account-status'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Stripe status for a batch of restaurants, for the super-admin Ordering column.
//
// READS THE STORED SNAPSHOT BY DEFAULT — the same disco_restaurant_overrides
// columns the public /locations/{slug} page filters on, written hourly by
// cron/refresh-stripe-capabilities. That is the point: before this, the admin
// screen asked Stripe live while the page inferred from stripe_account_id being
// non-null, so the two could say different things about the same restaurant. One
// source means they cannot disagree, and the column costs one indexed query
// instead of one Stripe call per row.
//
// A LIVE READ IS KEPT, behind `live: true`, for the case where somebody is
// actively working a specific restaurant and needs the answer now rather than up
// to an hour old. It also WRITES the snapshot, so a manual recheck corrects both
// screens at once rather than leaving them briefly disagreeing.
//
// Uses STRIPE_READONLY_KEY deliberately: nothing here should be able to mutate a
// connected account even by accident.
const CONCURRENCY = 8

export async function POST(req: NextRequest) {
  // Same gate as the sibling admin routes — this exposes Stripe account state.
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const key = process.env.STRIPE_READONLY_KEY || process.env.STRIPE_SECRET_KEY
  if (!key) return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })

  const body = (await req.json().catch(() => ({}))) as { references?: unknown; live?: unknown }
  const refs = Array.isArray(body.references) ? body.references.map(String).slice(0, 500) : []
  const wantLive = body.live === true
  if (!refs.length) return NextResponse.json({ statuses: {} })

  await runStripeCapabilityMigrations()

  // Resolve BOTH ways — see the reference note below.
  const rows = (await sql`
    SELECT o.restaurant_reference, o.stripe_account_id,
           o.stripe_status, o.stripe_status_reason, o.stripe_charges_enabled, o.stripe_status_checked_at,
           COALESCE(acc.fm_restaurant_reference::text, o.restaurant_reference) AS page_reference
      FROM disco_restaurant_overrides o
      LEFT JOIN disco_restaurant_accounts acc ON acc.restaurant_reference = o.restaurant_reference
     WHERE (o.restaurant_reference = ANY(${refs}) OR acc.fm_restaurant_reference::text = ANY(${refs}))
       AND o.stripe_account_id IS NOT NULL
  `.catch(() => [])) as {
    restaurant_reference: string; stripe_account_id: string
    stripe_status: string | null; stripe_status_reason: string | null
    stripe_charges_enabled: boolean | null; stripe_status_checked_at: string | null
    page_reference: string
  }[]

  const statuses: Record<string, StripeAccountStatus & { checkedAt?: string | null }> = {}
  // Anything with no id at all is genuinely "no account" — a different problem
  // from a restricted one, and the whole reason this column needed a third state.
  for (const r of refs) statuses[r] = { state: 'no-account', reason: null, chargeCapable: false, accountId: null }

  const put = (row: { restaurant_reference: string; page_reference: string }, st: StripeAccountStatus & { checkedAt?: string | null }) => {
    // Keyed under BOTH references — the page may hold either. THE BUG THIS FIXES:
    // admin Ordering rows come from FM's list, so a Disco-native restaurant's row
    // carries its FM reference while its overrides row is keyed on its DISCO
    // reference. Those differ for 15 restaurants. Looking up only the row
    // reference found nothing, this route answered `no-account`, the column fell
    // through to its stored-flag fallback, and Lee's Chinese Food — genuinely
    // restricted, charges_enabled = false — rendered as "Connected".
    statuses[row.restaurant_reference] = st
    statuses[row.page_reference] = st
  }

  if (!wantLive) {
    for (const row of rows) {
      put(row, {
        state: (row.stripe_status as StripeAccountStatus['state']) ?? 'unknown',
        reason: row.stripe_status_reason,
        chargeCapable: row.stripe_charges_enabled === true,
        accountId: row.stripe_account_id,
        checkedAt: row.stripe_status_checked_at,
      })
    }
    return NextResponse.json({ statuses, source: 'snapshot' })
  }

  const stripe = new Stripe(key, { apiVersion: '2024-06-20' as never })
  let i = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    for (;;) {
      const idx = i++
      if (idx >= rows.length) return
      const row = rows[idx]
      try {
        const acct = await stripe.accounts.retrieve(row.stripe_account_id)
        const st = classifyStripeAccount(acct)
        put(row, st)
        // Write through, so a manual recheck fixes the public page too.
        await sql`
          UPDATE disco_restaurant_overrides
             SET stripe_charges_enabled = ${acct.charges_enabled === true},
                 stripe_payouts_enabled = ${acct.payouts_enabled === true},
                 stripe_status = ${st.state}, stripe_status_reason = ${st.reason},
                 stripe_status_checked_at = NOW()
           WHERE restaurant_reference = ${row.restaurant_reference}
        `.catch(() => {})
      } catch (e) {
        put(row, {
          state: 'unknown',
          reason: `Stripe could not be read for this account: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown error'}`,
          chargeCapable: false,
          accountId: row.stripe_account_id,
        })
      }
    }
  }))

  return NextResponse.json({ statuses, source: 'live' })
}
