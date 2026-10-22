import { NextRequest, NextResponse } from 'next/server'
import { getTeamActorContext } from '../../../../../lib/team-management-scope'
import { randomUUID } from 'crypto'
import { runDiscoOrderMigrations, sql } from '../../../../../lib/db'
import { grantLocationAccess, hashPassword, setInviteToken } from '../../../../../lib/disco-restaurant-auth'
import { checkAssign, applyListChange } from '../../../../../lib/system-admin-authority'
import { sendTeamMemberInvite } from '../../../../../lib/email/notifications'

const SITE_URL = 'https://www.discocater.com'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/restaurant/team/sub-admins
// A Primary System Admin (PSA) creates a Sub System Admin and grants them access
// to a subset of the PSA's own locations. Server-side guard: the sub admin can
// only be granted locations the PSA themselves has access to.
export async function POST(req: NextRequest) {
  // Either kind of session, as a verified person; changes land in Disco only.
  const ctx = await getTeamActorContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const body = await req.json().catch(() => ({}))
    const email = String(body?.email || '').trim().toLowerCase()
    const firstName = String(body?.firstName || '').trim()
    const lastName = String(body?.lastName || '').trim()
    // Role of the new user: SYSTEM_ADMIN (multi-location) or ADMIN (Restaurant
    // User, single location). Defaults to SYSTEM_ADMIN for back-compat. A
    // single-restaurant ADMIN can only ever create ADMIN (Restaurant User)
    // accounts — never mint a SYSTEM_ADMIN.
    const isSA = ctx.role === 'SYSTEM_ADMIN' || ctx.role === 'SUPER_ADMIN'
    const role = !isSA || String(body?.role || 'SYSTEM_ADMIN').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'SYSTEM_ADMIN'
    const requested: string[] = Array.isArray(body?.restaurantReferences)
      ? body.restaurantReferences.map((r: unknown) => String(r)).filter(Boolean)
      : []
    if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 })
    if (!requested.length) return NextResponse.json({ error: 'Select at least one location' }, { status: 400 })

    await runDiscoOrderMigrations()

    // Rules 1 and 3 (lib/system-admin-authority.ts): only locations the inviter
    // has, and never onto the inviter's own list.
    const verdict = await checkAssign(ctx, email, requested)
    if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status })
    let granted = [...new Set(requested)]
    // Restaurant Users belong to a single location.
    if (role === 'ADMIN') granted = granted.slice(0, 1)
    const home = granted[0]

    // ── AN EXISTING PERSON KEEPS WHO THEY ARE ───────────────────────────────
    // This used to upsert, overwriting role and created_by on any address that
    // already had an account — so inviting someone else's System Admin re-filed
    // them under the inviter (and could quietly demote them to a single
    // location). Inviting an existing, active account now only hands them the
    // locations, which rule 1 already permits; their role, their inviter and
    // their password are untouched, and no invite email is sent because they
    // already have a login.
    const existing = (await sql`
      SELECT email, COALESCE(role, 'ADMIN') AS role, archived_at
        FROM disco_restaurant_accounts WHERE lower(email) = ${email} LIMIT 1
    `) as Array<{ email: string; role: string; archived_at: string | null }>
    const live = existing[0] && !existing[0].archived_at ? existing[0] : null
    if (live) {
      if (live.role.toUpperCase() !== 'SYSTEM_ADMIN') {
        return NextResponse.json({ error: 'That person already has an account for a single location. Ask concierge@discocater.com to change it.' }, { status: 409 })
      }
      const r = await applyListChange(live.email, granted, [], ctx.email)
      return NextResponse.json({ success: true, email, existing: true, grantedCount: r.added })
    }

    // Create the account (or revive an archived one). password_hash is NOT
    // NULL, so seed an unusable random hash — they set their real password via
    // the invite link below. invited_by is stamped here and nowhere else.
    const placeholderHash = await hashPassword(randomUUID())
    await sql`
      INSERT INTO disco_restaurant_accounts (
        email, password_hash, restaurant_reference, first_name, last_name,
        restaurant_name, role, business_name, created_by, invited_by, updated_at
      ) VALUES (
        ${email}, ${placeholderHash}, ${home}, ${firstName || null}, ${lastName || null},
        ${null}, ${role}, ${ctx.businessName || null}, ${ctx.email}, ${ctx.email.toLowerCase()}, NOW()
      )
      ON CONFLICT (email) DO UPDATE SET
        role = ${role}, created_by = ${ctx.email}, invited_by = ${ctx.email.toLowerCase()},
        restaurant_reference = ${home}, archived_at = NULL,
        password_hash = ${placeholderHash}, password_set_at = NULL,
        first_name = COALESCE(EXCLUDED.first_name, disco_restaurant_accounts.first_name),
        last_name = COALESCE(EXCLUDED.last_name, disco_restaurant_accounts.last_name),
        updated_at = NOW()
      WHERE disco_restaurant_accounts.archived_at IS NOT NULL
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
