import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { runDiscoOrderMigrations, sql } from '../../../../../lib/db'
import { getLocationAccessRefs, grantLocationAccess, hashPassword, setInviteToken } from '../../../../../lib/disco-restaurant-auth'
import { sendTeamMemberInvite } from '../../../../../lib/email/notifications'

const SITE_URL = 'https://www.discocater.com'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/restaurant/team/sub-admins
// A Primary System Admin (PSA) creates a Sub System Admin and grants them access
// to a subset of the PSA's own locations. Server-side guard: the sub admin can
// only be granted locations the PSA themselves has access to.
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (ctx.authType !== 'disco' || (ctx.role !== 'SYSTEM_ADMIN' && ctx.role !== 'SUPER_ADMIN')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const email = String(body?.email || '').trim().toLowerCase()
    const firstName = String(body?.firstName || '').trim()
    const lastName = String(body?.lastName || '').trim()
    const requested: string[] = Array.isArray(body?.restaurantReferences)
      ? body.restaurantReferences.map((r: unknown) => String(r)).filter(Boolean)
      : []
    if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 })
    if (!requested.length) return NextResponse.json({ error: 'Select at least one location' }, { status: 400 })

    await runDiscoOrderMigrations()

    // Enforce: sub admin can only get locations the PSA actually has.
    let psaRefs = await getLocationAccessRefs(ctx.email)
    if (!psaRefs.length && ctx.restaurantReference) psaRefs = [ctx.restaurantReference]
    const psaSet = new Set(psaRefs)
    const granted = requested.filter(r => psaSet.has(r))
    if (!granted.length) {
      return NextResponse.json({ error: 'You can only assign locations you have access to' }, { status: 403 })
    }

    // Create the account. password_hash is NOT NULL, so seed an unusable random
    // hash — the sub admin sets their real password via the invite link below.
    const placeholderHash = await hashPassword(randomUUID())
    const home = granted[0]
    await sql`
      INSERT INTO disco_restaurant_accounts (
        email, password_hash, restaurant_reference, first_name, last_name,
        restaurant_name, role, business_name, created_by, updated_at
      ) VALUES (
        ${email}, ${placeholderHash}, ${home}, ${firstName || null}, ${lastName || null},
        ${null}, 'SYSTEM_ADMIN', ${ctx.businessName || null}, ${ctx.email}, NOW()
      )
      ON CONFLICT (email) DO UPDATE SET
        role = 'SYSTEM_ADMIN', created_by = ${ctx.email},
        first_name = COALESCE(EXCLUDED.first_name, disco_restaurant_accounts.first_name),
        last_name = COALESCE(EXCLUDED.last_name, disco_restaurant_accounts.last_name),
        updated_at = NOW()
    `

    for (const ref of granted) {
      await grantLocationAccess(email, ref, ctx.email)
        .catch(e => console.error('[team/sub-admins] grant failed:', e instanceof Error ? e.message : e))
    }

    // Issue a set-password invite token and email the link (best-effort).
    try {
      const token = await setInviteToken(email)
      const nameRows = (await sql`
        SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${home} LIMIT 1
      `) as Array<{ name: string }>
      const restaurantName = nameRows[0]?.name || ctx.restaurantName || ctx.businessName || 'Disco Cater'
      const inviterName = `${ctx.firstName || ''} ${ctx.lastName || ''}`.trim() || ctx.email
      sendTeamMemberInvite({
        to: email, firstName,
        inviteUrl: `${SITE_URL}/restaurant/accept-invite?token=${token}`,
        restaurantName, inviterName,
      }).catch(() => {})
    } catch (e) {
      console.error('[team/sub-admins] invite token/email failed:', e instanceof Error ? e.message : e)
    }

    return NextResponse.json({ success: true, email, grantedCount: granted.length })
  } catch (err) {
    console.error('[restaurant/team/sub-admins] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to create sub admin' }, { status: 500 })
  }
}
