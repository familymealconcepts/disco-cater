import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { sendEmail } from '../../../../lib/email/send'
import { layout, button } from '../../../../lib/email/layout'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/become-a-partner/go-live  { restaurantReference }
// Completion step. Verifies the full checklist from Neon, flips the restaurant
// live on the marketplace, and sends a welcome email. (The single new-partner
// Slack notification fires from /complete — see that route — so we don't
// duplicate it here.)
export async function POST(req: NextRequest) {
  let ref = ''
  try { const body = await req.json(); ref = String(body?.restaurantReference || '').trim() } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  if (!ref) return NextResponse.json({ error: 'Restaurant reference required.' }, { status: 400 })

  try {
    await runMigrations()

    const acctRows = (await sql`
      SELECT email, first_name, business_name, restaurant_name, stripe_onboarding_complete
      FROM disco_restaurant_accounts WHERE restaurant_reference = ${ref} ORDER BY id ASC LIMIT 1
    `) as { email: string | null; first_name: string | null; business_name: string | null; restaurant_name: string | null; stripe_onboarding_complete: boolean | null }[]
    const acct = acctRows[0]

    const cacheRows = (await sql`
      SELECT name, location, lat, lng FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
    `) as { name: string | null; location: string | null; lat: string | null; lng: string | null }[]
    const cache = cacheRows[0]

    // Gate: account + profile + Stripe must be complete. Menu is OPTIONAL —
    // restaurants can add menu items after going live.
    const missing: string[] = []
    if (!acct) missing.push('account')
    if (!cache || cache.lat == null || cache.lng == null) missing.push('profile')
    if (!acct?.stripe_onboarding_complete) missing.push('stripe')
    if (missing.length) {
      return NextResponse.json({ error: 'Onboarding incomplete', missing }, { status: 400 })
    }

    // Flip live + advance the step.
    await sql`UPDATE disco_restaurant_cache SET is_live = true, is_disco_native = true, cached_at = NOW() WHERE restaurant_reference = ${ref}`
    await sql`UPDATE disco_restaurant_accounts SET onboarding_step = 4, updated_at = NOW() WHERE restaurant_reference = ${ref}`

    const name = cache?.name || acct?.business_name || acct?.restaurant_name || 'New restaurant'

    // Welcome email (best-effort; sendEmail never throws).
    if (acct?.email) {
      const content = `
        <p style="font-size:18px;font-weight:700;margin:0 0 12px;">You're live on Disco Cater! 🪩</p>
        <p style="margin:0 0 12px;">Congratulations${acct.first_name ? `, ${acct.first_name}` : ''} — <strong>${name}</strong> is now live on the Disco Cater marketplace and ready to receive catering orders.</p>
        <p style="margin:0 0 12px;">Manage your orders, menu, and settings from your restaurant portal.</p>
        ${button('Go to your dashboard', 'https://www.discocater.com/restaurant/orders')}
      `
      await sendEmail({ to: acct.email, subject: `You're live on Disco Cater! 🪩`, html: layout(content) })
    }

    return NextResponse.json({ success: true, redirect: '/restaurant/orders' })
  } catch (err) {
    console.error('[partner/go-live] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not go live. Please try again.' }, { status: 500 })
  }
}
