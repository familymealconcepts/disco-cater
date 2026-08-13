import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { sql } from '../../../../../../lib/db'
import { setInviteToken } from '../../../../../../lib/disco-restaurant-auth'
import { sendTeamMemberInvite } from '../../../../../../lib/email/notifications'

export const runtime = 'nodejs'

const SITE_URL = 'https://www.discocater.com'
// Same pattern ensureRestaurantLoginInvited guards against — never (re)send an
// invite to the auto-generated Stripe-import sentinel; that address belongs to
// no one and the real admin identity has to be resolved first.
const SENTINEL_EMAIL_RE = /^stripe-import\+.+@familymeal\.com$/i

// POST /api/admin/restaurants/{ref}/resend-invite
// Reissues a fresh set-password invite (new token, new 14-day window — see
// setInviteToken) for a restaurant whose existing invite died unused, and
// emails it via the same template ensureRestaurantLoginInvited uses at
// conversion time. Manual escape hatch for a dead invite that previously
// required a developer running setInviteToken by hand.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params

  const rows = (await sql`
    SELECT email, first_name, restaurant_name FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref}
    ORDER BY created_at ASC LIMIT 1
  `) as { email: string; first_name: string | null; restaurant_name: string | null }[]
  const acct = rows[0]
  if (!acct?.email) return NextResponse.json({ error: 'No login account found for this restaurant.' }, { status: 404 })
  if (SENTINEL_EMAIL_RE.test(acct.email)) {
    return NextResponse.json({ error: 'This restaurant only has a Stripe-import sentinel account — resolve its real admin identity before inviting.' }, { status: 400 })
  }

  const token = await setInviteToken(acct.email)
  const sent = await sendTeamMemberInvite({
    to: acct.email,
    firstName: acct.first_name ?? undefined,
    inviteUrl: `${SITE_URL}/restaurant/accept-invite?token=${token}`,
    restaurantName: acct.restaurant_name ?? undefined,
  })
  return NextResponse.json({ ok: true, email: acct.email, emailed: sent.success })
}
