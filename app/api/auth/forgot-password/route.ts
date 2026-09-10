import { NextRequest, NextResponse } from 'next/server'
import { resolveResetEligibility, sendPasswordResetTo } from '../../../../lib/password-reset'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// The native branch's account lookup, token issue and email send now live in
// lib/password-reset.ts, shared with the super-admin Users screen's reset
// button. Behaviour here is unchanged — same predicate for "is this a Disco
// login", same 1-hour token, same email — it is just no longer the only copy.
// See that file for why is_disco_native is read off the CACHE, not off the
// account row.

// POST /api/auth/forgot-password  { email }
// Two purely-additive paths, both ending in the SAME uniform 200 { success: true }
// (anti-enumeration — never reveal whether an account exists):
//   · Any DISCO-OWNED login → one-time token + a Disco reset link. Restaurant
//     staff set their password at /restaurant/accept-invite, diners at
//     /reset-password?token=…. Zero FM.
//   · FM-owned logins only (FM-backed restaurant accounts, and diners still on
//     the FM_MIGRATED sentinel) → the FM proxy, unchanged.
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
    // ── Disco branch: native restaurant accounts AND diners ─────────────────
    // Errors stay swallowed HERE and only here: this endpoint is unauthenticated
    // and must not leak whether an account exists, so every path below returns
    // the same 200. The admin caller of the same function does the opposite and
    // surfaces the real outcome.
    let handledNatively = false
    try {
      const elig = await resolveResetEligibility(email)
      if (elig.eligible) {
        handledNatively = true
        const out = await sendPasswordResetTo(elig.target, { source: 'self-service', actorEmail: null })
        if (!out.ok) console.error('[forgot-password] native reset not sent:', out.code, out.message)
      }
    } catch (err) {
      console.error('[forgot-password] native reset failed:', err instanceof Error ? err.message : err)
    }
    // Handled by Disco — do NOT also hit FM.
    //
    // For diners this is the fix, not just an optimisation. Disco owns
    // disco_customers.password_hash and /api/fm-auth verifies against it, so
    // proxying to FM changed FM's password and left the real credential alone:
    // the diner was told the reset worked and still could not log in. All 107
    // diners have a real bcrypt hash here, so FM's reset helped none of them.
    if (handledNatively) return NextResponse.json({ success: true })

    // ── FM proxy — FM-BACKED LOGINS ONLY ────────────────────────────────────
    // Reached only when resolveResetEligibility found no Disco-owned credential:
    // an FM-backed restaurant account, or a diner still on the FM_MIGRATED
    // sentinel (no real hash yet, still verified against FM until their next
    // sign-in migrates them). Diners with a real hash never reach this.
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
