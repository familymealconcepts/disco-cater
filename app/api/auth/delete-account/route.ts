import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'
import { verifiedFmClaims } from '../../../../lib/fm-token-verify'

// Account deletion — STUB. FM has no self-serve customer-delete endpoint yet, so
// for now we log the request (with the user's email) for a human to action,
// clear the diner session cookies, and report success. The client clears
// localStorage and redirects home.
export async function POST(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Please sign in again to continue.' }, { status: 401 })

  // VERIFIED (22 Oct 2026): this logs a deletion request for a human to act
  // on, so the email must come from a token FamilyMeal accepts — a decoded,
  // unverified cookie could have queued anyone's account for deletion.
  const claims = await verifiedFmClaims(token)
  if (!claims) return NextResponse.json({ error: 'Please sign in again to continue.' }, { status: 401 })
  const email = String(claims.email || claims.sub || 'unknown')
  // TODO: replace with a real FM deletion call / ticket once available.
  console.warn(`[account-deletion-request] user=${email} requested account deletion — action manually.`)

  const resp = NextResponse.json({ success: true })
  resp.cookies.delete('disco_token')
  resp.cookies.delete('disco_refresh')
  return resp
}
