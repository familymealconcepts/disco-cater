import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, type RestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import { assertManagedUser, assertNotFirstSystemAdmin, loadManagedTarget } from '../../../../../../lib/team-management-scope'
import { resolveDiscoAccessScope, discoRefAllowed } from '../../../../../../lib/restaurant-write-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The LOCATION rules only — who may manage whom now lives in
 * lib/team-management-scope.ts, mirroring FM's UserServiceImpl. FM's role
 * rules, unchanged: an ADMIN has exactly one location, a SYSTEM_ADMIN one or
 * many, and every requested location must be one the viewer holds themselves
 * (UserServiceImpl.createAdmin/updateAdmin resolve each reference through
 * findManagedRestaurantByReference against the caller's own group).
 */
async function validateRequestedLocations(
  ctx: RestaurantAuthContext,
  targetRole: string,
  requested: string[],
): Promise<{ ok: true; refs: string[] } | { ok: false; error: string; status: number }> {
  const scope = await resolveDiscoAccessScope(ctx)
  const outside = requested.filter(r => !discoRefAllowed(scope, r))
  if (outside.length) {
    return { ok: false, error: `You can only assign locations you have access to (${outside.length} not yours).`, status: 403 }
  }
  if (!requested.length) return { ok: false, error: 'Pick at least one location.', status: 400 }
  if (targetRole.toUpperCase() === 'ADMIN' && requested.length !== 1) {
    return { ok: false, error: 'A Restaurant User must have exactly one location.', status: 400 }
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

    const target = await loadManagedTarget(subEmail)
    if (!target) return NextResponse.json({ error: 'No such user' }, { status: 404 })

    // FM: updateAdmin = findManagedUserByReference + validateFirstSystemAdmin.
    const managed = await assertManagedUser(ctx, target)
    if (!managed.ok) return NextResponse.json({ error: managed.error }, { status: managed.status })
    const notFirst = await assertNotFirstSystemAdmin(target)
    if (!notFirst.ok) return NextResponse.json({ error: notFirst.error }, { status: notFirst.status })

    const body = await req.json().catch(() => ({}))
    const requested: string[] = Array.isArray(body?.restaurantReferences)
      ? body.restaurantReferences.map((r: unknown) => String(r)).filter(Boolean)
      : []

    const targetRole = (target.role || 'ADMIN').toUpperCase()
    const verdict = await validateRequestedLocations(ctx, targetRole, requested)
    if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status })
    const refs = verdict.refs

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

    // FM: deleteAdmin = findManagedUserByReference + validateFirstSystemAdmin.
    // The old test was `created_by = ctx.email`, which is NULL on every
    // FM-synced account and so rejected everyone; FM has no creator concept at
    // all (see lib/team-management-scope.ts).
    const target = await loadManagedTarget(subEmail)
    if (!target) return NextResponse.json({ error: 'No such user' }, { status: 404 })
    const managed = await assertManagedUser(ctx, target)
    if (!managed.ok) return NextResponse.json({ error: managed.error }, { status: managed.status })
    const notFirst = await assertNotFirstSystemAdmin(target)
    if (!notFirst.ok) return NextResponse.json({ error: notFirst.error }, { status: notFirst.status })

    // FM's deleteAdmin DISABLES and detaches rather than hard-deleting
    // (setEnabled(false), restaurant/group/managedRestaurants nulled). Disco's
    // equivalent is archived_at plus dropping the grants. One statement each;
    // grants first, so a failure never leaves a live account with no locations.
    await sql`DELETE FROM disco_restaurant_location_access WHERE account_email = ${subEmail}`
    await sql`UPDATE disco_restaurant_accounts SET archived_at = NOW(), updated_at = NOW() WHERE email = ${subEmail}`
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[restaurant/team/sub-admins] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to remove sub admin' }, { status: 500 })
  }
}
