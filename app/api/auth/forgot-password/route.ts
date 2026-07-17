import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../lib/db'
import { setResetToken } from '../../../../lib/disco-restaurant-auth'
import { sendPasswordReset } from '../../../../lib/email/notifications'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const SITE_URL = 'https://www.discocater.com'

// Resolve a Disco-native restaurant account for this email, or null. Native accounts
// live in disco_restaurant_accounts (is_disco_native=true) and log in against their
// own password_hash — they have no FM record, so FM's reset can't help them. A
// non-native email (customer, or FM-backed restaurant) returns null → FM path.
async function findNativeAccount(email: string): Promise<{ email: string; first_name: string | null; restaurant_name: string | null } | null> {
  try {
    const rows = (await sql`
      SELECT email, first_name, restaurant_name
      FROM disco_restaurant_accounts
      WHERE lower(email) = lower(${email}) AND is_disco_native = true AND password_hash IS NOT NULL
      LIMIT 1
    `) as Array<{ email: string; first_name: string | null; restaurant_name: string | null }>
    return rows[0] ?? null
  } catch (err) {
    console.error('[forgot-password] native lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// POST /api/auth/forgot-password  { email }
// Two purely-additive paths, both ending in the SAME uniform 200 { success: true }
// (anti-enumeration — never reveal whether an account exists):
//   · Disco-native restaurant account → issue a one-time reset token, email a Disco
//     reset link (set new password at /restaurant/accept-invite). Zero FM.
//   · Everyone else (customer / FM-backed restaurant) → the existing FM proxy,
//     COMPLETELY UNCHANGED.
export async function POST(req: NextRequest) {
  let email = ''
  try {
    const body = await req.json()
    email = String(body?.email || '').trim()
  } catch {
    // Malformed body — respond uniformly (still no enumeration signal).
    return NextResponse.json({ success: true })
  }

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  if (valid) {
    // ── Disco-native branch (additive) ──────────────────────────────────────
    const native = await findNativeAccount(email)
    if (native) {
      try {
        const token = await setResetToken(native.email)
        await sendPasswordReset({
          to: native.email,
          firstName: native.first_name || undefined,
          restaurantName: native.restaurant_name || undefined,
          resetUrl: `${SITE_URL}/restaurant/accept-invite?token=${token}`,
        })
      } catch (err) {
        console.error('[forgot-password] native reset failed:', err instanceof Error ? err.message : err)
      }
      // Native handled — do NOT also hit FM (native accounts have no FM record).
      return NextResponse.json({ success: true })
    }

    // ── FM proxy (UNCHANGED — customers + FM-backed restaurants) ─────────────
    try {
      const res = await fetch(`${FM}/forgotPassword?email=${encodeURIComponent(email)}`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) {
        const masked = email.replace(/^(.).*(@.*)$/, '$1***$2')
        console.warn('[forgot-password] FM rejected reset request for', masked, res.status)
      }
    } catch (err) {
      console.error('[forgot-password] FM attempt errored:', err instanceof Error ? err.message : err)
    }
  }

  // Uniform success regardless of validity / native-vs-FM / outcome → no enumeration.
  return NextResponse.json({ success: true })
}
