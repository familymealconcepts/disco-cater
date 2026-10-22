import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../lib/admin-auth'
import { sql } from '../../../../../lib/db'
import { syncAfterGrant } from '../../../../../lib/location-groups'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// ── DISCO-NATIVE SYSTEM ADMINS ──────────────────────────────────────────────
// The listing route already merges them in under a synthetic `disco:<email>`
// reference (see ../route.ts). Edit and Delete did not follow, so the page
// showed those rows read-only as "Portal-managed" — a super admin could see a
// Disco-native system admin and change nothing about them. A converted
// restaurant is Disco's, its people are Disco's, and the super-admin portal is
// where a super admin manages people.
//
// Reach is disco_restaurant_location_access, NEVER the account's own
// restaurant_reference anchor and never its role. Joining accounts on
// restaurant_reference to derive locations is the mistake that produced the
// multi-unit reach bug.
const DISCO_ADMIN_PREFIX = 'disco:'

function discoEmail(ref: string): string | null {
  if (!ref.startsWith(DISCO_ADMIN_PREFIX)) return null
  const e = decodeURIComponent(ref.slice(DISCO_ADMIN_PREFIX.length)).trim().toLowerCase()
  return e || null
}

/**
 * Write a System Admin's SINGLE location list. Disco-only; FamilyMeal is never
 * touched. Shared by the native and the FM-sourced update paths so both land in
 * exactly one place.
 */
async function writeDiscoLocationList(email: string, refs: string[], actor: string | null) {
  await sql.transaction([
    sql`DELETE FROM disco_restaurant_location_access
         WHERE lower(account_email) = ${email} AND restaurant_reference <> ALL(${refs})`,
    sql`INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by, invited_by)
        SELECT ${email}, r, ${actor}, ${actor}
          FROM unnest(${refs}::text[]) AS r
         WHERE NOT EXISTS (
           SELECT 1 FROM disco_restaurant_location_access
            WHERE lower(account_email) = ${email} AND restaurant_reference = r)`,
  ])
  await syncAfterGrant(email, refs)
}

async function updateDiscoSystemAdmin(email: string, body: Record<string, unknown>, actor: string | null) {
  const firstName = String(body?.firstName ?? '').trim()
  const lastName = String(body?.lastName ?? '').trim()
  const newEmail = String(body?.email ?? '').trim().toLowerCase() || email
  const refs = Array.isArray(body?.restaurantReferences) ? (body.restaurantReferences as unknown[]).map(String).filter(Boolean) : []
  if (!firstName) return NextResponse.json({ error: 'First name is required' }, { status: 400 })
  if (!refs.length) return NextResponse.json({ error: 'Assign at least one location' }, { status: 400 })

  const existing = (await sql`
    SELECT email FROM disco_restaurant_accounts WHERE lower(email) = ${email} AND archived_at IS NULL LIMIT 1
  `) as Array<{ email: string }>
  if (!existing.length) return NextResponse.json({ error: 'System admin not found' }, { status: 404 })

  if (newEmail !== email) {
    const taken = (await sql`SELECT 1 FROM disco_restaurant_accounts WHERE lower(email) = ${newEmail} LIMIT 1`) as unknown[]
    if (taken.length) return NextResponse.json({ error: 'That email is already in use' }, { status: 409 })
  }

  // Grants are keyed by email, so an email change has to move them or the
  // person silently loses every location.
  await sql.transaction([
    sql`
      UPDATE disco_restaurant_accounts
         SET first_name = ${firstName}, last_name = ${lastName || null}, email = ${newEmail}, updated_at = NOW()
       WHERE lower(email) = ${email}
    `,
    sql`UPDATE disco_restaurant_location_access SET account_email = ${newEmail} WHERE lower(account_email) = ${email}`,
    sql`DELETE FROM disco_restaurant_location_access WHERE lower(account_email) = ${newEmail} AND restaurant_reference <> ALL(${refs})`,
    sql`
      INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by)
      SELECT ${newEmail}, r, ${actor}
        FROM unnest(${refs}::text[]) AS r
       WHERE NOT EXISTS (
         SELECT 1 FROM disco_restaurant_location_access
          WHERE lower(account_email) = ${newEmail} AND restaurant_reference = r
       )
    `,
  ])
  return NextResponse.json({ ok: true, reference: `${DISCO_ADMIN_PREFIX}${newEmail}`, email: newEmail, locations: refs.length })
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { id: ref } = await params

  const native = discoEmail(ref)
  if (native) {
    try { return await updateDiscoSystemAdmin(native, await req.json(), await getAdminEmail()) }
    catch (e) {
      console.error('[admin/system-admins] native update failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to update system admin' }, { status: 500 })
    }
  }

  // ── FAMILYMEAL-SOURCED PERSON: DISCO ONLY (22 Oct 2026) ──────────────────
  // This used to PUT the name/email to FamilyMeal. Disco never writes changes
  // to FamilyMeal now (Peter), so: the location list goes to Disco (as it
  // already did), and the name lands on the person's Disco account when they
  // have one. FamilyMeal's record is left exactly as it is.
  try {
    const body = await req.json() as Record<string, unknown>
    const email = String(body?.email ?? '').trim().toLowerCase()
    if (!email) return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    const refs = Array.isArray(body.restaurantReferences)
      ? (body.restaurantReferences as unknown[]).map(String).filter(Boolean) : []
    if (refs.length) await writeDiscoLocationList(email, refs, await getAdminEmail().catch(() => null))
    const first = String(body?.firstName ?? '').trim()
    if (first) {
      await sql`
        UPDATE disco_restaurant_accounts SET first_name = ${first}, last_name = ${String(body?.lastName ?? '').trim() || null}, updated_at = NOW()
         WHERE lower(email) = ${email} AND archived_at IS NULL`
    }
    return NextResponse.json({ ok: true, locations: refs.length })
  } catch {
    return NextResponse.json({ error: 'Unable to update system admin' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { id: ref } = await params

  const native = discoEmail(ref)
  if (native) {
    // ARCHIVED, not deleted. The account is attached to orders, audit rows and
    // grants; removing the row would orphan all of it. Archiving is what the
    // rest of the app already treats as gone (the listing filters archived_at),
    // and it is reversible.
    try {
      const rows = (await sql`
        UPDATE disco_restaurant_accounts SET archived_at = NOW(), updated_at = NOW()
         WHERE lower(email) = ${native} AND archived_at IS NULL
         RETURNING email
      `) as Array<{ email: string }>
      if (!rows.length) return NextResponse.json({ error: 'System admin not found' }, { status: 404 })
      await sql`DELETE FROM disco_restaurant_location_access WHERE lower(account_email) = ${native}`
      return NextResponse.json({ ok: true, archived: true })
    } catch (e) {
      console.error('[admin/system-admins] native delete failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to delete' }, { status: 500 })
    }
  }

  // ── FAMILYMEAL-SOURCED PERSON: REMOVED FROM DISCO ONLY (22 Oct 2026) ───────
  // This used to DELETE the user in FamilyMeal. Disco never writes changes to
  // FamilyMeal now (Peter): the person's Disco location list is cleared and
  // their Disco account (if any) archived. Their email is looked up from FM's
  // list with a READ. FamilyMeal's own record is untouched.
  try {
    const res = await fetch(`${FM}/api/admin/users/system-admin?size=2000`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Could not look this person up' }, { status: 502 })
    const list = ((await res.json())?.content || []) as Array<{ reference?: string; email?: string }>
    const email = (list.find(a => a.reference === ref)?.email || '').trim().toLowerCase()
    if (!email) return NextResponse.json({ error: 'System admin not found' }, { status: 404 })
    await sql`DELETE FROM disco_restaurant_location_access WHERE lower(account_email) = ${email}`
    await sql`UPDATE disco_restaurant_accounts SET archived_at = NOW(), is_primary_system_admin = FALSE, updated_at = NOW() WHERE lower(email) = ${email} AND archived_at IS NULL`
    return NextResponse.json({ ok: true, removedFromDisco: true })
  } catch {
    return NextResponse.json({ error: 'Unable to delete' }, { status: 500 })
  }
}
