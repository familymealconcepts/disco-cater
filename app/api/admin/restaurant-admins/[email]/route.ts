import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail, getAdminRole } from '../../../../../lib/admin-auth'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'
import { currentList, diffLists, applyListChange } from '../../../../../lib/system-admin-authority'
import { logAdminAction } from '../../../../../lib/admin-audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Super Admin edits on the Restaurant Admins page. DISCO ONLY — nothing here
// calls FamilyMeal. A Super Admin is unrestricted by the System Admin rules
// (lib/system-admin-authority.ts), so this route only validates shape.

async function gate(): Promise<{ ok: true; actor: string | null } | { ok: false; res: NextResponse }> {
  try { await getAdminAuthHeader() } catch {
    return { ok: false, res: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  }
  if ((await getAdminRole()) !== 'SUPER_ADMIN') {
    return { ok: false, res: NextResponse.json({ error: 'Super Admin only' }, { status: 403 }) }
  }
  return { ok: true, actor: await getAdminEmail().catch(() => null) }
}

const emailOf = async (params: Promise<{ email: string }>) =>
  decodeURIComponent((await params).email || '').trim().toLowerCase()

async function account(email: string) {
  const rows = (await sql`
    SELECT email, UPPER(COALESCE(role, 'ADMIN')) AS role, restaurant_reference AS anchor
      FROM disco_restaurant_accounts WHERE lower(email) = ${email} AND archived_at IS NULL LIMIT 1
  `) as Array<{ email: string; role: string; anchor: string | null }>
  return rows[0] ?? null
}

// PUT { firstName?, lastName?, restaurantReferences?: string[] }
// Name lands on the Disco account (FamilyMeal is not written). Locations
// replace the person's single list. An ADMIN (Single) must keep exactly one.
// A FamilyMeal-only System Admin (no Disco account) can still have their Disco
// list set — it is keyed on email — but has no name to edit here.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
  const g = await gate(); if (!g.ok) return g.res
  const email = await emailOf(params)
  if (!email || email.startsWith('stripe-import+')) return NextResponse.json({ error: 'Invalid user' }, { status: 400 })
  try {
    await runDiscoOrderMigrations()
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const acct = await account(email)
    const role = acct?.role ?? (String(body.role || '').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'SYSTEM_ADMIN')

    if (acct && (typeof body.firstName === 'string' || typeof body.lastName === 'string')) {
      const first = String(body.firstName ?? '').trim()
      if (!first) return NextResponse.json({ error: 'First name is required' }, { status: 400 })
      await sql`
        UPDATE disco_restaurant_accounts
           SET first_name = ${first}, last_name = ${String(body.lastName ?? '').trim() || null}, updated_at = NOW()
         WHERE lower(email) = ${email}`
    }

    let change = { added: 0, removed: 0 }
    if (Array.isArray(body.restaurantReferences)) {
      const desired = [...new Set((body.restaurantReferences as unknown[]).map(String).map(s => s.trim()).filter(Boolean))]
      if (role === 'ADMIN') {
        if (!acct) return NextResponse.json({ error: 'This admin has no Disco account; their location is FamilyMeal’s.' }, { status: 409 })
        if (desired.length !== 1) return NextResponse.json({ error: 'A Single admin has exactly one location.' }, { status: 400 })
        if (desired[0] !== acct.anchor) {
          await sql`UPDATE disco_restaurant_accounts SET restaurant_reference = ${desired[0]}, updated_at = NOW() WHERE lower(email) = ${email}`
        }
        const cur = await currentList(email)
        change = await applyListChange(email, [desired[0]], cur.filter(r => r !== desired[0]), g.actor || 'super-admin')
      } else {
        const known = (await sql`
          SELECT restaurant_reference::text AS ref FROM disco_restaurant_cache WHERE restaurant_reference = ANY(${desired}::text[])
        `) as Array<{ ref: string }>
        if (known.length !== desired.length) return NextResponse.json({ error: 'One or more locations were not found.' }, { status: 400 })
        const { added, removed } = diffLists(await currentList(email), desired)
        change = await applyListChange(email, added, removed, g.actor || 'super-admin')
      }
    }

    await logAdminAction({ action: 'restaurant_admin_update', restaurantReference: '', actorEmail: g.actor, detail: { targetEmail: email, ...change } })
    return NextResponse.json({ ok: true, ...change })
  } catch (e) {
    console.error('[admin/restaurant-admins PUT] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to save' }, { status: 500 })
  }
}

// DELETE — removes the person from Disco: their location list is cleared and
// their Disco account (if any) is ARCHIVED, never deleted (orders, audit rows
// and grants reference it). FamilyMeal is not touched, so an FM-only person
// keeps their familymeal.com login; that is FM's to manage.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
  const g = await gate(); if (!g.ok) return g.res
  const email = await emailOf(params)
  if (!email || email.startsWith('stripe-import+')) return NextResponse.json({ error: 'Invalid user' }, { status: 400 })
  try {
    await runDiscoOrderMigrations()
    const removed = (await sql`
      DELETE FROM disco_restaurant_location_access WHERE lower(account_email) = ${email} RETURNING restaurant_reference
    `) as unknown[]
    const archived = (await sql`
      UPDATE disco_restaurant_accounts
         SET archived_at = NOW(), invite_token = NULL, invite_token_expires_at = NULL,
             is_primary_system_admin = FALSE, updated_at = NOW()
       WHERE lower(email) = ${email} AND archived_at IS NULL
      RETURNING email
    `) as unknown[]
    await logAdminAction({ action: 'restaurant_admin_remove', restaurantReference: '', actorEmail: g.actor, detail: { targetEmail: email, locationsRemoved: removed.length, archived: archived.length > 0 } })
    return NextResponse.json({ ok: true, locationsRemoved: removed.length, archived: archived.length > 0 })
  } catch (e) {
    console.error('[admin/restaurant-admins DELETE] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to remove' }, { status: 500 })
  }
}
