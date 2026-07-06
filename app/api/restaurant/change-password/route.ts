import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { verifyPassword, hashPassword } from '../../../../lib/disco-restaurant-auth'
import { sql } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  // Disco-native: verify + rotate the bcrypt hash in disco_restaurant_accounts.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const { oldPassword, newPassword } = await req.json().catch(() => ({}))
    if (!oldPassword || !newPassword) return NextResponse.json({ error: 'Missing passwords' }, { status: 400 })
    if (String(newPassword).length < 8) return NextResponse.json({ error: 'New password must be at least 8 characters.' }, { status: 400 })
    const rows = (await sql`SELECT password_hash FROM disco_restaurant_accounts WHERE email = ${ctx.email} LIMIT 1`) as { password_hash: string }[]
    if (!rows.length) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    if (!(await verifyPassword(String(oldPassword), rows[0].password_hash))) {
      return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 403 })
    }
    const hash = await hashPassword(String(newPassword))
    await sql`UPDATE disco_restaurant_accounts SET password_hash = ${hash} WHERE email = ${ctx.email}`
    return NextResponse.json({ ok: true })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const { oldPassword, newPassword } = await req.json()
    if (!oldPassword || !newPassword) {
      return NextResponse.json({ error: 'Missing passwords' }, { status: 400 })
    }
    const params = new URLSearchParams({ oldPassword, newPassword })
    const res = await fetch(`${FM}/api/changePassword?${params}`, {
      method: 'POST',
      headers: h,
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to change password', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to change password' }, { status: 500 })
  }
}
