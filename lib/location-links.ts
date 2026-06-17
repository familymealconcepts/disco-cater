import { sql } from './db'

// Build the image URL for an FM image reference (size 1200 for the
// /locations/[slug] header). Returns null when no reference is given. Points at
// our own /api/public/fm-image proxy so the image is served from discocater.com
// with FM service auth applied server-side (FM's image CDN needs that auth).
export function imageUrlFromRef(imageRef: string | null | undefined): string | null {
  const ref = (imageRef || '').trim()
  if (!ref) return null
  if (ref.startsWith('http')) return ref
  return `/api/public/fm-image?ref=${encodeURIComponent(ref)}&size=1200`
}

// Neon mirror of the FM multi-unit "Links" so the PUBLIC /locations/[slug] page
// can resolve a link's uploaded banner image + title with a single fast query —
// no FM auth, no platform-wide listing scan. Written on every link create/update
// from the restaurant portal; read by lib/locations.ts (resolveLinkBanner).

export interface LocationLinkRow {
  slug: string
  title: string | null
  imageUrl: string | null
  restaurantReference: string | null
}

// Build a row from the forwarded request JSON + FM's create/update response.
// slug/title come from either (request is authoritative for what we sent; FM's
// echo is preferred when present). The image *reference* is assigned by FM, so
// it only exists on FM's response — absent there, image_url stays null and the
// public page falls back to the gradient.
export function buildLinkRow(
  request: Record<string, unknown> | null,
  fmResponse: unknown,
  restaurantReference: string | null,
): LocationLinkRow {
  const r = request || {}
  const f = (fmResponse && typeof fmResponse === 'object' ? fmResponse : {}) as {
    url?: unknown; header?: unknown; locationImage?: unknown; image?: { reference?: unknown }
  }
  const slug = String(f.url || r.url || '').trim()
  const titleRaw = f.header ?? r.header
  const title = titleRaw != null && String(titleRaw).trim() ? String(titleRaw).trim() : null
  const ref = (f.image && f.image.reference) || f.locationImage || ''
  return { slug, title, imageUrl: imageUrlFromRef(String(ref)), restaurantReference: restaurantReference || null }
}

// CREATE TABLE IF NOT EXISTS, cached per-lambda. The Neon HTTP driver runs one
// statement per round-trip, so DDL runs on its own.
let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await sql`
    CREATE TABLE IF NOT EXISTS disco_location_links (
      slug TEXT PRIMARY KEY,
      title TEXT,
      image_url TEXT,
      restaurant_reference TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  ensured = true
}

// Upsert a link row keyed by slug. Idempotent; safe to call on both create and
// update. Throws on a DB error — callers treat it as best-effort (the FM write
// is the source of truth, so a Neon hiccup must not fail the portal save).
export async function upsertLocationLink(row: LocationLinkRow): Promise<void> {
  if (!row.slug) return
  await ensureTable()
  await sql`
    INSERT INTO disco_location_links (slug, title, image_url, restaurant_reference, updated_at)
    VALUES (${row.slug}, ${row.title}, ${row.imageUrl}, ${row.restaurantReference}, NOW())
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title,
      image_url = EXCLUDED.image_url,
      restaurant_reference = EXCLUDED.restaurant_reference,
      updated_at = NOW()
  `
}

// Update ONLY the image_url for a slug (leaves title/restaurant_reference as-is).
// Used by the PATCH .../[ref]/image endpoint: the portal client recovers the
// uploaded image reference from FM's links listing after a save and sends it
// here, since FM's save responses omit it. Idempotent.
export async function upsertLocationLinkImage(slug: string, imageUrl: string | null): Promise<void> {
  if (!slug) return
  await ensureTable()
  await sql`
    INSERT INTO disco_location_links (slug, image_url, updated_at)
    VALUES (${slug}, ${imageUrl}, NOW())
    ON CONFLICT (slug) DO UPDATE SET
      image_url = EXCLUDED.image_url,
      updated_at = NOW()
  `
}
