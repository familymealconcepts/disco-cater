import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../../lib/restaurant-auth-context'
import { runDiscoOrderMigrations, sql } from '../../../../../../../lib/db'
import { setInviteToken } from '../../../../../../../lib/disco-restaurant-auth'
import { sendTeamMemberInvite } from '../../../../../../../lib/email/notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SITE_URL = 'https://www.discocater.com'

// POST /api/restaurant/team/sub-admins/{email}/resend-invite
// Re-issues a set-password token for a Sub System Admin the calling PSA created
// and re-sends the invite email.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (ctx.authType !== 'disco' || (ctx.role !== 'SYSTEM_ADMIN' && ctx.role !== 'SUPER_ADMIN')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { email: rawEmail } = await params
  const subEmail = decodeURIComponent(rawEmail || '').trim().toLowerCase()
  if (!subEmail) return NextResponse.json({ error: 'email required' }, { status: 400 })

  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT email, first_name, restaurant_reference
      FROM disco_restaurant_accounts
      WHERE email = ${subEmail} AND created_by = ${ctx.email} AND role = 'SYSTEM_ADMIN'
      LIMIT 1
    `) as Array<{ email: string; first_name: string | null; restaurant_reference: string | null }>
    const sub = rows[0]
    if (!sub) return NextResponse.json({ error: 'Not your sub admin' }, { status: 403 })

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
