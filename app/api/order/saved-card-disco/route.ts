import { NextRequest, NextResponse } from 'next/server'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'

// Reads the customer's default saved card from the Disco-native vault
// (disco_customer_payment_methods). Customer cookie required.
export async function GET(req: NextRequest) {
  try {
    // Identify the customer from the FM auth cookie.
    const userRes = await fetch(new URL('/api/fm-user', req.url), {
      headers: { cookie: req.headers.get('cookie') || '' },
    })
    if (userRes.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!userRes.ok) return NextResponse.json(null)
    const user = await userRes.json().catch(() => ({}))
    const email: string = user?.email || ''
    if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    await runDiscoOrderMigrations()
    const rows = await sql`
      SELECT card_brand, card_last4, card_exp_month, card_exp_year,
             stripe_customer_id, stripe_payment_method_id
      FROM disco_customer_payment_methods
      WHERE customer_email = ${email} AND is_default = true
      LIMIT 1
    `
    const r = rows[0]
    if (!r) return NextResponse.json(null)

    return NextResponse.json({
      brand: r.card_brand,
      last4: r.card_last4,
      expMonth: r.card_exp_month,
      expYear: r.card_exp_year,
      stripeCustomerId: r.stripe_customer_id,
      stripePaymentMethodId: r.stripe_payment_method_id,
    })
  } catch (err) {
    console.error('[saved-card-disco] error:', err instanceof Error ? err.message : err)
    return NextResponse.json(null)
  }
}
