import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// FM has no documented customer self-service reset endpoint in this codebase
// (the existing reset routes are all AUTHED admin/restaurant ones). So we try the
// most likely public shapes in order and stop at the first 2xx. Pin the correct
// one here once confirmed with Revyrie.
async function requestFmReset(email: string): Promise<boolean> {
  const e = encodeURIComponent(email)
  const attempts: { url: string; body?: string }[] = [
    { url: `${FM}/api/users/resetPassword?email=${e}` },
    { url: `${FM}/api/resetPassword?email=${e}` },
    { url: `${FM}/resetPassword`, body: JSON.stringify({ email }) },
    { url: `${FM}/api/forgotPassword?email=${e}` },
  ]
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, {
        method: 'POST',
        headers: { Accept: 'application/json', ...(a.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(a.body ? { body: a.body } : {}),
      })
      if (res.ok) {
        console.log('[forgot-password] FM reset accepted via', a.url.replace(/email=[^&]*/, 'email=***'))
        return true
      }
    } catch (err) {
      console.error('[forgot-password] FM attempt errored:', err)
    }
  }
  return false
}

// POST /api/auth/forgot-password  { email }
// ALWAYS returns 200 { success: true } for a well-formed email — never revealing
// whether an account exists (anti-enumeration). The FM result is logged only.
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
    const ok = await requestFmReset(email)
    if (!ok) {
      // No FM endpoint accepted it — log for ops, but stay uniform to the client.
      const masked = email.replace(/^(.).*(@.*)$/, '$1***$2')
      console.warn('[forgot-password] no FM reset endpoint accepted the request for', masked)
    }
  }

  // Uniform success regardless of validity / FM outcome → no email enumeration.
  return NextResponse.json({ success: true })
}
