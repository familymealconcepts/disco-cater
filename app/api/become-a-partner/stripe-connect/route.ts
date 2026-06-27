import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { sql, runMigrations } from '../../../../lib/db'
import { createConnectAccount, createAccountLink } from '../../../../lib/stripe-connect'
import { hashPassword } from '../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://www.discocater.com'

// POST /api/become-a-partner/stripe-connect
// Step 4 of onboarding (account is NOT created until this step). Body carries the
// basic account info collected client-side. Logic:
//   • account exists AND has stripe_account_id → { alreadyConnected: true }
//   • account exists, no stripe_account_id      → reuse it, start Connect
//   • account does not exist                     → create the disco_restaurant_accounts
//     row now (basic info, hashed password), then start Connect
// Returns a hosted Connect onboarding link (stripeConnectUrl) + restaurantReference.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = String(body?.email || '').trim().toLowerCase()
  const password = String(body?.password || '')
  const restaurantName = String(body?.restaurantName || '').trim()
  const firstName = String(body?.firstName || '').trim()
  const lastName = String(body?.lastName || '').trim()
  const phone = String(body?.phone || body?.phoneNumber || '').trim()
  const street = String(body?.street || '').trim()
  const city = String(body?.city || '').trim()
  const state = String(body?.state || '').trim()
  const zip = String(body?.zip || '').trim()
  const address = [street, city, state, zip].filter(Boolean).join(', ')

  if (!email) return NextResponse.json({ error: 'Email is required.' }, { status: 400 })
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[partner/stripe-connect] STRIPE_SECRET_KEY is missing from env.')
    return NextResponse.json({ error: 'Payments are not configured.' }, { status: 500 })
  }
  console.log('[partner/stripe-connect] start', {
    email,
    hasSecretKey: !!process.env.STRIPE_SECRET_KEY,
    secretKeyPrefix: (process.env.STRIPE_SECRET_KEY || '').slice(0, 7),
    hasConnectClientId: !!process.env.STRIPE_CONNECT_CLIENT_ID,
  })

  try {
    await runMigrations()

    const rows = (await sql`
      SELECT restaurant_reference, stripe_account_id, business_name, restaurant_name
      FROM disco_restaurant_accounts WHERE email = ${email} ORDER BY id ASC LIMIT 1
    `) as { restaurant_reference: string; stripe_account_id: string | null; business_name: string | null; restaurant_name: string | null }[]
    const acct = rows[0]
    let ref = acct?.restaurant_reference || ''
    let existingAccountId = acct?.stripe_account_id || ''

    if (acct) {
      // Already fully connected → let the client skip this step.
      if (existingAccountId) {
        return NextResponse.json({ alreadyConnected: true, restaurantReference: ref })
      }
    } else {
      // No account yet → create the basic record now. A hashed password is required
      // (the column is NOT NULL); the client still has it in memory at this step.
      if (!password || password.length < 8) {
        return NextResponse.json({ error: 'A password (8+ characters) is required to create your account.' }, { status: 400 })
      }
      ref = randomUUID()
      const passwordHash = await hashPassword(password)
      await sql`
        INSERT INTO disco_restaurant_accounts (
          email, password_hash, restaurant_reference, first_name, last_name, phone,
          restaurant_name, business_name, address, role, is_disco_native, onboarding_step
        ) VALUES (
          ${email}, ${passwordHash}, ${ref}, ${firstName || null}, ${lastName || null},
          ${phone || null}, ${restaurantName || null}, ${restaurantName || null},
          ${address || null}, 'ADMIN', true, 2
        )
        ON CONFLICT (email) DO NOTHING
      `
      // Re-read in case a concurrent attempt won the INSERT (ON CONFLICT DO NOTHING).
      const re = (await sql`
        SELECT restaurant_reference, stripe_account_id FROM disco_restaurant_accounts WHERE email = ${email} LIMIT 1
      `) as { restaurant_reference: string; stripe_account_id: string | null }[]
      if (re[0]) {
        ref = re[0].restaurant_reference
        existingAccountId = re[0].stripe_account_id || ''
        if (existingAccountId) return NextResponse.json({ alreadyConnected: true, restaurantReference: ref })
      }
    }

    // Create the Express connected account and persist its id.
    const accountId = await createConnectAccount(
      email,
      restaurantName || acct?.business_name || acct?.restaurant_name || '',
    )
    await sql`
      UPDATE disco_restaurant_accounts
      SET stripe_account_id = ${accountId},
          onboarding_step = GREATEST(COALESCE(onboarding_step, 0), 2),
          updated_at = NOW()
      WHERE restaurant_reference = ${ref}
    `

    const returnUrl = `${BASE_URL}/become-a-partner?stripe=success&ref=${encodeURIComponent(ref)}`
    const refreshUrl = `${BASE_URL}/become-a-partner?stripe=refresh&ref=${encodeURIComponent(ref)}`
    const url = await createAccountLink(accountId, refreshUrl, returnUrl)

    // Keep the legacy `stripeConnectUrl` key so the client keeps working.
    return NextResponse.json({ stripeConnectUrl: url, url, restaurantReference: ref, accountId })
  } catch (err) {
    const e = err as { type?: string; code?: string; statusCode?: number; message?: string; raw?: { message?: string } }
    console.error('[partner/stripe-connect] failed:', {
      email,
      type: e?.type,
      code: e?.code,
      statusCode: e?.statusCode,
      message: e?.message || e?.raw?.message || String(err),
      hasSecretKey: !!process.env.STRIPE_SECRET_KEY,
      hasConnectClientId: !!process.env.STRIPE_CONNECT_CLIENT_ID,
    })
    return NextResponse.json(
      { error: 'Could not initiate Stripe Connect. You can connect later from your dashboard.' },
      { status: 500 },
    )
  }
}
