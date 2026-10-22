import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail, getAdminRole } from '../../../../../../lib/admin-auth'
import { sql } from '../../../../../../lib/db'
import { sendPasswordResetTo } from '../../../../../../lib/password-reset'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST — "Resend set-password email" on the Restaurant Admins page.
//
// THE EXISTING RESET EMAIL, through sendPasswordResetTo: same template, same
// token store, same 5-minute cooldown, same audit row as "Forgot password" and
// the Users screen button. Addressed to the account's own email; the token
// never reaches this response.
//
// Wider than the Users screen's eligibility on purpose. That screen refuses an
// account whose anchor is FM-backed ("FamilyMeal owns this login") and one with
// no Disco password yet. Neither applies to a restaurant admin here: Disco's
// login checks the Disco password first for ANY account row (it is not gated on
// the restaurant being native), and the reset link lands on the same
// /restaurant/accept-invite set-password page an invite does. Only a Disco
// account can receive it — an FM-only person has no Disco row to set a
// password on — and never a sentinel or a Super Admin.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  if ((await getAdminRole()) !== 'SUPER_ADMIN') return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  const actor = await getAdminEmail().catch(() => null)
  const email = decodeURIComponent((await params).email || '').trim().toLowerCase()
  if (!email || email.startsWith('stripe-import+')) return NextResponse.json({ error: 'Invalid user' }, { status: 400 })

  const rows = (await sql`
    SELECT a.email, a.first_name, a.restaurant_reference, UPPER(COALESCE(a.role, 'ADMIN')) AS role, c.name AS restaurant_name
      FROM disco_restaurant_accounts a
      LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = a.restaurant_reference
     WHERE lower(a.email) = ${email} AND a.archived_at IS NULL
     LIMIT 1
  `) as Array<{ email: string; first_name: string | null; restaurant_reference: string | null; role: string; restaurant_name: string | null }>
  const a = rows[0]
  if (!a) return NextResponse.json({ error: 'No Disco account for this email — FamilyMeal owns this login.' }, { status: 409 })
  if (a.role !== 'SYSTEM_ADMIN' && a.role !== 'ADMIN') return NextResponse.json({ error: 'Not a restaurant admin.' }, { status: 409 })

  let outcome
  try {
    outcome = await sendPasswordResetTo(
      { kind: 'restaurant', email: a.email, firstName: a.first_name, restaurantName: a.restaurant_name, restaurantReference: a.restaurant_reference, role: a.role },
      { source: 'super-admin', actorEmail: actor },
    )
  } catch (e) {
    console.error('[admin/restaurant-admins set-password] send threw:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'The email could not be sent.' }, { status: 502 })
  }
  if (!outcome.ok) return NextResponse.json({ error: outcome.message }, { status: outcome.code === 'rate-limited' ? 429 : 502 })
  return NextResponse.json({ ok: true, sentTo: a.email, ...(outcome.audited ? {} : { warning: 'Sent, but the audit row could not be written.' }) })
}
