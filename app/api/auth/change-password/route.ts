import { NextRequest, NextResponse } from 'next/server'
import { runDiscoOrderMigrations } from '../../../../lib/db'
import {
  FM_MIGRATED,
  getCustomerSession,
  getDiscoCustomer,
  hashCustomerPassword,
  setCustomerPassword,
  verifyCustomerPassword,
  fmLogin,
} from '../../../../lib/customer-auth'

export const runtime = 'nodejs'

// Customer password change, from the account Security page.
//
// ── WHY THIS WAS ANSWERING "Not authenticated" TO SIGNED-IN DINERS ───────────
// It used to read getToken(req) — the legacy `disco_token` cookie holding an FM
// diner JWT — and proxy FM's POST /api/changePassword. Neither half is how a
// diner is authenticated any more.
//
// A logged-in customer carries `disco_customer_token`, an opaque Neon session
// (lib/customer-auth.ts). `disco_token` is set at login ONLY when
// fmLogin(email, password) also succeeds — that is, only when the customer's FM
// password still equals their Disco one. It no longer does for a growing share
// of them: /api/auth/customer-set-password writes Disco's hash and deliberately
// never touches FM, so every customer who has used forgot-password has diverged,
// and 41 of 232 customers have no FM account at all since signup stopped calling
// fmRegister. All of them lost the cookie, so the route 401'd before reading
// anything — including accounts that DO have an FM reference, which is why this
// reproduced on a long-standing test account.
//
// Proxying FM was also wrong on its own terms: FM would have verified
// `oldPassword` against FM's copy, which is exactly the value that has drifted.
//
// ── WHERE THE PASSWORD CHANGES NOW ──────────────────────────────────────────
// Disco, and only Disco. `disco_customers.password_hash` is what login verifies
// (verifyCustomerPassword); FM's copy signs nothing in Disco. This matches
// /api/auth/customer-set-password, which already owns the reset half of the same
// credential. Customer ACCOUNTS remain shared across both platforms — what is
// not shared is the password, and that was already true before this change.
export async function PUT(req: NextRequest) {
  try {
    await runDiscoOrderMigrations()

    const session = await getCustomerSession(req)
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { currentPassword, newPassword } = await req.json()
    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Current and new password are required.' }, { status: 400 })
    }
    if (String(newPassword).length < 8) {
      return NextResponse.json({ error: 'New password must be at least 8 characters.' }, { status: 400 })
    }

    const customer = await getDiscoCustomer(session.email)
    if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    // Same two-branch verification the login route uses, so a customer still on
    // the FM_MIGRATED sentinel (no real hash yet) can change their password
    // rather than being told their correct password is wrong.
    let ok: boolean
    if (customer.password_hash === FM_MIGRATED) {
      ok = !!(await fmLogin(session.email, String(currentPassword)))
    } else {
      ok = await verifyCustomerPassword(String(currentPassword), customer.password_hash)
    }
    if (!ok) {
      return NextResponse.json({ error: 'Your current password is incorrect.' }, { status: 400 })
    }

    const hash = await hashCustomerPassword(String(newPassword))
    const updated = await setCustomerPassword(session.email, hash)
    if (!updated) {
      return NextResponse.json({ error: 'Unable to update password. Please try again.' }, { status: 500 })
    }

    // The session deliberately survives: the person changing the password is the
    // one holding it, and signing them out of the page they are standing on is a
    // worse experience than leaving them where they are.
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[change-password] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to update password. Please try again.' }, { status: 500 })
  }
}
