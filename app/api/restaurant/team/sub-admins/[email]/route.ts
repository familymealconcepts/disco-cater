import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, type RestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import { getLocationAccessRefs } from '../../../../../../lib/disco-restaurant-auth'
import { resolveDiscoAccessScope, discoRefAllowed } from '../../../../../../lib/restaurant-write-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Verify the target email is a user (System Admin or Restaurant User) created by
// the calling inviter. STILL USED BY DELETE, which really is an ownership
// operation — you may only delete an account you created.
async function assertOwnedSubAdmin(psaEmail: string, subEmail: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM disco_restaurant_accounts
    WHERE email = ${subEmail} AND created_by = ${psaEmail} LIMIT 1
  `) as unknown[]
  return rows.length > 0
}

interface TargetAccount { email: string; role: string; anchor: string | null }

/**
 * May `ctx` edit `target`'s locations, and to which set?
 *
 * WHY THIS REPLACES THE OWNERSHIP TEST ON PUT. The guard used to be
 * assertOwnedSubAdmin — `created_by = ctx.email`, i.e. "I personally invited
 * this person". Every account that arrived by the FM sync carries
 * created_by = NULL (all 15 on Atlanta Bread do), and NULL equals nothing, so
 * the check failed for every viewer against every target and the editor
 * answered "Not your sub admin" no matter who asked. Editing a colleague you
 * did not personally invite was not a permission that existed.
 *
 * The replacement is a SCOPE test, not an ownership test, and it is deliberately
 * no wider than what the viewer already has:
 *   - only a SUPER_ADMIN or a SYSTEM_ADMIN may edit anyone (unchanged: the team
 *     list is only returned to those roles in the first place);
 *   - the target must already be reachable by the viewer, so you cannot reach
 *     across chains;
 *   - every requested location must be one the viewer holds themselves.
 * Roles are neither read from nor written to here — this adds a missing write
 * path, it does not change what any role may do.
 */
async function assertMayEditLocations(
  ctx: RestaurantAuthContext,
  target: TargetAccount,
  requested: string[],
): Promise<{ ok: true; refs: string[] } | { ok: false; error: string; status: number }> {
  const viewerRole = (ctx.role || '').toUpperCase()
  if (viewerRole !== 'SUPER_ADMIN' && viewerRole !== 'SYSTEM_ADMIN') {
    return { ok: false, error: 'Only a System Admin can change a user\u2019s locations.', status: 403 }
  }

  const scope = await resolveDiscoAccessScope(ctx)

  // The target must already sit inside the viewer's reach.
  const targetRefs = new Set<string>(await getLocationAccessRefs(target.email))
  if (target.anchor) targetRefs.add(target.anchor)
  const reachable = scope.unrestricted || [...targetRefs].some(r => discoRefAllowed(scope, r))
  if (!reachable) {
    return { ok: false, error: 'That user is not at one of your locations.', status: 403 }
  }

  // Only to locations the viewer holds themselves.
  const outside = requested.filter(r => !discoRefAllowed(scope, r))
  if (outside.length) {
    return { ok: false, error: `You can only assign locations you have access to (${outside.length} not yours).`, status: 403 }
  }

  // FM's role rules, unchanged: an ADMIN has exactly one location; a
  // SYSTEM_ADMIN may hold one or many.
  const targetRole = (target.role || 'ADMIN').toUpperCase()
  if (targetRole === 'ADMIN' && requested.length !== 1) {
    return { ok: false, error: 'A Restaurant User must have exactly one location.', status: 400 }
  }
  if (!requested.length) {
    return { ok: false, error: 'Pick at least one location.', status: 400 }
  }
  return { ok: true, refs: [...new Set(requested)] }
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

    const targetRows = (await sql`
      SELECT email, COALESCE(role, 'ADMIN') AS role, restaurant_reference AS anchor
      FROM disco_restaurant_accounts WHERE email = ${subEmail} AND archived_at IS NULL LIMIT 1
    `) as Array<{ email: string; role: string; anchor: string | null }>
    const target = targetRows[0]
    if (!target) return NextResponse.json({ error: 'No such user' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const requested: string[] = Array.isArray(body?.restaurantReferences)
      ? body.restaurantReferences.map((r: unknown) => String(r)).filter(Boolean)
      : []

    const verdict = await assertMayEditLocations(ctx, target, requested)
    if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status })
    const refs = verdict.refs
    const targetRole = (target.role || 'ADMIN').toUpperCase()

    // ANCHOR FIRST, then grants — the same ordering the surplus-grant cleanup
    // used, and for the same reason: the grant replacement below is written
    // against the anchor, so correcting it afterwards would leave the wrong row.
    //
    // This is the ONLY write to disco_restaurant_accounts.restaurant_reference
    // in the codebase. Nothing else has ever set it, which is why a wrong
    // anchor previously had to be corrected by hand in the database.
    const nextAnchor = targetRole === 'ADMIN'
      ? refs[0]
      // A SYSTEM_ADMIN keeps their anchor while it is still in their set;
      // if it was just removed, it would point at a location they can no
      // longer reach, so it moves to the first of the new set.
      : (target.anchor && refs.includes(target.anchor) ? target.anchor : refs[0])
    if (nextAnchor && nextAnchor !== target.anchor) {
      await sql`
        UPDATE disco_restaurant_accounts
        SET restaurant_reference = ${nextAnchor}, updated_at = NOW()
        WHERE email = ${subEmail}
      `
    }

    // ONE statement. There are no transactions here (neon HTTP), so a
    // delete-then-insert pair could leave the account with no locations at all
    // if the second half failed. A data-modifying CTE applies both together.
    const counts = (await sql`
      WITH desired AS (SELECT UNNEST(${refs}::text[]) AS ref),
      removed AS (
        DELETE FROM disco_restaurant_location_access
        WHERE account_email = ${subEmail}
          AND restaurant_reference NOT IN (SELECT ref FROM desired)
        RETURNING 1
      ),
      added AS (
        INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by)
        SELECT ${subEmail}, ref, ${ctx.email} FROM desired
        ON CONFLICT (account_email, restaurant_reference) DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT COUNT(*)::int FROM removed) AS removed, (SELECT COUNT(*)::int FROM added) AS added
    `) as Array<{ removed: number; added: number }>

    return NextResponse.json({
      success: true,
      anchor: nextAnchor,
      anchorChanged: nextAnchor !== target.anchor,
      removed: counts[0]?.removed ?? 0,
      added: counts[0]?.added ?? 0,
    })
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
