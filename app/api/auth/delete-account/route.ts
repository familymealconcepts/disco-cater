import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'

// Decode a JWT payload (no verification — just to surface the email for the
// manual-deletion log).
function decodeEmail(token: string): string {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload?.email || payload?.sub || 'unknown'
  } catch {
    return 'unknown'
  }
}

// Account deletion — STUB. FM has no self-serve customer-delete endpoint yet, so
// for now we log the request (with the user's email) for a human to action,
// clear the diner session cookies, and report success. The client clears
// localStorage and redirects home.
export async function POST(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const email = decodeEmail(token)
  // TODO: replace with a real FM deletion call / ticket once available.
  console.warn(`[account-deletion-request] user=${email} requested account deletion — action manually.`)

  const resp = NextResponse.json({ success: true })
  resp.cookies.delete('disco_token')
  resp.cookies.delete('disco_refresh')
  return resp
}
