import { NextRequest, NextResponse } from 'next/server'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import { assertManagedUser, loadManagedTarget, getTeamActorContext } from '../../../../../../lib/team-management-scope'
import { discoRefAllowed } from '../../../../../../lib/restaurant-write-scope'
import { actorScope, checkAssign, checkRemove, currentList, diffLists, applyListChange } from '../../../../../../lib/system-admin-authority'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Who may manage whom: lib/team-management-scope.ts (visibility — the target
 * sits at one of your locations). What each change may do:
 * lib/system-admin-authority.ts (assign only what you have; remove only from
 * your invite chain, only what you have; never your own list; never a Primary).
 */
// PUT /api/restaurant/team/sub-admins/{email}  { restaurantReferences: string[] }
// Replace a user's locations. Additions and removals are authorized separately.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
  // Either kind of session, as a verified person; changes land in Disco only.
  const ctx = await getTeamActorContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { email: rawEmail } = await params
  const subEmail = decodeURIComponent(rawEmail || '').trim().toLowerCase()
  if (!subEmail) return NextResponse.json({ error: 'email required' }, { status: 400 })

  try {
    await runDiscoOrderMigrations()

    const target = await loadManagedTarget(subEmail)
    if (!target) return NextResponse.json({ error: 'No such user' }, { status: 404 })

    // Visibility first: the target must sit at one of the viewer's locations
    // (FM's findManagedUserByReference). Authority over each CHANGE is then
    // decided per direction by lib/system-admin-authority.ts — adding needs
    // only that the viewer holds the location; removing also needs the target
    // to be below the viewer in the invite chain, and never a Primary.
    const managed = await assertManagedUser(ctx, target)
    if (!managed.ok) return NextResponse.json({ error: managed.error }, { status: managed.status })

    const body = await req.json().catch(() => ({}))
    const requested: string[] = Array.isArray(body?.restaurantReferences)
      ? [...new Set<string>(body.restaurantReferences.map((r: unknown) => String(r)).filter(Boolean))]
      : []
    const targetRole = (target.role || 'ADMIN').toUpperCase()
    if (!requested.length) return NextResponse.json({ error: 'Pick at least one location.' }, { status: 400 })
    if (targetRole === 'ADMIN' && requested.length !== 1) {
      return NextResponse.json({ error: 'A Restaurant User must have exactly one location.' }, { status: 400 })
    }

    // A Restaurant User's location IS their anchor; a System Admin's is their list.
    const current = targetRole === 'ADMIN'
      ? [target.anchor].filter(Boolean) as string[]
      : await currentList(subEmail)
    const { added, removed } = diffLists(current, requested)

    const canAdd = await checkAssign(ctx, subEmail, added)
    if (!canAdd.ok) return NextResponse.json({ error: canAdd.error }, { status: canAdd.status })
    const canRemove = removed.length ? await checkRemove(ctx, subEmail, removed) : { ok: true as const }
    if (!canRemove.ok) return NextResponse.json({ error: canRemove.error }, { status: canRemove.status })

    if (targetRole === 'ADMIN') {
      // The ONLY write to an ADMIN's anchor. Their grant row follows it.
      const next = requested[0]
      if (next !== target.anchor) {
        await sql`UPDATE disco_restaurant_accounts SET restaurant_reference = ${next}, updated_at = NOW() WHERE email = ${subEmail}`
      }
      const r = await applyListChange(subEmail, [next], (await currentList(subEmail)).filter(x => x !== next), ctx.email)
      return NextResponse.json({ success: true, anchor: next, anchorChanged: next !== target.anchor, ...r })
    }

    const r = await applyListChange(subEmail, added, removed, ctx.email)
    return NextResponse.json({ success: true, ...r })
  } catch (err) {
    console.error('[restaurant/team/sub-admins] PUT failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to update sub admin' }, { status: 500 })
  }
}

// DELETE /api/restaurant/team/sub-admins/{email}
// Remove a sub admin account and all of their location access.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
  // Either kind of session, as a verified person; changes land in Disco only.
  const ctx = await getTeamActorContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { email: rawEmail } = await params
  const subEmail = decodeURIComponent(rawEmail || '').trim().toLowerCase()
  if (!subEmail) return NextResponse.json({ error: 'email required' }, { status: 400 })

  try {
    await runDiscoOrderMigrations()

    const target = await loadManagedTarget(subEmail)
    if (!target) return NextResponse.json({ error: 'No such user' }, { status: 404 })
    const managed = await assertManagedUser(ctx, target)
    if (!managed.ok) return NextResponse.json({ error: managed.error }, { status: managed.status })

    // ── REMOVE = TAKE AWAY THE LOCATIONS YOU HAVE, NOT THE PERSON ───────────
    // Rule 2: only from someone below you in the invite chain, and only the
    // locations you hold. A person who also holds locations you don't keeps
    // those, and keeps their account. Only when nothing is left is the account
    // archived — FM's deleteAdmin disables rather than deletes, and archived_at
    // is Disco's equivalent.
    const targetRole = (target.role || 'ADMIN').toUpperCase()
    const theirs = targetRole === 'ADMIN'
      ? [target.anchor].filter(Boolean) as string[]
      : await currentList(subEmail)
    const scope = await actorScope(ctx)
    const mine = theirs.filter(r => discoRefAllowed(scope, r))
    const verdict = await checkRemove(ctx, subEmail, mine.length ? mine : theirs)
    if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status })

    await applyListChange(subEmail, [], mine, ctx.email)
    const left = targetRole === 'ADMIN' ? theirs.filter(r => !mine.includes(r)) : await currentList(subEmail)
    if (!left.length) {
      await sql`DELETE FROM disco_restaurant_location_access WHERE lower(account_email) = ${subEmail}`
      await sql`UPDATE disco_restaurant_accounts SET archived_at = NOW(), invite_token = NULL, invite_token_expires_at = NULL, updated_at = NOW() WHERE email = ${subEmail}`
      return NextResponse.json({ success: true, archived: true, removed: mine.length })
    }
    return NextResponse.json({ success: true, archived: false, removed: mine.length, kept: left.length })
  } catch (err) {
    console.error('[restaurant/team/sub-admins] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to remove sub admin' }, { status: 500 })
  }
}
