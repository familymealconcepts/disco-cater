import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { sql } from '../../../../../../lib/db'
import { hashPassword } from '../../../../../../lib/disco-restaurant-auth'
import { isDiscoNativeRestaurant } from '../../../../../../lib/order/native-checkout'
import { sendCustomerPasswordReset } from '../../../../../../lib/email/notifications'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// PUT /api/admin/restaurants/{ref}/reset-password
export async function PUT(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params

  // Disco-native: the login lives in Neon (disco_restaurant_accounts), not FM, so
  // the FM proxy 404s and the UI shows nothing (S5). Reset it the way the Disco
  // forgot-password flow does: set a fresh temporary password and email it.
  if (await isDiscoNativeRestaurant(ref)) {
    const rows = (await sql`
      SELECT email, first_name FROM disco_restaurant_accounts
      WHERE restaurant_reference = ${ref} AND email IS NOT NULL
      ORDER BY created_at ASC LIMIT 1
    `) as { email: string; first_name: string | null }[]
    const acct = rows[0]
    if (!acct?.email) return NextResponse.json({ error: 'No login account found for this restaurant.' }, { status: 404 })

    const tempPassword = randomBytes(9).toString('base64url') // ~12 chars, single-use
    try {
      const hash = await hashPassword(tempPassword)
      await sql`UPDATE disco_restaurant_accounts SET password_hash = ${hash}, updated_at = NOW() WHERE email = ${acct.email}`
    } catch (e) {
      console.error('[reset-password] native hash/store failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to reset password' }, { status: 500 })
    }
    const sent = await sendCustomerPasswordReset({
      to: acct.email,
      firstName: acct.first_name ?? undefined,
      password: tempPassword,
      redirectUrl: 'https://www.discocater.com/restaurant/login',
    })
    // The password IS reset even if the email fails — report that honestly so the
    // admin knows rather than believing nothing happened.
    return NextResponse.json({ ok: true, native: true, emailed: sent.success })
  }

  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}/resetPassword`, { method: 'PUT', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to reset password' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to reset password' }, { status: 500 })
  }
}
