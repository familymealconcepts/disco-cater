import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import { getLocationAccessRefs, grantLocationAccess, getHomeLocationRef } from '../../../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Verify the target email is a user (System Admin or Restaurant User) created by
// the calling inviter.
async function assertOwnedSubAdmin(psaEmail: string, subEmail: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM disco_restaurant_accounts
    WHERE email = ${subEmail} AND created_by = ${psaEmail} LIMIT 1
  `) as unknown[]
  return rows.length > 0
}

// PUT /api/restaurant/team/sub-admins/{email}  { restaurantReferences: string[] }
// Replace a sub admin's location access. Only locations the PSA has access to may
// be granted; the sub admin's home location is always retained.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
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
    if (!(await assertOwnedSubAdmin(ctx.email, subEmail))) {
      return NextResponse.json({ error: 'Not your sub admin' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const requested: string[] = Array.isArray(body?.restaurantReferences)
      ? body.restaurantReferences.map((r: unknown) => String(r)).filter(Boolean)
      : []

    let psaRefs = await getLocationAccessRefs(ctx.email)
    if (!psaRefs.length && ctx.restaurantReference) psaRefs = [ctx.restaurantReference]
    const psaSet = new Set(psaRefs)
    const granted = requested.filter(r => psaSet.has(r))

    const home = await getHomeLocationRef(subEmail)
    const keep = new Set(granted)
    if (home) keep.add(home) // home is always retained

    // Replace: drop everything except home, then grant the kept set.
    if (home) {
      await sql`
        DELETE FROM disco_restaurant_location_access
        WHERE account_email = ${subEmail} AND restaurant_reference <> ${home}
      `
    } else {
      await sql`DELETE FROM disco_restaurant_location_access WHERE account_email = ${subEmail}`
    }
    for (const ref of keep) {
      await grantLocationAccess(subEmail, ref, ctx.email)
        .catch(e => console.error('[team/sub-admins PUT] grant failed:', e instanceof Error ? e.message : e))
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[restaurant/team/sub-admins] PUT failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to update sub admin' }, { status: 500 })
  }
}

// DELETE /api/restaurant/team/sub-admins/{email}
// Remove a sub admin account and all of their location access.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
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
    if (!(await assertOwnedSubAdmin(ctx.email, subEmail))) {
      return NextResponse.json({ error: 'Not your sub admin' }, { status: 403 })
    }
    await sql`DELETE FROM disco_restaurant_location_access WHERE account_email = ${subEmail}`
    await sql`DELETE FROM disco_restaurant_accounts WHERE email = ${subEmail} AND created_by = ${ctx.email}`
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[restaurant/team/sub-admins] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to remove sub admin' }, { status: 500 })
  }
}
