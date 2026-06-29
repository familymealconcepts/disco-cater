import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getRestaurantAuthContext, usesServiceAccount } from '../../../../lib/restaurant-auth-context'
import { sanitizePhone } from '../../../../lib/utils/phone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Personal account profile (first name / last name / email / phone) for the
// logged-in restaurant user — works for BOTH user types:
//   • Disco-native (disco session, no FM token) → disco_restaurant_accounts
//   • FM-native (FM token) → FM /api/profile (read) + /api/users (write)
// The returned shape is the same for both so the portal renders one card.

export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Disco-native: read the account row for this user (by email; fall back to the
  // restaurant_reference's first account).
  if (usesServiceAccount(ctx)) {
    try {
      await runMigrations()
      const rows = (await sql`
        SELECT first_name, last_name, email, phone
        FROM disco_restaurant_accounts
        WHERE email = ${ctx.email} OR restaurant_reference = ${ctx.restaurantReference}
        ORDER BY (email = ${ctx.email}) DESC, id ASC
        LIMIT 1
      `) as { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }[]
      const a = rows[0] || {}
      return NextResponse.json({
        firstName: a.first_name || ctx.firstName || '',
        lastName: a.last_name || ctx.lastName || '',
        email: a.email || ctx.email || '',
        phoneNumber: a.phone || '',
        isDisco: true,
      })
    } catch (err) {
      console.error('[restaurant/account-profile] disco GET failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Unable to fetch profile' }, { status: 500 })
    }
  }

  // FM-native: read FM /api/profile and map the fields.
  try {
    const res = await fetch(`${FM}/api/profile`, { headers: { Authorization: ctx.fmToken as string, Accept: 'application/json' } })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch profile' }, { status: res.status })
    const p = await res.json().catch(() => ({})) as Record<string, unknown>
    return NextResponse.json({
      firstName: String(p.firstName || ''),
      lastName: String(p.lastName || ''),
      email: String(p.email || ''),
      phoneNumber: String(p.phoneNumber || ''),
      isDisco: false,
    })
  } catch (err) {
    console.error('[restaurant/account-profile] FM GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to fetch profile' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const firstName = String(body?.firstName || '').trim()
  const lastName = String(body?.lastName || '').trim()
  const phoneNumber = sanitizePhone(String(body?.phoneNumber || ''))

  // Disco-native → write disco_restaurant_accounts (never touch email).
  if (usesServiceAccount(ctx)) {
    try {
      await runMigrations()
      await sql`
        UPDATE disco_restaurant_accounts SET
          first_name = ${firstName || null},
          last_name = ${lastName || null},
          phone = ${phoneNumber || null},
          updated_at = NOW()
        WHERE email = ${ctx.email}
      `
      return NextResponse.json({ success: true })
    } catch (err) {
      console.error('[restaurant/account-profile] disco PUT failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Unable to update profile' }, { status: 500 })
    }
  }

  // FM-native → PUT FM /api/users (digits-only phone — FM rejects formatted).
  try {
    const res = await fetch(`${FM}/api/users`, {
      method: 'PUT',
      headers: { Authorization: ctx.fmToken as string, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName, lastName, phoneNumber }),
    })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to update profile', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { success: true })
  } catch (err) {
    console.error('[restaurant/account-profile] FM PUT failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to update profile' }, { status: 500 })
  }
}
