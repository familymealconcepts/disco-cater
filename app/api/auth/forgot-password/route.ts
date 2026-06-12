import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// POST /api/auth/forgot-password  { email }
// Proxies to FM's confirmed reset endpoint (POST /forgotPassword?email=...),
// then ALWAYS returns 200 { success: true } for a well-formed email — never
// revealing whether an account exists (anti-enumeration). FM emails the customer
// a temporary password; they finish at /reset-password. FM outcome is logged only.
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

  // Uniform success regardless of validity / FM outcome → no email enumeration.
  return NextResponse.json({ success: true })
}
