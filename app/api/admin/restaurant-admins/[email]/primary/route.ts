import { NextRequest, NextResponse } from 'next/server'
import { verifySuperAdmin } from '../../../../../../lib/admin-auth'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { currentList, applyListChange } from '../../../../../../lib/system-admin-authority'
import { logAdminAction } from '../../../../../../lib/admin-audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── ONLY A SUPER ADMIN CHANGES THE PRIMARY (Peter, 22 Oct 2026) ─────────────
// This route is the only writer of is_primary_system_admin outside the one-time
// migration. Nothing in the restaurant portal can reach it.
//
// PUT { primary: true }  — make this System Admin the Primary of their group.
//   The group is "every Primary who shares a location with them" (a Primary
//   holds every location in their group, so sharing one = same business). Those
//   Primaries lose the tag but KEEP every location — nobody loses access by a
//   Primary change; a Super Admin removes locations separately if wanted. The
//   new Primary gains every location the old Primary held, because a Primary
//   holds the whole group. fm_group_id moves with the tag.
//   A group with no Primary (the Happys/Savvy co-brand, by decision) simply
//   gains one.
// PUT { primary: false } — remove the tag. Locations are untouched.

export async function PUT(req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
  // Verified with FamilyMeal before the role is trusted (lib/admin-auth.ts).
  const v = await verifySuperAdmin()
  if (!v.ok) return NextResponse.json({ error: v.status === 401 ? 'Not authenticated' : 'Super Admin only' }, { status: v.status })
  const actor = v.email
  const email = decodeURIComponent((await params).email || '').trim().toLowerCase()
  const body = await req.json().catch(() => ({})) as { primary?: unknown }
  const makePrimary = body.primary === true

  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT email, UPPER(COALESCE(role, 'ADMIN')) AS role, COALESCE(is_primary_system_admin, false) AS is_primary, fm_group_id
        FROM disco_restaurant_accounts WHERE lower(email) = ${email} AND archived_at IS NULL LIMIT 1
    `) as Array<{ email: string; role: string; is_primary: boolean; fm_group_id: string | null }>
    const target = rows[0]
    if (!target) return NextResponse.json({ error: 'Only a person with a Disco account can be the Primary.' }, { status: 404 })
    if (target.role !== 'SYSTEM_ADMIN') return NextResponse.json({ error: 'Only a System Admin can be the Primary.' }, { status: 400 })

    if (!makePrimary) {
      await sql`UPDATE disco_restaurant_accounts SET is_primary_system_admin = FALSE, updated_at = NOW() WHERE lower(email) = ${email}`
      await logAdminAction({ action: 'primary_system_admin_change', restaurantReference: '', actorEmail: actor, detail: { targetEmail: email, primary: false } })
      return NextResponse.json({ ok: true, primary: false })
    }
    if (target.is_primary) return NextResponse.json({ ok: true, primary: true, unchanged: true })

    const mine = await currentList(email)
    if (!mine.length) return NextResponse.json({ error: 'Give this person at least one location before making them the Primary.' }, { status: 400 })
    const previous = (await sql`
      SELECT DISTINCT lower(a.email) AS email, a.fm_group_id
        FROM disco_restaurant_accounts a
        JOIN disco_restaurant_location_access g ON lower(g.account_email) = lower(a.email)
       WHERE a.is_primary_system_admin = TRUE AND a.archived_at IS NULL
         AND lower(a.email) <> ${email}
         AND g.restaurant_reference = ANY(${mine}::text[])
    `) as Array<{ email: string; fm_group_id: string | null }>

    // New Primary takes the whole group: every location the old Primary held.
    const inherit = new Set<string>()
    for (const p of previous) for (const r of await currentList(p.email)) inherit.add(r)
    const toAdd = [...inherit].filter(r => !mine.includes(r))
    if (toAdd.length) await applyListChange(email, toAdd, [], actor || 'super-admin')

    const groupId = previous.find(p => p.fm_group_id)?.fm_group_id ?? target.fm_group_id ?? null
    const prevEmails = previous.map(p => p.email)
    await sql`
      UPDATE disco_restaurant_accounts SET is_primary_system_admin = FALSE, updated_at = NOW()
       WHERE lower(email) = ANY(${prevEmails}::text[])`
    await sql`
      UPDATE disco_restaurant_accounts SET is_primary_system_admin = TRUE, fm_group_id = ${groupId}, updated_at = NOW()
       WHERE lower(email) = ${email}`

    await logAdminAction({
      action: 'primary_system_admin_change', restaurantReference: '', actorEmail: actor,
      detail: { targetEmail: email, primary: true, previousPrimaries: prevEmails, locationsInherited: toAdd.length },
    })
    return NextResponse.json({ ok: true, primary: true, previousPrimaries: prevEmails, locationsInherited: toAdd.length })
  } catch (e) {
    console.error('[admin/restaurant-admins primary] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to change the Primary' }, { status: 500 })
  }
}
