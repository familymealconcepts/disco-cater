import { sql } from './db'
import legacyRestaurantSlugRedirects from './legacy-restaurant-slug-redirects.json'

/**
 * LINK PAGE URLS ARE NEVER REUSED (Peter, 22 Oct 2026).
 *
 * A link page lives at /locations/<url>. A new one's URL must not match:
 *   - any link page today (Disco's own, or a FamilyMeal link Disco mirrors),
 *   - any link page URL ever used before — renamed or deleted,
 *   - any restaurant's page URL (/restaurants/<slug>, /order/<slug>), current
 *     or a legacy slug that still redirects,
 *   - any FamilyMeal group URL (the /locations page falls back to FamilyMeal's
 *     group by that name, so a clash would show the wrong restaurants),
 *   - any of the site's own routes.
 *
 * NOTHING RECORDED PAST URLS BEFORE THIS. deleteNativeLink removes the row and
 * a rename overwrote the slug, so an old URL was simply gone. This registry
 * starts recording: it is seeded (idempotently, on first use in each server
 * instance) with every link URL in use today, and every create, rename and
 * delete is written to it. A URL in it stays taken forever.
 */

/** The site's own route names. A link URL equal to one would read as that page. */
const RESERVED = new Set([
  'account', 'admin', 'api', 'austin', 'become-a-partner', 'chicago', 'compare', 'corporate-catering',
  'dinova-demo', 'faq', 'for-restaurants', 'fullmap', 'holiday-catering', 'locations', 'los-angeles',
  'meal-prep', 'new-jersey', 'new-york', 'order', 'order-confirmation', 'portal', 'privacy',
  'reset-password', 'restaurant', 'restaurants', 'seattle', 'signup', 'social-catering', 'terms',
  'third-party-delivery', 'images', 'login', 'logout', 'checkout', 'cart', 'search', 'new', 'edit',
])

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
let seeded = false

export async function ensureLinkUrlRegistry(): Promise<void> {
  if (seeded) return
  await sql`
    CREATE TABLE IF NOT EXISTS disco_link_url_registry (
      slug TEXT PRIMARY KEY,            -- lowercased
      link_reference UUID,              -- the Disco link that used it, when known
      source TEXT NOT NULL,             -- 'disco-link' | 'fm-link-mirror' | 'rename' | 'delete' | 'restaurant-delete'
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retired_at TIMESTAMPTZ            -- set when the link stopped using it
    )`
  // Treat every URL in use today as taken. ON CONFLICT DO NOTHING: re-running
  // never moves a first_seen_at or un-retires anything.
  await sql`
    INSERT INTO disco_link_url_registry (slug, link_reference, source)
    SELECT lower(slug), reference, 'disco-link' FROM disco_multi_unit_links
    ON CONFLICT (slug) DO NOTHING`
  await sql`
    INSERT INTO disco_link_url_registry (slug, source)
    SELECT lower(slug), 'fm-link-mirror' FROM disco_location_links WHERE slug IS NOT NULL AND slug <> ''
    ON CONFLICT (slug) DO NOTHING`.catch(() => { /* mirror table absent in a fresh DB */ })
  seeded = true
}

/** Record a URL as used by a link (create or rename). Idempotent. */
export async function recordLinkUrl(slug: string, linkReference: string | null, source: string): Promise<void> {
  await ensureLinkUrlRegistry()
  await sql`
    INSERT INTO disco_link_url_registry (slug, link_reference, source)
    VALUES (${slug.toLowerCase()}, ${linkReference}, ${source})
    ON CONFLICT (slug) DO NOTHING`
}

/** Has Disco ever recorded this URL? (An existing FamilyMeal link keeps its own.) */
export async function urlRecorded(slug: string): Promise<boolean> {
  await ensureLinkUrlRegistry()
  const rows = (await sql`SELECT 1 FROM disco_link_url_registry WHERE slug = ${slug.toLowerCase()} LIMIT 1`) as unknown[]
  return rows.length > 0
}

/** Mark a link's URL(s) retired (rename away, or delete). The URL stays taken. */
export async function retireLinkUrl(slug: string): Promise<void> {
  await ensureLinkUrlRegistry()
  await sql`UPDATE disco_link_url_registry SET retired_at = COALESCE(retired_at, NOW()) WHERE slug = ${slug.toLowerCase()}`
}

// ── A DELETED LOCATION'S ADDRESS STAYS TAKEN (Peter, 22 Oct 2026) ────────────
// Permanently deleting a location (lib/disco-restaurant-delete.ts) records its
// /restaurants/<slug> address here as 'restaurant-delete', already retired, so
// no later location or link page can be given the URL a customer may still
// have bookmarked for something else.
export async function reserveDeletedRestaurantUrl(slug: string | null | undefined): Promise<void> {
  const s = String(slug || '').trim().toLowerCase()
  if (!s) return
  await ensureLinkUrlRegistry()
  await sql`
    INSERT INTO disco_link_url_registry (slug, link_reference, source, retired_at)
    VALUES (${s}, NULL, 'restaurant-delete', NOW())
    ON CONFLICT (slug) DO NOTHING`
}

/** Was this the address of a location that has since been deleted? */
export async function isDeletedRestaurantUrl(slug: string | null | undefined): Promise<boolean> {
  const s = String(slug || '').trim().toLowerCase()
  if (!s) return false
  await ensureLinkUrlRegistry()
  const rows = (await sql`
    SELECT 1 FROM disco_link_url_registry WHERE slug = ${s} AND source = 'restaurant-delete' LIMIT 1
  `) as unknown[]
  return rows.length > 0
}

/** A new location's name-derived slug, moved off a deleted location's address (same `-<ref>` suffix the create routes use). */
export async function freeRestaurantSlug(slug: string, ref: string): Promise<string> {
  return (await isDeletedRestaurantUrl(slug)) ? `${slug}-${String(ref).slice(0, 6)}` : slug
}

const legacySlugs = new Set<string>(
  (legacyRestaurantSlugRedirects as Array<{ oldSlug: string; newSlug: string }>)
    .flatMap(r => [r.oldSlug, r.newSlug]).map(s => String(s || '').toLowerCase()).filter(Boolean),
)

export type UrlVerdict = { ok: true } | { ok: false; reason: string; suggestion: string | null }

async function takenReason(slug: string, exceptLinkRef?: string | null): Promise<string | null> {
  const s = slug.toLowerCase()
  if (RESERVED.has(s)) return 'That URL is one of Disco Cater’s own pages.'
  const reg = (await sql`
    SELECT link_reference::text AS ref, retired_at, source FROM disco_link_url_registry WHERE slug = ${s} LIMIT 1
  `) as Array<{ ref: string | null; retired_at: string | null; source: string }>
  if (reg.length && reg[0].source === 'restaurant-delete') return 'That URL belonged to a restaurant that was deleted and can’t be reused.'
  if (reg.length) {
    // A link may keep (or take back) a URL it has itself used.
    if (!(exceptLinkRef && reg[0].ref === exceptLinkRef)) {
      return reg[0].retired_at ? 'That URL was used by a link page before and can’t be reused.' : 'That URL is already used by another link page.'
    }
  }
  const live = (await sql`
    SELECT 1 FROM disco_multi_unit_links
     WHERE lower(slug) = ${s} AND (${exceptLinkRef ?? null}::uuid IS NULL OR reference <> ${exceptLinkRef ?? null}::uuid) LIMIT 1
  `) as unknown[]
  if (live.length) return 'That URL is already used by another link page.'
  const rest = (await sql`SELECT 1 FROM disco_restaurant_cache WHERE lower(slug) = ${s} LIMIT 1`) as unknown[]
  if (rest.length || legacySlugs.has(s)) return 'That URL is a restaurant’s page address.'
  // FamilyMeal's group by that name (a READ). The /locations page falls back to
  // it, so a clash would show FamilyMeal's restaurants under the new title.
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(`${FM}/public-api/restaurants/group/${encodeURIComponent(s)}`, { cache: 'no-store', signal: ctrl.signal })
    clearTimeout(t)
    if (res.ok) {
      const body = await res.json().catch(() => null)
      if (Array.isArray(body) ? body.length : body) return 'That URL is already used by a FamilyMeal restaurant group.'
    }
  } catch {
    return 'Could not confirm the URL is free right now. Try again in a moment.'
  }
  return null
}

/**
 * May `slug` be used by a link page? `exceptLinkRef` is the link being edited,
 * which may keep its own current or past URLs. On refusal, suggests the first
 * free variant (`-catering`, then `-2`, `-3` …).
 */
export async function checkLinkUrl(slug: string, exceptLinkRef?: string | null): Promise<UrlVerdict> {
  await ensureLinkUrlRegistry()
  const reason = await takenReason(slug, exceptLinkRef)
  if (!reason) return { ok: true }
  const base = slug.toLowerCase().replace(/-\d+$/, '')
  const candidates = [`${base}-catering`, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)]
  for (const c of candidates) {
    if (c === slug.toLowerCase() || c.length > 120) continue
    if (!(await takenReason(c, exceptLinkRef))) return { ok: false, reason, suggestion: c }
  }
  return { ok: false, reason, suggestion: null }
}
