import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { createConnectAccount, createAccountLink } from '../../../../lib/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://www.discocater.com'

// POST /api/become-a-partner/stripe-connect  { restaurantReference }
// Native Stripe Connect (Express). Creates the connected account (reusing an
// existing one if already started), persists stripe_account_id, and returns a
// hosted onboarding link. On return, the client hits GET ../stripe-status to
// confirm charges_enabled. FM is not involved.
export async function POST(req: NextRequest) {
  let restaurantReference = ''
  try {
    const body = await req.json()
    restaurantReference = String(body?.restaurantReference || '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  if (!restaurantReference) {
    return NextResponse.json({ error: 'Restaurant not yet created' }, { status: 400 })
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'Payments are not configured.' }, { status: 500 })
  }

  try {
    await runMigrations()

    const rows = (await sql`
      SELECT email, business_name, restaurant_name, stripe_account_id
      FROM disco_restaurant_accounts WHERE restaurant_reference = ${restaurantReference}
      ORDER BY id ASC LIMIT 1
    `) as { email: string | null; business_name: string | null; restaurant_name: string | null; stripe_account_id: string | null }[]
    const acct = rows[0]

    // Reuse an existing connected account, else create one.
    let accountId = acct?.stripe_account_id || ''
    if (!accountId) {
      accountId = await createConnectAccount(
        acct?.email || '',
        acct?.business_name || acct?.restaurant_name || '',
      )
      await sql`
        UPDATE disco_restaurant_accounts
        SET stripe_account_id = ${accountId},
            onboarding_step = GREATEST(COALESCE(onboarding_step, 0), 2),
            updated_at = NOW()
        WHERE restaurant_reference = ${restaurantReference}
      `
    }

    const returnUrl = `${BASE_URL}/become-a-partner?stripe=success&ref=${encodeURIComponent(restaurantReference)}`
    const refreshUrl = `${BASE_URL}/become-a-partner?stripe=refresh&ref=${encodeURIComponent(restaurantReference)}`
    const url = await createAccountLink(accountId, refreshUrl, returnUrl)

    // Keep the legacy `stripeConnectUrl` key so the existing client keeps working.
    return NextResponse.json({ stripeConnectUrl: url, url, accountId })
  } catch (err) {
    console.error('[partner/stripe-connect] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'Could not initiate Stripe Connect. You can connect later from your dashboard.' },
      { status: 500 },
    )
  }
}
