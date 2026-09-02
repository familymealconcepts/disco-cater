// Pre-flight: does this restaurant's CHAIN have a Disco-native /locations link yet?
//
// ── WHY THIS IS IN THE PRE-FLIGHT AND NOT ONLY IN THE RUNBOOK ───────────────────────────────
// It was in the runbook as a Tier 1 step and it still got missed: Gracious Bakery converted
// with two locations and no link, and nobody noticed for three weeks. A step gets skipped; a
// line in the report someone actually reads before converting does not.
//
// The failure is invisible by construction, which is what makes it worth a report line.
// getLocationLink falls back to FM's group endpoint whenever no native link exists, so a
// converted chain's /locations page keeps working — served by an unmaintained system, with
// FM's membership rather than ours. Nothing 404s, nothing logs, nothing looks wrong.
//
// ── READ-ONLY, AND NEVER THROWS ─────────────────────────────────────────────────────────────
// Same contract as the rest of conversion-preflight: it observes and reports. Every FM call is
// best-effort — a slow or dead FM must degrade this one section, never fail the whole
// pre-flight, because everything else in that report is still worth having.
import { sql } from '../db'
import { fetchFmLinkMeta } from './fm-banner'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const PROBE_TIMEOUT_MS = 8000

export interface MultiUnitPreflight {
  /** More than one location reachable by a SYSTEM_ADMIN who can reach this one. */
  isChain: boolean
  /** Every ref the grant table says this chain's system admins hold, this one included. */
  grantedRefs: { restaurantReference: string; name: string | null; isDiscoNative: boolean }[]
  /** Per system admin, so a divergence between two of them is visible rather than averaged. */
  grantsBySystemAdmin: { email: string; refs: string[] }[]
  /** The native link already covering this ref, if any. Its absence is the finding. */
  nativeLink: { slug: string; reference: string; memberRefs: string[] } | null
  /** FM's group for this chain, when a slug resolves whose membership contains this ref. */
  fm: {
    slug: string
    title: string | null
    hasBanner: boolean
    membership: { restaurantReference: string; name: string }[]
  } | null
  /** FM membership vs the grant table. Both directions — either is a reason to stop. */
  divergence: { inFmNotGranted: string[]; grantedNotInFm: string[] } | null
  /** Human-readable summary, used as the warning message. */
  detail: string
}

const EMPTY: MultiUnitPreflight = {
  isChain: false, grantedRefs: [], grantsBySystemAdmin: [], nativeLink: null,
  fm: null, divergence: null, detail: 'Single-location restaurant — no multi-unit link applies.',
}

/**
 * FM group-slug candidates. NOT guessed from the business name alone: the group slug is FM's
 * own and is not derivable from the location slugs (Gracious's two locations are
 * graciousbakerycafe-gardendistrict and graciousbakery-uptown; the group is graciousbakery).
 *
 * disco_location_links is the mirror of the slugs FM is known to serve, so it is a real
 * candidate set rather than a guess. A normalized name is appended for a chain not yet
 * mirrored — Francesca Catering is in that position and resolves to nothing, which is itself
 * the correct answer.
 *
 * A candidate is ACCEPTED ONLY IF ITS MEMBERSHIP CONTAINS THIS REF. A 200 for some other
 * chain's slug is a wrong answer that looks like a right one.
 */
async function slugCandidates(name: string | null): Promise<string[]> {
  const mirrored = (await sql`SELECT slug FROM disco_location_links WHERE slug IS NOT NULL`
    .catch(() => [])) as { slug: string }[]
  const fromName = (name || '').toLowerCase().split(' - ')[0].replace(/[^a-z0-9]/g, '')
  const all = [...mirrored.map(r => r.slug), fromName].filter(Boolean)
  return [...new Set(all)]
}

async function fmGroup(slug: string): Promise<{ restaurantReference: string; name: string }[] | null> {
  try {
    const r = await fetch(`${FM}/public-api/restaurants/group/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' }, cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!r.ok) return null
    const d = (await r.json().catch(() => null)) as { restaurants?: { reference?: string; businessName?: string }[] }[] | null
    if (!Array.isArray(d)) return null
    const out: { restaurantReference: string; name: string }[] = []
    for (const g of d) for (const x of (g?.restaurants || [])) {
      if (x?.reference) out.push({ restaurantReference: x.reference, name: x.businessName || '' })
    }
    return out
  } catch { return null }
}

export async function checkMultiUnit(ref: string, name: string | null): Promise<MultiUnitPreflight> {
  try {
    // The chain, from the grant table — the authority on membership. Every SYSTEM_ADMIN who can
    // reach this location, and everything else they can reach.
    const sas = (await sql`
      SELECT DISTINCT a.email
      FROM disco_restaurant_location_access la
      JOIN disco_restaurant_accounts a ON a.email = la.account_email
      WHERE la.restaurant_reference = ${ref}
        AND a.role = 'SYSTEM_ADMIN' AND a.archived_at IS NULL
      ORDER BY a.email`.catch(() => [])) as { email: string }[]

    if (!sas.length) return EMPTY

    const grants = (await sql`
      SELECT la.account_email AS email, la.restaurant_reference AS ref,
             c.name, COALESCE(c.is_disco_native, false) AS is_disco_native
      FROM disco_restaurant_location_access la
      LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = la.restaurant_reference
      WHERE la.account_email = ANY(${sas.map(s => s.email)})
      ORDER BY la.account_email, c.name`.catch(() => [])) as
      { email: string; ref: string; name: string | null; is_disco_native: boolean }[]

    const grantsBySystemAdmin = sas.map(s => ({
      email: s.email,
      refs: grants.filter(g => g.email === s.email).map(g => g.ref),
    }))
    const byRef = new Map(grants.map(g => [g.ref, g]))
    const grantedRefs = [...byRef.values()].map(g => ({
      restaurantReference: g.ref, name: g.name, isDiscoNative: g.is_disco_native,
    }))
    const isChain = grantedRefs.length > 1
    if (!isChain) return { ...EMPTY, grantsBySystemAdmin, grantedRefs: grantedRefs }

    // Is a native link already covering this ref? That is the whole question.
    const nativeRows = (await sql`
      SELECT l.slug, l.reference::text AS reference
      FROM disco_multi_unit_links l
      JOIN disco_multi_unit_link_members m ON m.link_reference = l.reference
      WHERE m.restaurant_reference = ${ref}
      LIMIT 1`.catch(() => [])) as { slug: string; reference: string }[]

    let nativeLink: MultiUnitPreflight['nativeLink'] = null
    if (nativeRows.length) {
      const members = (await sql`
        SELECT restaurant_reference FROM disco_multi_unit_link_members
        WHERE link_reference = ${nativeRows[0].reference}::uuid
        ORDER BY restaurant_reference`.catch(() => [])) as { restaurant_reference: string }[]
      nativeLink = { slug: nativeRows[0].slug, reference: nativeRows[0].reference, memberRefs: members.map(m => m.restaurant_reference) }
    }

    // FM's group — the slug and title only. Probed in parallel; accepted only on a membership
    // that contains this ref.
    let fm: MultiUnitPreflight['fm'] = null
    const cands = await slugCandidates(name)
    const probes = await Promise.all(cands.map(async (slug) => ({ slug, members: await fmGroup(slug) })))
    const hit = probes.find(p => p.members?.some(m => m.restaurantReference === ref))
    if (hit && hit.members) {
      const meta = await fetchFmLinkMeta(hit.slug)
      fm = { slug: hit.slug, title: meta.header, hasBanner: !!meta.imageReference, membership: hit.members }
    }

    // FM vs the grant table, BOTH directions. Reported, never resolved here — FM's group
    // endpoint over-reports (Morning Squeeze on /locations/eggstasy), so a divergence is a
    // question for a human, not something to pick a side on.
    let divergence: MultiUnitPreflight['divergence'] = null
    if (fm) {
      const grantedSet = new Set(grantedRefs.map(g => g.restaurantReference))
      const fmSet = new Set(fm.membership.map(m => m.restaurantReference))
      divergence = {
        inFmNotGranted: fm.membership.filter(m => !grantedSet.has(m.restaurantReference)).map(m => m.restaurantReference),
        grantedNotInFm: grantedRefs.filter(g => !fmSet.has(g.restaurantReference)).map(g => g.restaurantReference),
      }
    }

    const parts: string[] = [`${grantedRefs.length}-location chain`]
    parts.push(nativeLink
      ? `native link '${nativeLink.slug}' exists with ${nativeLink.memberRefs.length} member(s)`
      : 'NO native link — /locations is still served by FM')
    parts.push(fm
      ? `FM group '${fm.slug}' lists ${fm.membership.length}${fm.hasBanner ? ', has a banner to re-host' : ', no banner'}`
      : 'no FM group slug resolves — a human must choose one')
    if (divergence && (divergence.inFmNotGranted.length || divergence.grantedNotInFm.length)) {
      parts.push(`DIVERGENCE: ${divergence.inFmNotGranted.length} in FM not granted, ${divergence.grantedNotInFm.length} granted not in FM`)
    }
    const uneven = new Set(grantsBySystemAdmin.map(g => g.refs.length)).size > 1
    if (uneven) parts.push('system admins hold DIFFERENT location sets — membership is ambiguous')

    return { isChain, grantedRefs, grantsBySystemAdmin, nativeLink, fm, divergence, detail: parts.join('; ') + '.' }
  } catch {
    return { ...EMPTY, detail: 'Multi-unit check could not run (non-fatal).' }
  }
}
