// Native (zero-FM) Multi-Unit Links for Disco-native SYSTEM_ADMINs. A link is one
// shareable /locations/{slug} URL that lists a group of the SA's locations (grouped
// by state) for the customer to pick from. FM-backed restaurants keep the FM path;
// disco sessions use this Neon store exclusively. Membership + slug-uniqueness +
// the public grouping all live here — no FM.

import { sql } from './db'

export interface NativeLinkRow {
  reference: string
  url: string                 // slug (FM field name is `url`)
  header: string              // title
  numberOfLocations: number
  restaurantReferences: string[]
  urlFrom: 'Links'
  /** Who created this link. Email is the identity; name is for display only. */
  createdByEmail: string | null
  /**
   * Resolved from disco_restaurant_accounts.first_name/last_name for the creator's
   * email, falling back to the email itself. Internal accounts (peter@familymeal.com)
   * have no disco_restaurant_accounts row at all — there is no other user table in
   * this database — so they display as the address, which is still an answer to
   * "who do I ask".
   */
  createdByName: string | null
  /** Whether THIS viewer may edit it. See linkEditDecision for the two rules. */
  canEdit: boolean
  /** True when a conversion created this link rather than a person. */
  createdByConversion: boolean
}

let ensured = false
// Idempotent schema bootstrap (mirrors lib/location-links.ts ensureTable pattern).
export async function ensureMultiUnitTables(): Promise<void> {
  if (ensured) return
  await sql`
    CREATE TABLE IF NOT EXISTS disco_multi_unit_links (
      id SERIAL PRIMARY KEY,
      reference UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
      slug VARCHAR(120) NOT NULL,
      title VARCHAR(500) NOT NULL,
      owner_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_disco_mul_slug_ci ON disco_multi_unit_links (LOWER(slug))`
  await sql`
    CREATE TABLE IF NOT EXISTS disco_multi_unit_link_members (
      link_reference UUID NOT NULL REFERENCES disco_multi_unit_links(reference) ON DELETE CASCADE,
      restaurant_reference TEXT NOT NULL,
      PRIMARY KEY (link_reference, restaurant_reference)
    )`
  // ── WHO AUTHORED THIS LINK ─────────────────────────────────────────────────
  // Creator-edit is the right rule for something a PERSON authored. A conversion
  // link had no author — a script made it while converting a restaurant, and
  // stamped whoever happened to be running the conversion as its owner. Locking
  // those to that "creator" would mean an internal account owns 22 of 25 links
  // and the restaurants whose locations are in them cannot touch their own page.
  //
  // So the two kinds are marked apart and gated differently:
  //   created_by_conversion = true   -> REACH-edit: any system admin who can
  //                                     reach a member may change it.
  //   created_by_conversion = false  -> CREATOR-edit: only the person who made it.
  //
  // This is a statement about PROVENANCE, not about permission, which is why it
  // is a column rather than a rule inferred from owner_email at read time.
  await sql`ALTER TABLE disco_multi_unit_links ADD COLUMN IF NOT EXISTS created_by_conversion BOOLEAN NOT NULL DEFAULT false`
  ensured = true
}

// Case-insensitive slug uniqueness (excluding one link on edit).
export async function slugTaken(slug: string, exceptRef?: string): Promise<boolean> {
  await ensureMultiUnitTables()
  const rows = (await sql`
    SELECT 1 FROM disco_multi_unit_links
    WHERE LOWER(slug) = LOWER(${slug}) AND (${exceptRef ?? null}::uuid IS NULL OR reference <> ${exceptRef ?? null}::uuid)
    LIMIT 1
  `) as unknown[]
  return rows.length > 0
}

/**
 * Display name for a link's creator. Resolved from the restaurant-accounts table,
 * which is the only place in this database that holds a person's name against an
 * email. Falls back to the email when there is no row — internal/super-admin
 * accounts do not have one, and an address still tells you who to ask.
 */
export async function resolveCreatorName(email: string | null): Promise<string | null> {
  if (!email) return null
  const rows = (await sql`
    SELECT first_name, last_name FROM disco_restaurant_accounts WHERE email = ${email} LIMIT 1
  `.catch(() => [])) as { first_name: string | null; last_name: string | null }[]
  const n = [rows[0]?.first_name, rows[0]?.last_name].filter(Boolean).join(' ').trim()
  return n || email
}

async function membersOf(reference: string): Promise<string[]> {
  const rows = (await sql`SELECT restaurant_reference FROM disco_multi_unit_link_members WHERE link_reference = ${reference}::uuid ORDER BY restaurant_reference`) as { restaurant_reference: string }[]
  return rows.map(r => r.restaurant_reference)
}

async function setMembers(reference: string, memberRefs: string[]): Promise<void> {
  await sql`DELETE FROM disco_multi_unit_link_members WHERE link_reference = ${reference}::uuid`
  const uniq = [...new Set(memberRefs.filter(Boolean))]
  for (const r of uniq) {
    await sql`INSERT INTO disco_multi_unit_link_members (link_reference, restaurant_reference) VALUES (${reference}::uuid, ${r}) ON CONFLICT DO NOTHING`
  }
}

/**
 * Links the viewer can REACH — the ones with at least one member location the
 * viewer has access to.
 *
 * THIS REPLACED OWNERSHIP AS THE LISTING RULE, and the distinction is the whole
 * bug. listNativeLinks (below) filters on `owner_email = the viewer`, which asks
 * "did you create this link", not "does this link describe locations you run".
 * Those are different questions and the first one is almost never true for the
 * person who needs the answer: a link is created by whoever ran the conversion,
 * so it belongs to an internal account, while the people who need to share the
 * page are the restaurant's own staff.
 *
 * Measured before the fix: 22 of 25 links fleet-wide — covering 185 restaurant
 * memberships — were owned by peter@familymeal.com and therefore invisible to
 * every single person who could reach their locations. EggBred's six
 * SYSTEM_ADMINs each reach 18 locations and saw "No links yet" on a page whose
 * link holds all 19 of them.
 *
 * The three that DID work (Atlanta Bread, Gracious, Two Hands) worked only
 * because someone had hand-edited owner_email on those rows. That is a data
 * workaround for a code bug, it fixes one restaurant at a time, and it is not
 * repeated here — ownership is left exactly as it is on all 25 rows.
 *
 * SCOPE COMES FROM THE CALLER, already role-gated: a SUPER_ADMIN is
 * unrestricted, a SYSTEM_ADMIN reaches its granted locations, and anyone else
 * reaches its anchor only — regardless of how many grant rows happen to exist.
 * That gate lives in resolveDiscoAccessScope and is not re-implemented here.
 *
 * A viewer must never see a link for locations they cannot reach, so a link with
 * no intersecting member is excluded outright rather than returned empty.
 */
export async function listReachableNativeLinks(
  scope: { unrestricted: boolean; refs: Set<string> },
  viewer?: { email: string | null; isSuperAdmin?: boolean },
): Promise<NativeLinkRow[]> {
  await ensureMultiUnitTables()
  if (!scope.unrestricted && scope.refs.size === 0) return []

  const links = (await sql`
    SELECT reference, slug, title, owner_email, created_by_conversion
      FROM disco_multi_unit_links ORDER BY created_at DESC, id DESC
  `) as { reference: string; slug: string; title: string; owner_email: string | null; created_by_conversion: boolean }[]

  const nameCache = new Map<string, string | null>()
  const out: NativeLinkRow[] = []
  for (const l of links) {
    const refs = await membersOf(l.reference)
    // Intersection, not containment: a SYSTEM_ADMIN who reaches 18 of a chain's
    // 19 locations still needs that chain's link. SEEING IS SHARED — this rule is
    // unchanged; only editing is narrowed to the creator.
    if (!scope.unrestricted && !refs.some(r => scope.refs.has(r))) continue
    const owner = l.owner_email ?? null
    if (owner && !nameCache.has(owner)) nameCache.set(owner, await resolveCreatorName(owner))
    out.push({
      reference: l.reference, url: l.slug, header: l.title,
      numberOfLocations: refs.length, restaurantReferences: refs, urlFrom: 'Links',
      createdByEmail: owner,
      createdByName: owner ? (nameCache.get(owner) ?? owner) : null,
      createdByConversion: l.created_by_conversion === true,
      // Computed server-side through the SAME helper the API gates use, so the
      // button a viewer sees and the answer PUT gives cannot disagree.
      canEdit: linkEditDecision({
        isSuperAdmin: !!viewer?.isSuperAdmin,
        viewerEmail: viewer?.email ?? null,
        ownerEmail: owner,
        createdByConversion: l.created_by_conversion === true,
        // Reaching a member is already true here — an unreachable link was skipped above.
        reachesAMember: true,
      }).allowed,
    })
  }
  return out
}

// listNativeLinks was REMOVED here. It listed links by `owner_email = the viewer`,
// which was the listing bug: a link is created by whoever ran the conversion, so
// ownership answers "did you make this", not "does this describe locations you
// run". Its last caller went away when the tab moved to reach-scoping, and a dead
// ownership-based lister is exactly the thing someone reinstates by accident.
// Ownership still decides EDITING — see linkCreator / the route's creator gate.

export async function createNativeLink(input: { slug: string; title: string; ownerEmail: string; memberRefs: string[]; createdByConversion?: boolean }): Promise<{ reference: string }> {
  await ensureMultiUnitTables()
  const rows = (await sql`
    INSERT INTO disco_multi_unit_links (slug, title, owner_email, created_by_conversion) VALUES (${input.slug}, ${input.title}, ${input.ownerEmail}, ${input.createdByConversion === true})
    RETURNING reference
  `) as { reference: string }[]
  const reference = rows[0].reference
  await setMembers(reference, input.memberRefs)
  return { reference }
}

export async function updateNativeLink(reference: string, input: { slug: string; title: string; memberRefs: string[] }): Promise<boolean> {
  await ensureMultiUnitTables()
  const rows = (await sql`
    UPDATE disco_multi_unit_links SET slug = ${input.slug}, title = ${input.title}, updated_at = NOW()
    WHERE reference = ${reference}::uuid RETURNING reference
  `) as { reference: string }[]
  if (!rows.length) return false
  await setMembers(reference, input.memberRefs)
  return true
}

export async function deleteNativeLink(reference: string): Promise<boolean> {
  await ensureMultiUnitTables()
  const rows = (await sql`DELETE FROM disco_multi_unit_links WHERE reference = ${reference}::uuid RETURNING reference`) as { reference: string }[]
  return rows.length > 0
}

export interface NativeLinkResolved {
  reference: string
  slug: string
  title: string
  memberRefs: string[]
}

// Resolve a slug to a native link (customer page + live-count). null if not native.
export async function getNativeLinkBySlug(slug: string): Promise<NativeLinkResolved | null> {
  try {
    await ensureMultiUnitTables()
    const rows = (await sql`SELECT reference, slug, title FROM disco_multi_unit_links WHERE LOWER(slug) = LOWER(${slug}) LIMIT 1`) as { reference: string; slug: string; title: string }[]
    if (!rows.length) return null
    const l = rows[0]
    return { reference: l.reference, slug: l.slug, title: l.title, memberRefs: await membersOf(l.reference) }
  } catch { return null }
}

// Owner of a link (for the edit/delete group guard).
export async function linkOwnerEmail(reference: string): Promise<string | null> {
  await ensureMultiUnitTables()
  const rows = (await sql`SELECT owner_email FROM disco_multi_unit_links WHERE reference = ${reference}::uuid LIMIT 1`) as { owner_email: string | null }[]
  return rows.length ? (rows[0].owner_email ?? null) : null
}

/**
 * Does this link exist natively? The branch for "what the link IS", used instead
 * of "how the caller logged in" — see the route.
 */
export async function nativeLinkExists(reference: string): Promise<boolean> {
  await ensureMultiUnitTables()
  const rows = (await sql`SELECT 1 FROM disco_multi_unit_links WHERE reference = ${reference}::uuid LIMIT 1`) as unknown[]
  return rows.length > 0
}

/** The member references of a link, for reach checks. */
export async function linkMemberRefs(reference: string): Promise<string[]> {
  await ensureMultiUnitTables()
  return membersOf(reference)
}

/**
 * May this viewer edit this link, and which of its members are theirs to change?
 *
 * REACH, NOT OWNERSHIP. Editing used to require `owner_email === the viewer`, and
 * owner_email is whoever ran the conversion — an internal account on 22 of 25
 * links. So a system admin could SEE their chain's link (fixed earlier) and still
 * get a 404 trying to rename or re-scope it. Reassigning owner_email by hand, as
 * was done for Atlanta Bread, Gracious and Two Hands, fixes one row and leaves
 * the next conversion broken; it is not the fix.
 *
 * THE PARTIAL-REACH RULE, which is the interesting case:
 *
 *   * A viewer may edit a link if they can reach AT LEAST ONE member. That
 *     matches the listing rule, so anything visible is editable and there is no
 *     second, invisible tier of permission to explain.
 *
 *   * They may only ADD locations they can reach — enforced by filtering the
 *     submitted set.
 *
 *   * Members they CANNOT reach are PRESERVED, never removed, even if the
 *     submitted set omits them. This is the load-bearing half. Without it, a
 *     system admin who reaches 2 of a 19-location link could submit their 2 and
 *     silently drop the other 17 from a public page they mostly do not run — the
 *     same destructive shape as the FM re-sync this work removed, just with a
 *     human pulling the trigger.
 *
 * So a partial-reach editor curates their own slice and cannot touch anyone
 * else's. A full-reach editor is unaffected: nothing is outside their reach, so
 * nothing is preserved against their wishes.
 */
export interface LinkEditScope {
  allowed: boolean
  /** Existing members outside the viewer's reach — always retained on write. */
  retained: string[]
}

/**
 * Who created this link, with a display name. The identity is the EMAIL; the name
 * is only for telling a viewer who to ask.
 */
export async function linkCreator(
  reference: string,
): Promise<{ email: string | null; name: string | null; createdByConversion: boolean } | null> {
  await ensureMultiUnitTables()
  const rows = (await sql`
    SELECT owner_email, created_by_conversion FROM disco_multi_unit_links WHERE reference = ${reference}::uuid LIMIT 1
  `) as { owner_email: string | null; created_by_conversion: boolean }[]
  if (!rows.length) return null
  const email = rows[0].owner_email ?? null
  return { email, name: await resolveCreatorName(email), createdByConversion: rows[0].created_by_conversion === true }
}

/**
 * THE ONE PLACE THAT DECIDES WHO MAY CHANGE A LINK. Both the API gates and the
 * `canEdit` flag the Links tab renders come through here, so the button a viewer
 * sees and the answer PUT gives cannot disagree.
 *
 *   SUPER_ADMIN            — always. Support must be able to fix any link, and a
 *                            support case must never be blocked because a
 *                            restaurant's system admin created it.
 *   conversion-created     — REACH: any system admin who reaches a member. Nobody
 *                            authored these; a script did. Reach is the honest
 *                            rule, and it is the only one that covers the five
 *                            links with no system admin at all (eggstasy,
 *                            smackbird, stacksncordials, tap42,
 *                            winfieldstreetcoffee) without inventing an owner.
 *   person-created         — CREATOR: only the person who made it. A link is one
 *                            shared public page; two admins curating it against
 *                            each other is worse than one owner and a conversation.
 *
 * Reach still BOUNDS what any of them may do — see resolveLinkEditScope — it just
 * no longer decides who may act on a person-created link.
 */
export function linkEditDecision(input: {
  isSuperAdmin: boolean
  viewerEmail: string | null
  ownerEmail: string | null
  createdByConversion: boolean
  reachesAMember: boolean
}): { allowed: boolean; rule: 'super-admin' | 'conversion-reach' | 'creator' } {
  if (input.isSuperAdmin) return { allowed: true, rule: 'super-admin' }
  if (input.createdByConversion) return { allowed: input.reachesAMember, rule: 'conversion-reach' }
  return { allowed: !!input.viewerEmail && !!input.ownerEmail && input.viewerEmail === input.ownerEmail, rule: 'creator' }
}

export async function resolveLinkEditScope(
  reference: string,
  scope: { unrestricted: boolean; refs: Set<string> },
): Promise<LinkEditScope> {
  const members = await membersOf(reference)
  if (scope.unrestricted) return { allowed: true, retained: [] }
  const reachable = members.filter(r => scope.refs.has(r))
  return { allowed: reachable.length > 0, retained: members.filter(r => !scope.refs.has(r)) }
}
