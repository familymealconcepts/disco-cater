import { sql } from './db'
import { syncAfterGrant } from './location-groups'
import type { RestaurantAuthContext } from './restaurant-auth-context'
import { resolveDiscoAccessScope, discoRefAllowed, type DiscoPermittedRefs } from './restaurant-write-scope'

/**
 * WHO MAY CHANGE WHOSE LOCATION LIST — the System Admin rules (Peter, 22 Oct 2026).
 *
 * Disco owns each System Admin's single location list
 * (disco_restaurant_location_access). These are the rules for changing it, and
 * every route that changes it calls this file rather than restating them:
 *
 *   1. ASSIGN — a System Admin can only assign locations they have themselves.
 *   2. REMOVE — a System Admin can remove locations from anyone they invited,
 *      and from anyone further down that chain, and only locations they have.
 *   3. NOBODY ADDS TO THEIR OWN LIST. Not through any route.
 *   4. ANYONE CAN CREATE A NEW LOCATION; it goes to the creator and the Primary
 *      (app/api/restaurant/locations POST — not here).
 *   5. ONLY A SUPER ADMIN CHANGES THE PRIMARY. A System Admin can never take
 *      locations away from a Primary either.
 *
 * A SUPER_ADMIN is unrestricted by 1 and 2, as everywhere else in the portal.
 *
 * "Invited by" is the PERSON's inviter: disco_restaurant_accounts.invited_by,
 * falling back to created_by when that holds an email (accounts invited from
 * the team screen before the column existed recorded the inviter there). The
 * sync sentinels in created_by ('fm-authorized-users-sync', etc.) are not
 * emails and never place anyone in a chain.
 */

export type Verdict = { ok: true } | { ok: false; status: number; error: string }

const lc = (s: string | null | undefined) => (s || '').trim().toLowerCase()

/** Everyone below `actorEmail` in the invite chain (lowercased emails). */
export async function invitedChain(actorEmail: string): Promise<Set<string>> {
  const actor = lc(actorEmail)
  if (!actor) return new Set()
  // UNION, not UNION ALL, so a cycle (A invited B, B re-invited A) terminates.
  const rows = (await sql`
    WITH RECURSIVE inviter AS (
      SELECT lower(email) AS email,
             lower(COALESCE(invited_by, CASE WHEN created_by LIKE '%@%' THEN created_by END)) AS by
        FROM disco_restaurant_accounts
       WHERE archived_at IS NULL
    ),
    chain AS (
      SELECT email FROM inviter WHERE by = ${actor} AND email <> ${actor}
      UNION
      SELECT i.email FROM inviter i JOIN chain c ON i.by = c.email WHERE i.email <> ${actor}
    )
    SELECT email FROM chain
  `) as Array<{ email: string }>
  return new Set(rows.map(r => r.email))
}

function actorRole(ctx: RestaurantAuthContext) {
  return (ctx.role || '').toUpperCase()
}

/** The actor's own list, role-gated. Throws on a DB error (never widens). */
export async function actorScope(ctx: RestaurantAuthContext): Promise<DiscoPermittedRefs> {
  return resolveDiscoAccessScope(ctx)
}

async function isPrimary(email: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM disco_restaurant_accounts
     WHERE lower(email) = ${lc(email)} AND is_primary_system_admin = TRUE AND archived_at IS NULL LIMIT 1
  `) as unknown[]
  return rows.length > 0
}

/**
 * May `ctx` add `refs` to `targetEmail`'s list?
 * Rules 1 and 3. No chain requirement: handing someone a location you hold is
 * always within your authority.
 */
export async function checkAssign(ctx: RestaurantAuthContext, targetEmail: string, refs: string[]): Promise<Verdict> {
  const role = actorRole(ctx)
  if (role !== 'SYSTEM_ADMIN' && role !== 'SUPER_ADMIN') {
    return { ok: false, status: 403, error: 'Only a System Admin can assign locations.' }
  }
  if (lc(targetEmail) && lc(targetEmail) === lc(ctx.email)) {
    return { ok: false, status: 403, error: 'You cannot add locations to your own list.' }
  }
  if (!refs.length) return { ok: true }
  const scope = await actorScope(ctx)
  const outside = refs.filter(r => !discoRefAllowed(scope, r))
  if (outside.length) {
    return { ok: false, status: 403, error: `You can only assign locations you have (${outside.length} ${outside.length === 1 ? 'is' : 'are'} not yours).` }
  }
  return { ok: true }
}

/**
 * May `ctx` remove `refs` from `targetEmail`'s list?
 * Rules 2, 3 and 5.
 */
export async function checkRemove(ctx: RestaurantAuthContext, targetEmail: string, refs: string[]): Promise<Verdict> {
  const role = actorRole(ctx)
  if (role === 'SUPER_ADMIN') return { ok: true }
  if (role !== 'SYSTEM_ADMIN') return { ok: false, status: 403, error: 'Only a System Admin can remove locations.' }
  const target = lc(targetEmail)
  if (!target) return { ok: false, status: 400, error: 'No user given.' }
  if (target === lc(ctx.email)) return { ok: false, status: 403, error: 'You cannot change your own list.' }
  // The chain and Primary checks run even for an empty `refs`: removing a
  // person outright (DELETE) passes whatever they hold, which can be nothing.
  if (await isPrimary(target)) {
    return { ok: false, status: 403, error: 'Only a Super Admin can change the Primary System Admin’s locations.' }
  }
  const chain = await invitedChain(ctx.email)
  if (!chain.has(target)) {
    return { ok: false, status: 403, error: 'You can only remove locations from people you invited, or people they invited.' }
  }
  if (!refs.length) return { ok: true }
  const scope = await actorScope(ctx)
  const outside = refs.filter(r => !discoRefAllowed(scope, r))
  if (outside.length) {
    return { ok: false, status: 403, error: `You can only remove locations you have (${outside.length} ${outside.length === 1 ? 'is' : 'are'} not yours).` }
  }
  return { ok: true }
}

/** Current list for an email (grant rows), lowercased match. */
export async function currentList(email: string): Promise<string[]> {
  const rows = (await sql`
    SELECT restaurant_reference::text AS ref FROM disco_restaurant_location_access
     WHERE lower(account_email) = ${lc(email)} ORDER BY id ASC
  `) as Array<{ ref: string }>
  return rows.map(r => r.ref)
}

/** Split a desired list against the current one. */
export function diffLists(current: string[], desired: string[]) {
  const cur = new Set(current), want = new Set(desired)
  return {
    added: [...want].filter(r => !cur.has(r)),
    removed: [...cur].filter(r => !want.has(r)),
  }
}

/**
 * The person's anchor (where they land on login) must stay on their list. When
 * the anchor was removed, it moves to the first remaining location. With nothing
 * remaining it is left alone: the session gate (validateDiscoRestaurantSession)
 * refuses a System Admin whose session location is not on their list, so an
 * empty list means no portal access rather than a lingering one.
 */
export async function realignAnchor(email: string): Promise<void> {
  const rows = (await sql`
    SELECT restaurant_reference AS anchor, role FROM disco_restaurant_accounts
     WHERE lower(email) = ${lc(email)} AND archived_at IS NULL LIMIT 1
  `) as Array<{ anchor: string | null; role: string | null }>
  const acct = rows[0]
  if (!acct || (acct.role || '').toUpperCase() !== 'SYSTEM_ADMIN') return
  const list = await currentList(email)
  if (!list.length || (acct.anchor && list.includes(acct.anchor))) return
  await sql`
    UPDATE disco_restaurant_accounts SET restaurant_reference = ${list[0]}, updated_at = NOW()
     WHERE lower(email) = ${lc(email)}
  `
}

/**
 * Apply an add/remove to one person's list in ONE statement (neon HTTP has no
 * transactions; a data-modifying CTE lands both halves or neither).
 */
export async function applyListChange(email: string, added: string[], removed: string[], actor: string | null) {
  const e = lc(email)
  const res = (await sql`
    WITH removed AS (
      DELETE FROM disco_restaurant_location_access
       WHERE lower(account_email) = ${e} AND restaurant_reference = ANY(${removed}::text[])
      RETURNING 1
    ),
    added AS (
      INSERT INTO disco_restaurant_location_access (account_email, restaurant_reference, granted_by)
      SELECT ${e}, r, ${actor} FROM unnest(${added}::text[]) AS r
      ON CONFLICT (account_email, restaurant_reference) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT COUNT(*)::int FROM removed) AS removed, (SELECT COUNT(*)::int FROM added) AS added
  `) as Array<{ removed: number; added: number }>
  await realignAnchor(e)
  // Group rules: the group's Primary and copies follow every addition.
  if (added.length) await syncAfterGrant(e, added)
  return res[0] ?? { removed: 0, added: 0 }
}

/**
 * The Primary(ies) a new location should also go to: every Primary System Admin
 * whose list shares at least one location with the creator's. A Primary holds
 * every location in their group, so sharing one means it is the same business.
 * The creator themselves is excluded (a Primary creating is already the
 * creator). A group with no Primary (the Happys/Savvy co-brand, by decision)
 * yields none.
 */
export async function primariesFor(creatorEmail: string): Promise<string[]> {
  const e = lc(creatorEmail)
  const rows = (await sql`
    SELECT DISTINCT lower(a.email) AS email
      FROM disco_restaurant_accounts a
      JOIN disco_restaurant_location_access pg ON lower(pg.account_email) = lower(a.email)
      JOIN disco_restaurant_location_access mine
        ON mine.restaurant_reference = pg.restaurant_reference AND lower(mine.account_email) = ${e}
     WHERE a.is_primary_system_admin = TRUE AND a.archived_at IS NULL AND lower(a.email) <> ${e}
  `) as Array<{ email: string }>
  return rows.map(r => r.email)
}
