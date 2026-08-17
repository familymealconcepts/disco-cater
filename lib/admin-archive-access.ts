import { NextResponse } from 'next/server'
import { getAdminRole, getAdminEmail } from './admin-auth'

// Restaurant archive / restore is restricted to exactly these two accounts — NOT
// to SUPER_ADMIN broadly. This mirrors FM's application.order.delete-without-status
// .allowed-email allowlist (RestaurantServiceImpl.isDeleteWithoutStatusAllowed):
// same two emails, checked case-insensitively. Keep this list in sync with FM's
// application.yml.
export const ARCHIVE_ALLOWED_EMAILS = ['peter@familymeal.com', 'kealoha@familymeal.com'] as const

export function isArchiveAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const e = email.trim().toLowerCase()
  return ARCHIVE_ALLOWED_EMAILS.some((a) => a.toLowerCase() === e)
}

export type ArchiveAccess =
  | { ok: true; email: string }
  | { ok: false; response: NextResponse }

// Defense-in-depth gate for the archive/restore routes. The route matcher does NOT
// cover /api/admin/* (middleware only guards the /admin pages), so these routes
// must verify authorization themselves rather than trusting mere cookie presence:
//   1) a valid admin token decoding to SUPER_ADMIN, AND
//   2) the caller's email is on the two-account allowlist.
export async function requireArchiveAccess(): Promise<ArchiveAccess> {
  const role = await getAdminRole()
  if (role !== 'SUPER_ADMIN') {
    return { ok: false, response: NextResponse.json({ error: 'Not authorized' }, { status: 401 }) }
  }
  const email = await getAdminEmail()
  if (!isArchiveAllowedEmail(email)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Archiving restaurants is restricted to specific accounts.' },
        { status: 403 },
      ),
    }
  }
  return { ok: true, email: (email as string).trim() }
}
