import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../../../lib/db'
import { getPayoutSchedule, updatePayoutSchedule, type PayoutInterval } from '../../../../../../lib/stripe-connect'
import { logSettingsChange } from '../../../../../../lib/settings-audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// M9 — super-admin view/change of a Disco-native restaurant's Stripe automatic
// payout schedule (previously only settable in Stripe's own dashboard).
// DISCO-NATIVE ONLY: gated on disco_restaurant_cache.is_disco_native = true, so
// an FM-backed restaurant's payouts (FM-managed) are never touched.
//   GET  → { applicable, reason?, schedule?, chargesEnabled? }
//   POST → { interval, weeklyAnchor?, monthlyAnchor?, delayDays? } → updated schedule

// Resolve the native connected account for this reference, gated on is_disco_native.
async function resolveNativeAccount(ref: string): Promise<
  | { ok: true; accountId: string }
  | { ok: false; reason: string }
> {
  await runMigrations()
  const cache = (await sql`
    SELECT is_disco_native FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
  `) as { is_disco_native: boolean | null }[]
  if (!cache.length) return { ok: false, reason: 'Restaurant not found.' }
  if (cache[0].is_disco_native !== true) {
    return { ok: false, reason: 'Payout schedule is editable only for Disco-native restaurants (FM-backed payouts are managed by FamilyMeal).' }
  }
  // A native account may be keyed by its own reference OR bridged via fm_restaurant_reference.
  const acct = (await sql`
    SELECT stripe_account_id FROM disco_restaurant_accounts
    WHERE (restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref})
      AND stripe_account_id IS NOT NULL
    ORDER BY stripe_onboarding_complete DESC NULLS LAST, id ASC
    LIMIT 1
  `) as { stripe_account_id: string | null }[]
  const accountId = acct[0]?.stripe_account_id
  if (!accountId) return { ok: false, reason: 'No Stripe account connected yet — finish Stripe onboarding first.' }
  return { ok: true, accountId }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    const resolved = await resolveNativeAccount(ref)
    if (!resolved.ok) return NextResponse.json({ applicable: false, reason: resolved.reason })
    const { schedule, chargesEnabled } = await getPayoutSchedule(resolved.accountId)
    return NextResponse.json({ applicable: true, schedule, chargesEnabled })
  } catch (e) {
    console.error('[payout-schedule] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load payout schedule' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params

  let body: { interval?: unknown; weeklyAnchor?: unknown; monthlyAnchor?: unknown; delayDays?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const interval = String(body?.interval || '').toLowerCase()
  if (!['manual', 'daily', 'weekly', 'monthly'].includes(interval)) {
    return NextResponse.json({ error: 'interval must be manual, daily, weekly, or monthly' }, { status: 400 })
  }

  try {
    const resolved = await resolveNativeAccount(ref)
    if (!resolved.ok) return NextResponse.json({ error: resolved.reason }, { status: 400 })

    // `before` has to come from Stripe — the schedule is Stripe state, never
    // stored in Neon, so there is no row to snapshot. One extra read, and without
    // it the audit row could only say what the schedule became, not what it was.
    // Never fatal: a failed read degrades to before: null, it does not block the
    // change the admin asked for.
    let before: unknown = null
    try {
      before = (await getPayoutSchedule(resolved.accountId)).schedule
    } catch (e) {
      console.error('[payout-schedule] pre-change read failed (audit before will be null):', e instanceof Error ? e.message : e)
    }

    const schedule = await updatePayoutSchedule(resolved.accountId, {
      interval: interval as PayoutInterval,
      weeklyAnchor: body?.weeklyAnchor != null ? String(body.weeklyAnchor) : undefined,
      monthlyAnchor: body?.monthlyAnchor != null ? Number(body.monthlyAnchor) : undefined,
      delayDays: body?.delayDays != null ? Number(body.delayDays) : undefined,
    })

    // Logged after the fact here, unlike the Neon-backed routes: Stripe is the
    // system of record and only its response tells us what actually took effect
    // (it normalises anchors and can reject a combination outright).
    try {
      await logSettingsChange({
        action: 'payout_schedule_update',
        restaurantReference: ref,
        actorEmail: await getAdminEmail(),
        authType: 'admin',
        before,
        after: schedule,
        extra: { stripeAccountId: resolved.accountId, requestedInterval: interval },
      })
    } catch (e) {
      console.error('[payout-schedule] audit row failed:', e instanceof Error ? e.message : e)
    }

    return NextResponse.json({ applicable: true, schedule })
  } catch (e) {
    // Surface Stripe's rejection so the admin sees the real cause.
    const msg = e instanceof Error ? e.message : 'Unable to update payout schedule'
    console.error('[payout-schedule] POST failed:', msg)
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 })
  }
}
