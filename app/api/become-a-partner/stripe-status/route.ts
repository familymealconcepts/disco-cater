import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { isChargesEnabled } from '../../../../lib/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/become-a-partner/stripe-status?restaurantReference=...
// Called when the partner returns from Stripe onboarding. Retrieves the Connect
// account; if charges_enabled, marks stripe_onboarding_complete=true and bumps
// onboarding_step to 2. Returns { connected, complete }.
export async function GET(req: NextRequest) {
  const ref = (req.nextUrl.searchParams.get('restaurantReference') || '').trim()
  if (!ref) return NextResponse.json({ connected: false, complete: false })

  try {
    await runMigrations()
    const rows = (await sql`
      SELECT stripe_account_id, stripe_onboarding_complete
      FROM disco_restaurant_accounts WHERE restaurant_reference = ${ref}
      ORDER BY id ASC LIMIT 1
    `) as { stripe_account_id: string | null; stripe_onboarding_complete: boolean | null }[]
    const acct = rows[0]
    if (!acct?.stripe_account_id) return NextResponse.json({ connected: false, complete: false })

    // Already confirmed — no need to hit Stripe again.
    if (acct.stripe_onboarding_complete) return NextResponse.json({ connected: true, complete: true })

    const enabled = await isChargesEnabled(acct.stripe_account_id)
    if (enabled) {
      await sql`
        UPDATE disco_restaurant_accounts
        SET stripe_onboarding_complete = true,
            onboarding_step = GREATEST(COALESCE(onboarding_step, 0), 2),
            updated_at = NOW()
        WHERE restaurant_reference = ${ref}
      `
    }
    return NextResponse.json({ connected: enabled, complete: enabled })
  } catch (err) {
    console.error('[partner/stripe-status] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ connected: false, complete: false })
  }
}
