/**
 * The multi-unit link step of a Tier 1 conversion — upsert-and-grow.
 *
 * Runs once per converting location. If the chain has no native link yet it
 * creates one holding just this location; if it already has one it adds this
 * location. It NEVER removes a member, which is what makes a chain converting
 * over several days safe: each conversion grows the link by one and no later
 * run can shrink what an earlier one recorded.
 *
 * MEMBERSHIP IS THE CONVERTED SET, NOT FM'S GROUP. FM's group is advisory: it
 * is used to verify that a candidate slug really belongs to this chain, and to
 * report a divergence. It is never the authority on who belongs. FM's group
 * both over-reports and under-reports — it listed 4 of Two Hands' 8, and it
 * lists 10 for Savvy Sliders where we are converting 5 — and after conversion a
 * difference from FM is a decision, not drift.
 */
import { randomUUID } from 'crypto'
import { sql } from '../db'
import { fetchFmLinkMeta, rehostFmBanner } from './fm-banner'
import { upsertLocationLink, upsertLocationLinkImage } from '../location-links'
import { getLocationLink } from '../locations'
import { readChainGroupAsAdmin } from '../fm-master-admin-read'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const PROBE_TIMEOUT_MS = 8000

export type MultiUnitLinkOutcome =
  | { status: 'created'; slug: string; linkReference: string; title: string; members: number; banner: BannerReport; divergence: Divergence }
  | { status: 'grown'; slug: string; linkReference: string; title: string; members: number; banner: BannerReport; divergence: Divergence }
  | { status: 'already-member'; slug: string; linkReference: string; members: number }
  | { status: 'not-a-chain'; detail: string }
  | { status: 'not-converted'; detail: string }
  | { status: 'needs-slug'; detail: string; candidatesTried: string[] }
  | { status: 'failed'; detail: string }

export type BannerReport =
  | { state: 'rehosted'; url: string }
  | { state: 'no-banner-on-fm' }
  | { state: 'reused-existing'; url: string }
  | { state: 'failed'; reason: string }

/** FM's group vs the set we actually converted. Recorded, never acted on. */
export interface Divergence {
  fmGroupSize: number
  convertedMembers: number
  inFmNotConverted: number
  convertedNotInFm: number
  note: string | null
}

async function fmGroupRefs(slug: string): Promise<string[] | null> {
  try {
    const r = await fetch(`${FM}/public-api/restaurants/group/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' }, cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!r.ok) return null
    const d = (await r.json().catch(() => null)) as { restaurants?: { reference?: string }[] }[] | null
    if (!Array.isArray(d)) return null
    const out: string[] = []
    for (const g of d) for (const x of (g?.restaurants || [])) if (x?.reference) out.push(x.reference)
    return out
  } catch { return null }
}

/**
 * Candidate slugs, cheapest and most-likely first.
 *
 * The slugs disco_location_links already mirrors are real slugs FM is known to
 * serve, so they are evidence rather than guesses. Name-derived forms come
 * after, for a chain not yet mirrored. The group slug is NOT derivable from a
 * location slug — Gracious's locations are graciousbakerycafe-gardendistrict
 * and graciousbakery-uptown while the group is graciousbakery — so the mirror
 * is what makes the probe work at all.
 */
export async function slugCandidates(restaurantName: string | null): Promise<string[]> {
  // Split on hyphen, EN DASH and EM DASH. Not cosmetic: "Almost Home \u2013 Lincroft"
  // uses an en dash, and splitting on ' - ' alone leaves the location in the
  // chain name and derives the nonsense candidate `almosthomelincroft`.
  const chain = (restaurantName || '').split(/\s[-\u2013\u2014]\s/)[0].trim().toLowerCase().replace(/&/g, 'and')
  const alnum = chain.replace(/[^a-z0-9]+/g, '')
  const hyphen = chain.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const noStop = chain.replace(/\b(the|a|an)\b/g, '').replace(/[^a-z0-9]+/g, '')
  const mirrored = (await sql`SELECT DISTINCT slug FROM disco_location_links WHERE slug IS NOT NULL`
    .catch(() => [])) as { slug: string }[]
  // Match in BOTH directions. A group slug is routinely shorter than the
  // business name — Gracious Bakery & Cafe normalizes to `graciousbakerycafe`
  // but its group is `graciousbakery` — so requiring the mirrored slug to start
  // with the normalized name misses exactly the case the mirror exists for.
  // The 6-character floor keeps a short slug from matching half the fleet.
  const mirrorHits = mirrored.map(r => r.slug).filter(s =>
    alnum && s.length >= 6 && (s === alnum || s.startsWith(alnum) || alnum.startsWith(s)))
  // The first word alone. FM's group slug is often the brand without the
  // category word — SmackBird Chicken's group is `smackbird`, Hearthly Burger's
  // is `hearthly` — so dropping this candidate loses real chains. Guarded at 5
  // characters so a short first word cannot collide with an unrelated slug;
  // membership verification is what makes a wrong candidate harmless anyway.
  const firstWord = chain.split(/[^a-z0-9]+/).filter(Boolean)[0] ?? ''
  const first = firstWord.length >= 5 ? firstWord : ''
  return [...new Set([...mirrorHits, alnum, hyphen, noStop, first].filter(s => s && s.length > 2))]
}

/**
 * Resolve the chain's FM group slug for THIS restaurant.
 *
 * A candidate is accepted ONLY IF FM's group for it contains this restaurant's
 * own reference. Zero overlap REFUSES rather than guessing, and that branch is
 * the important one: "Almost Home" matches the slug `almosthome`, which returns
 * three restaurants and contains ours zero times — a different business
 * entirely. A 200 for someone else's slug is a wrong answer that looks like a
 * right one, and taking it would publish a page linking a stranger's locations.
 */
export async function resolveChainSlug(ref: string, restaurantName: string | null): Promise<
  { slug: string; fmRefs: string[]; source: 'admin-group' | 'name-probe' } | { slug: null; candidatesTried: string[] }
> {
  // PRIMARY: ask FM as one of the chain's own admins. This is a lookup, not a
  // guess — it returns the group's real slug and its full membership, including
  // slugs no candidate generator would produce (`plumcaterers` for The Tattooed
  // Pig, `metairie` for Fat Boy's Pizza). It also returns membership the public
  // endpoint omits: 8 for Two Hands where the public group says 4.
  //
  // It needs a SYSTEM_ADMIN, and plenty of single-brand chains only have plain
  // ADMINs (all three Botte locations, for one), so the probe stays as the
  // fallback rather than being deleted.
  const viaAdmin = await readChainGroupAsAdmin(ref).catch(() => null)
  if (viaAdmin?.ok && viaAdmin.slug && viaAdmin.restaurantReferences.includes(ref)) {
    return { slug: viaAdmin.slug, fmRefs: viaAdmin.restaurantReferences, source: 'admin-group' }
  }

  const candidates = await slugCandidates(restaurantName)
  for (const slug of candidates) {
    const refs = await fmGroupRefs(slug)
    if (refs && refs.includes(ref)) return { slug, fmRefs: refs, source: 'name-probe' }
  }
  return { slug: null, candidatesTried: candidates }
}

/**
 * Re-host FM's banner to Blob and prove it landed.
 *
 * BOTH WRITES, THEN A READ-BACK. upsertLocationLink deliberately does not touch
 * image_url on conflict (FM's save response carries no image, so updating there
 * would wipe the blob URL on every re-save), and cacheAutoGradient may already
 * have inserted a row for this slug. So the first write alone silently drops
 * the banner — that is exactly what happened to Gracious and to Two Hands. The
 * read-back turns a silent no-op into a reported failure.
 */
async function attachBanner(slug: string, title: string, ref: string): Promise<BannerReport> {
  const existing = await getLocationLink(slug).catch(() => null)
  if (existing?.image && !existing.image.includes('familymeal.com')) {
    return { state: 'reused-existing', url: existing.image }
  }
  const meta = await fetchFmLinkMeta(slug)
  if (!meta.imageReference) return { state: 'no-banner-on-fm' }

  const outcome = await rehostFmBanner(meta.imageReference)
  if (!outcome.ok) return { state: 'failed', reason: outcome.reason }

  await upsertLocationLink({ slug, title, imageUrl: outcome.url, restaurantReference: ref })
  await upsertLocationLinkImage(slug, outcome.url)

  const after = await getLocationLink(slug).catch(() => null)
  if (after?.image !== outcome.url) {
    return { state: 'failed', reason: `read-back mismatch: expected the blob URL, link still has ${after?.image ?? 'null'}` }
  }
  if (after.image.includes('familymeal.com')) {
    return { state: 'failed', reason: 'read-back shows an FM URL — the banner is hotlinked, not re-hosted' }
  }
  return { state: 'rehosted', url: outcome.url }
}

function describeDivergence(fmRefs: string[], memberRefs: string[]): Divergence {
  const fm = new Set(fmRefs), mine = new Set(memberRefs)
  const inFmNotConverted = [...fm].filter(r => !mine.has(r)).length
  const convertedNotInFm = [...mine].filter(r => !fm.has(r)).length
  let note: string | null = null
  if (convertedNotInFm > 0) {
    note = `FM's group omits ${convertedNotInFm} converted location(s). The link is right and FM is stale — do not reduce it to FM's list.`
  } else if (inFmNotConverted > 0) {
    note = `FM lists ${inFmNotConverted} location(s) not yet converted. Expected mid-conversion; they join as they convert.`
  }
  return { fmGroupSize: fmRefs.length, convertedMembers: memberRefs.length, inFmNotConverted, convertedNotInFm, note }
}

/**
 * The step itself. Idempotent: running it twice for the same restaurant reports
 * `already-member` and writes nothing.
 */
export async function ensureMultiUnitLink(
  ref: string,
  restaurantName: string | null,
  opts?: { ownerEmail?: string | null; slug?: string | null },
): Promise<MultiUnitLinkOutcome> {
  try {
    // HARD GUARD: never link a restaurant that has not been flipped yet.
    // The step is documented as running after the flip, but documentation is
    // not enforcement. Calling this against an unconverted restaurant during
    // verification created a real, live /locations page holding one unconverted
    // location whose Order button could not have taken an order. The link is
    // customer-facing, so this refuses rather than trusting its caller.
    const nativeRow = (await sql`
      SELECT COALESCE(is_disco_native, false) AS native FROM disco_restaurant_cache
      WHERE restaurant_reference = ${ref} LIMIT 1
    `) as { native: boolean }[]
    if (!nativeRow.length) return { status: 'failed', detail: 'Restaurant not in the cache.' }
    if (!nativeRow[0].native) {
      return { status: 'not-converted', detail: 'Restaurant is not Disco-native yet — the link step runs after the flip, never before.' }
    }

    // AN OPERATOR-SUPPLIED SLUG WINS, and is not required to appear in FM's
    // group. This is the case the probe cannot serve: FM's group under-reports,
    // so the locations FM omits can never verify themselves. Two Hands is the
    // worked example — FM listed 4 of 8, and the other 4 would refuse forever.
    // Sweet Chick has the same shape (FM lists 2 of 5). When Peter supplies
    // membership directly, that IS the authority; FM is not consulted for it.
    const resolved: { slug: string | null; fmRefs?: string[]; source?: string; candidatesTried?: string[] } = opts?.slug
      ? { slug: opts.slug, fmRefs: (await fmGroupRefs(opts.slug)) ?? [], source: 'operator' }
      : await resolveChainSlug(ref, restaurantName)
    if (resolved.slug === null) {
      return {
        status: 'needs-slug',
        detail: `No FM group slug resolved whose membership contains this restaurant. Supply the slug by hand, or this is genuinely a single-location restaurant.`,
        candidatesTried: resolved.candidatesTried ?? [],
      }
    }
    const slug = resolved.slug
    const fmRefs = resolved.fmRefs ?? []

    // A group of one is not a chain — a link over a single location is just the
    // storefront with an extra hop. Skipped for an operator-supplied slug,
    // where FM's group is not the authority on the chain's size.
    if (!opts?.slug && fmRefs.length < 2) {
      return { status: 'not-a-chain', detail: `FM's group ${slug} holds a single restaurant.` }
    }

    const existing = (await sql`
      SELECT reference, title FROM disco_multi_unit_links WHERE slug = ${slug} ORDER BY created_at ASC LIMIT 1
    `) as { reference: string; title: string }[]

    const fmMeta = await fetchFmLinkMeta(slug)
    const title = fmMeta.header || existing[0]?.title || (restaurantName || '').split(' - ')[0].trim() || slug

    if (existing.length) {
      const linkReference = existing[0].reference
      const already = (await sql`
        SELECT 1 FROM disco_multi_unit_link_members
        WHERE link_reference = ${linkReference}::uuid AND restaurant_reference = ${ref} LIMIT 1
      `) as unknown[]
      const memberRefs = async () => ((await sql`
        SELECT restaurant_reference FROM disco_multi_unit_link_members WHERE link_reference = ${linkReference}::uuid
      `) as { restaurant_reference: string }[]).map(r => r.restaurant_reference)

      if (already.length) {
        return { status: 'already-member', slug, linkReference, members: (await memberRefs()).length }
      }
      // GROW — add only. Never setMembers() here: it deletes first, which would
      // drop every location an earlier conversion added.
      await sql`
        INSERT INTO disco_multi_unit_link_members (link_reference, restaurant_reference)
        VALUES (${linkReference}::uuid, ${ref}) ON CONFLICT DO NOTHING
      `
      const refs = await memberRefs()
      const banner = await attachBanner(slug, title, ref)
      return { status: 'grown', slug, linkReference, title, members: refs.length, banner, divergence: describeDivergence(fmRefs, refs) }
    }

    // CREATE — holding only this location. It grows as its siblings convert.
    const linkReference = randomUUID()
    await sql`
      INSERT INTO disco_multi_unit_links (reference, slug, title, owner_email)
      VALUES (${linkReference}::uuid, ${slug}, ${title}, ${opts?.ownerEmail ?? null})
    `
    await sql`
      INSERT INTO disco_multi_unit_link_members (link_reference, restaurant_reference)
      VALUES (${linkReference}::uuid, ${ref}) ON CONFLICT DO NOTHING
    `
    const banner = await attachBanner(slug, title, ref)
    return { status: 'created', slug, linkReference, title, members: 1, banner, divergence: describeDivergence(fmRefs, [ref]) }
  } catch (e) {
    return { status: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}
