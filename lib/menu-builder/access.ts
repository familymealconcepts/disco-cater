import { NextResponse } from 'next/server'
import { verifySuperAdmin } from '../admin-auth'
import { isArchiveAllowedEmail } from '../admin-archive-access'

// Menu Builder is Super Admin only, and of the Super Admins only Peter and
// Kealoha (Peter, 25 Oct 2026) — the same two-account allowlist that gates
// restaurant archive/delete. Checked on every Menu Builder route; the admin
// page itself only renders what these routes return.
export async function requireMenuBuilderAccess(): Promise<{ ok: true; email: string } | { ok: false; response: NextResponse }> {
  const v = await verifySuperAdmin()
  if (!v.ok) return { ok: false, response: NextResponse.json({ error: 'Not authorized' }, { status: 401 }) }
  if (!isArchiveAllowedEmail(v.email)) {
    return { ok: false, response: NextResponse.json({ error: 'Menu Builder is limited to Peter and Kealoha.' }, { status: 403 }) }
  }
  return { ok: true, email: String(v.email).trim().toLowerCase() }
}
