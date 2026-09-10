import { NextRequest, NextResponse } from 'next/server'
import { getAdminRole, getAdminEmail } from '../../../../../lib/admin-auth'
import { resolveResetEligibility, sendPasswordResetTo } from '../../../../../lib/password-reset'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Super-admin "Send password reset" for the Users screen.
//
// Sends THE self-service reset email — same function, same token, same expiry,
// same template (lib/password-reset.ts). Nothing about the message differs
// because an admin triggered it, and it is addressed to the account's own
// address: the token never enters a response body or the admin UI.
//
// Unlike /api/auth/forgot-password, this route reports the REAL outcome. That
// endpoint answers 200 to everything on purpose (it is unauthenticated, so a
// distinguishable response would enumerate accounts). Here the caller is an
// authenticated super admin looking at the account already, so there is nothing
// to leak and a swallowed failure would just be a lie on screen.
//
// SUPER_ADMIN only. This changes nobody's permissions — it is a new action
// available to a role that already exists.
async function requireSuperAdmin(): Promise<{ ok: true; email: string | null } | { ok: false; res: NextResponse }> {
  const role = await getAdminRole()
  if (role !== 'SUPER_ADMIN') {
    return { ok: false, res: NextResponse.json({ error: 'Not authorized' }, { status: 403 }) }
  }
  return { ok: true, email: await getAdminEmail() }
}

// GET ?emails=a@x.com,b@y.com → { eligibility: { email: {eligible, reason?} } }
// Lets the table disable the control with a reason instead of offering an
// action that cannot work. Reveals nothing a super admin cannot already see.
export async function GET(req: NextRequest) {
  const gate = await requireSuperAdmin()
  if (!gate.ok) return gate.res

  const raw = (req.nextUrl.searchParams.get('emails') || '').split(',').map(s => s.trim()).filter(Boolean)
  const emails = [...new Set(raw)].slice(0, 100)
  const eligibility: Record<string, { eligible: boolean; reason?: string }> = {}
  for (const e of emails) {
    try {
      const r = await resolveResetEligibility(e)
      eligibility[e] = r.eligible ? { eligible: true } : { eligible: false, reason: r.reason }
    } catch (err) {
      console.error('[admin/users/reset-password] eligibility failed for one account:', err instanceof Error ? err.message : err)
      eligibility[e] = { eligible: false, reason: 'Could not check this account.' }
    }
  }
  return NextResponse.json({ eligibility })
}

// POST { email } → { ok: true } only when the mailer actually dispatched.
export async function POST(req: NextRequest) {
  const gate = await requireSuperAdmin()
  if (!gate.ok) return gate.res

  let email = ''
  try {
    const body = await req.json()
    email = String(body?.email || '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  if (!email) return NextResponse.json({ error: 'email is required.' }, { status: 400 })

  // No try/catch around the send. A thrown error becomes a 500 the UI shows;
  // wrapping it to return success is the exact failure mode this must not have.
  let elig
  try {
    elig = await resolveResetEligibility(email)
  } catch (err) {
    console.error('[admin/users/reset-password] eligibility lookup failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not look up this account.' }, { status: 500 })
  }
  if (!elig.eligible) return NextResponse.json({ error: elig.reason }, { status: 409 })

  let outcome
  try {
    outcome = await sendPasswordResetTo(elig.target, { source: 'super-admin', actorEmail: gate.email })
  } catch (err) {
    console.error('[admin/users/reset-password] send threw:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'The reset email could not be sent.' }, { status: 502 })
  }
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.message }, { status: outcome.code === 'rate-limited' ? 429 : 502 })
  }
  // The email is out, so this is a success — but say so honestly if the trail
  // row is missing, because that also means this send is not rate-limited.
  return NextResponse.json({
    ok: true,
    sentTo: elig.target.email,
    ...(outcome.audited ? {} : { warning: 'Sent, but the audit row could not be written.' }),
  })
}
