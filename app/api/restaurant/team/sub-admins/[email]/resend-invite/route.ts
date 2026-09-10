import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../../lib/restaurant-auth-context'
import { runDiscoOrderMigrations, sql } from '../../../../../../../lib/db'
import { setInviteToken } from '../../../../../../../lib/disco-restaurant-auth'
import { sendTeamMemberInvite } from '../../../../../../../lib/email/notifications'
import { assertManagedUser, loadManagedTarget } from '../../../../../../../lib/team-management-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SITE_URL = 'https://www.discocater.com'

// POST /api/restaurant/team/sub-admins/{email}/resend-invite
// Re-issues a set-password token for a Sub System Admin the calling PSA created
// and re-sends the invite email.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (ctx.authType !== 'disco') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { email: rawEmail } = await params
  const subEmail = decodeURIComponent(rawEmail || '').trim().toLowerCase()
  if (!subEmail) return NextResponse.json({ error: 'email required' }, { status: 400 })

  try {
    await runDiscoOrderMigrations()
    // FM's analogue is UserServiceImpl.resetPassword, which calls
    // findManagedUserByReference and NOTHING ELSE — notably it does NOT call
    // validateFirstSystemAdmin, so the first System Admin CAN be re-invited
    // even though they cannot be edited or removed. That asymmetry is FM's,
    // and it is deliberately reproduced here.
    //
    // The old test was `created_by = ctx.email`. Every FM-synced account has
    // created_by = NULL, so this 403'd for every viewer against every target
    // and nobody at Atlanta Bread could be re-invited at all.
    const target = await loadManagedTarget(subEmail)
    if (!target) return NextResponse.json({ error: 'No such user' }, { status: 404 })
    const managed = await assertManagedUser(ctx, target)
    if (!managed.ok) return NextResponse.json({ error: managed.error }, { status: managed.status })

    const rows = (await sql`
      SELECT email, first_name, restaurant_reference
      FROM disco_restaurant_accounts WHERE email = ${subEmail} LIMIT 1
    `) as Array<{ email: string; first_name: string | null; restaurant_reference: string | null }>
    const sub = rows[0]
    if (!sub) return NextResponse.json({ error: 'No such user' }, { status: 404 })

    const token = await setInviteToken(subEmail)
    const nameRows = (await sql`
      SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${sub.restaurant_reference} LIMIT 1
    `) as Array<{ name: string }>
    const restaurantName = nameRows[0]?.name || ctx.restaurantName || ctx.businessName || 'Disco Cater'
    const inviterName = `${ctx.firstName || ''} ${ctx.lastName || ''}`.trim() || ctx.email

    await sendTeamMemberInvite({
      to: subEmail,
      firstName: sub.first_name || '',
      inviteUrl: `${SITE_URL}/restaurant/accept-invite?token=${token}`,
      restaurantName,
      inviterName,
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[team/sub-admins/resend-invite] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to resend invite' }, { status: 500 })
  }
}
