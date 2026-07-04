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

// All links owned by an SA (FM lists by userReference + urlFrom='Links').
export async function listNativeLinks(ownerEmail: string): Promise<NativeLinkRow[]> {
  await ensureMultiUnitTables()
  const links = (await sql`
    SELECT reference, slug, title FROM disco_multi_unit_links
    WHERE owner_email = ${ownerEmail} ORDER BY created_at DESC, id DESC
  `) as { reference: string; slug: string; title: string }[]
  const out: NativeLinkRow[] = []
  for (const l of links) {
    const refs = await membersOf(l.reference)
    out.push({ reference: l.reference, url: l.slug, header: l.title, numberOfLocations: refs.length, restaurantReferences: refs, urlFrom: 'Links' })
  }
  return out
}

export async function createNativeLink(input: { slug: string; title: string; ownerEmail: string; memberRefs: string[] }): Promise<{ reference: string }> {
  await ensureMultiUnitTables()
  const rows = (await sql`
    INSERT INTO disco_multi_unit_links (slug, title, owner_email) VALUES (${input.slug}, ${input.title}, ${input.ownerEmail})
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
