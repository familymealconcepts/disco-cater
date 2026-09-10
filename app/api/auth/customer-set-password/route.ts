import { NextRequest, NextResponse } from 'next/server'
import { runDiscoOrderMigrations } from '../../../../lib/db'
import { hashCustomerPassword, setCustomerPasswordByResetToken } from '../../../../lib/customer-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/auth/customer-set-password  { token, newPassword }
//
// Completes a diner reset issued by lib/password-reset.ts. This is the Disco
// half that never existed: the older /api/auth/reset-password proxies FM's
// changeTemporaryPassword, which updates FM's password and leaves
// disco_customers.password_hash — the hash /api/fm-auth actually verifies —
// untouched, so a diner "reset" their password and still could not log in.
//
// Never touches FM. Disco owns this credential.
export async function POST(req: NextRequest) {
  let token = ''
  let newPassword = ''
  try {
    const body = await req.json()
    token = String(body?.token || '').trim()
    newPassword = String(body?.newPassword || '')
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  if (!token) return NextResponse.json({ error: 'This reset link is missing its token.' }, { status: 400 })
  if (newPassword.length < 8) {
    return NextResponse.json({ error: 'Your new password must be at least 8 characters.' }, { status: 400 })
  }

  try {
    await runDiscoOrderMigrations()
    const hash = await hashCustomerPassword(newPassword)
    // Single statement: re-validates the token at write time and clears it, so
    // one link cannot set a password twice (there are no transactions here).
    const email = await setCustomerPasswordByResetToken(token, hash)
    if (!email) {
      return NextResponse.json(
        { error: 'This reset link has expired or has already been used. Request a new one.' },
        { status: 400 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (e) {
    // Surfaced, never swallowed into a success — telling someone their password
    // changed when it did not is the whole bug this replaces.
    console.error('[customer-set-password] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Could not set your password. Please try again.' }, { status: 500 })
  }
}
