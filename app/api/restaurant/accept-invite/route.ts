import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { runDiscoOrderMigrations, sql } from '../../../../lib/db'
import {
  getAccountByInviteToken,
  acceptInvite,
  createDiscoRestaurantSession,
  DISCO_RESTAURANT_COOKIE,
  DISCO_RESTAURANT_COOKIE_OPTS,
} from '../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Resolve the display name for an account's home restaurant (cache → account →
// business name fallback).
async function resolveRestaurantName(restaurantReference: string, accountName: string | null, businessName: string | null): Promise<string> {
  try {
    const rows = (await sql`
      SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${restaurantReference} LIMIT 1
    `) as Array<{ name: string }>
    if (rows[0]?.name) return rows[0].name
  } catch { /* fall through */ }
  return accountName || businessName || 'Disco Cater'
}

// GET /api/restaurant/accept-invite?token=...
// Validates an invite token without consuming it (so the page can render a form).
export async function GET(req: NextRequest) {
  const token = (req.nextUrl.searchParams.get('token') || '').trim()
  if (!token) return NextResponse.json({ valid: false })
  try {
    await runDiscoOrderMigrations()
    const account = await getAccountByInviteToken(token)
    if (!account) return NextResponse.json({ valid: false })
    const restaurantName = await resolveRestaurantName(account.restaurant_reference, account.restaurant_name, account.business_name)
    return NextResponse.json({
      valid: true,
      email: account.email,
      firstName: account.first_name || '',
      restaurantName,
    })
  } catch (err) {
    console.error('[accept-invite] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ valid: false })
  }
}

// POST /api/restaurant/accept-invite  { token, password }
// Sets the password, clears the one-time token, and logs the sub admin in.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const token = String(body?.token || '').trim()
    const password = String(body?.password || '')
    if (!token) return NextResponse.json({ error: 'Invalid invite link' }, { status: 400 })
    if (password.length < 8) return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })

    await runDiscoOrderMigrations()
    const account = await getAccountByInviteToken(token)
    if (!account) {
      return NextResponse.json({ error: 'This invite link has expired or is invalid.' }, { status: 400 })
    }

    // Hash with bcrypt (10 rounds), store it, and clear the one-time token.
    const passwordHash = await bcrypt.hash(password, 10)
    await acceptInvite(account.email, passwordHash)

    // Log them in — same Disco restaurant session + cookie as a normal login.
    const sessionToken = await createDiscoRestaurantSession(account.restaurant_reference, account.email)
    const res = NextResponse.json({
      success: true,
      email: account.email,
      firstName: account.first_name ?? null,
      lastName: account.last_name ?? null,
      restaurantReference: account.restaurant_reference,
      restaurantName: account.restaurant_name ?? null,
      role: account.role ?? 'SYSTEM_ADMIN',
      businessName: account.business_name ?? null,
    })
    res.cookies.set(DISCO_RESTAURANT_COOKIE, sessionToken, DISCO_RESTAURANT_COOKIE_OPTS)
    return res
  } catch (err) {
    console.error('[accept-invite] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to set password' }, { status: 500 })
  }
}
