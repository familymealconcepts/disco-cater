// May this caller change the branding on THIS multi-unit link?
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The gradient and image routes gated on getRestaurantAuthHeader() alone, which
// only asks "is there a FamilyMeal cookie" — it never asked WHICH link. Both
// take the link's `slug` from the request body, so any authenticated restaurant
// session could set the header gradient or image on ANY chain's /locations page
// by naming its slug. That is a cross-tenant write, and it has been open since
// those routes shipped.
//
// It also had a second consequence: because the gate was an FM header, a staff
// member holding a Disco Cater password could not brand their OWN link. Neither
// route calls FamilyMeal at all — they write Neon through
// lib/location-links.ts — so the FM token was never needed for the work, only
// as a proxy for "logged in".
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// A caller may brand a link if they can reach at least one restaurant that is a
// MEMBER of it. Membership comes from disco_multi_unit_link_members, which is
// FamilyMeal's own grouping mirrored at conversion (see ensureMultiUnitLink).
//
// Reach is resolved per session type and never guessed:
//   * Disco session — resolveDiscoAccessScope, the role-gated grant lookup. An
//     ADMIN gets their own location regardless of how many grant rows exist; a
//     SYSTEM_ADMIN gets exactly their granted set.
//   * FamilyMeal session — FamilyMeal's own answer for that token
//     (getFmSystemAdminPermittedRefs) plus the JWT's home restaurant. Nothing is
//     inherited from Disco for an FM session, which has no Disco identity.
//
// ── FAILS CLOSED ────────────────────────────────────────────────────────────
// A scope that cannot be established is NOT an empty scope and NOT a wide one —
// it is a refusal. resolveDiscoAccessScope deliberately lets its lookup failure
// propagate rather than narrowing to home-only, and this function turns any
// throw into `false`. The caller returns 403 and writes nothing.
import { sql } from '../db'
import { resolveDiscoAccessScope } from '../restaurant-write-scope'
import { getFmSystemAdminPermittedRefs, getRestaurantRef, RESTAURANT_TOKEN_COOKIE } from '../restaurant-auth'
import type { RestaurantAuthContext } from '../restaurant-auth-context'
import { cookies } from 'next/headers'

export interface LinkBrandingDecision {
  allowed: boolean
  /** Safe to return to the caller; never names a restaurant they cannot see. */
  reason: string
}

/** The restaurant references that are members of this link. */
async function linkMembers(slug: string): Promise<string[]> {
  const rows = (await sql`
    SELECT m.restaurant_reference::text AS ref
      FROM disco_multi_unit_links k
      JOIN disco_multi_unit_link_members m ON m.link_reference = k.reference
     WHERE k.slug = ${slug}
  `) as { ref: string }[]
  return rows.map(r => r.ref)
}

export async function canBrandLink(ctx: RestaurantAuthContext | null, slug: string): Promise<LinkBrandingDecision> {
  if (!ctx) return { allowed: false, reason: 'Not authenticated.' }
  const target = (slug || '').trim()
  if (!target) return { allowed: false, reason: 'slug is required.' }

  let members: string[]
  try {
    members = await linkMembers(target)
  } catch {
    return { allowed: false, reason: 'Could not establish who this page belongs to. Nothing was changed.' }
  }
  // An unknown slug is refused rather than created — branding is an edit to an
  // existing page, and accepting an unknown one would let a caller seed a row
  // for a chain that does not exist.
  if (!members.length) return { allowed: false, reason: 'No locations page with that address.' }

  try {
    if (ctx.authType === 'disco') {
      const scope = await resolveDiscoAccessScope(ctx)
      if (scope.unrestricted) return { allowed: true, reason: 'super-admin' }
      const hit = members.some(m => scope.refs.has(m))
      return hit
        ? { allowed: true, reason: 'member' }
        : { allowed: false, reason: 'This locations page belongs to a different restaurant group.' }
    }

    // FamilyMeal session: FamilyMeal's answer for THIS token, plus its home.
    const token = (await cookies()).get(RESTAURANT_TOKEN_COOKIE)?.value || ''
    if (!token) return { allowed: false, reason: 'Not authenticated.' }
    const permitted = new Set<string>(await getFmSystemAdminPermittedRefs(token))
    const home = (await getRestaurantRef()) || ''
    if (home) permitted.add(home)
    if (!permitted.size) {
      return { allowed: false, reason: 'Could not establish which restaurants you manage. Nothing was changed.' }
    }
    const hit = members.some(m => permitted.has(m))
    return hit
      ? { allowed: true, reason: 'member' }
      : { allowed: false, reason: 'This locations page belongs to a different restaurant group.' }
  } catch {
    // Scope could not be resolved. Refuse — never fall back to a wider reach.
    return { allowed: false, reason: 'Could not establish which restaurants you manage. Nothing was changed.' }
  }
}
