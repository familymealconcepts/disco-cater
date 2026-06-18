import { sql } from './db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Resolve an image value to a storable URL. Link images now live in Vercel Blob,
// so callers pass a full blob URL — returned as-is. A bare value is treated as a
// legacy FM image reference and expanded to FM's CDN URL. Null when empty.
export function imageUrlFromRef(imageRef: string | null | undefined): string | null {
  const ref = (imageRef || '').trim()
  if (!ref) return null
  if (ref.startsWith('http')) return ref // full URL (e.g. Vercel Blob)
  return `${FM}/public-api/images/${ref}/download?size=1200` // legacy FM ref
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

// Upsert a link row keyed by slug (slug/title/restaurant_reference). Idempotent.
// NOTE: image_url is deliberately NOT updated on conflict — link images are owned
// by Vercel Blob and written separately by upsertLocationLinkImage (via the PATCH
// .../[ref]/image endpoint). Updating it here would wipe the blob URL on every
// re-save, since FM's save response carries no image. Throws on a DB error —
// callers treat it as best-effort.
export async function upsertLocationLink(row: LocationLinkRow): Promise<void> {
  if (!row.slug) return
  await ensureTable()
  await sql`
    INSERT INTO disco_location_links (slug, title, image_url, restaurant_reference, updated_at)
    VALUES (${row.slug}, ${row.title}, ${row.imageUrl}, ${row.restaurantReference}, NOW())
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title,
      restaurant_reference = EXCLUDED.restaurant_reference,
      updated_at = NOW()
  `
}

// Map of slug → image_url (Vercel Blob) for the given slugs, for rendering the
// portal links table thumbnails from the source-of-truth blob URLs rather than
// stale FM image references. Best effort — returns {} on any error.
export async function getLinkImages(slugs: string[]): Promise<Record<string, string>> {
  const clean = slugs.filter(Boolean)
  if (!clean.length) return {}
  try {
    const rows = (await sql`
      SELECT slug, image_url FROM disco_location_links
      WHERE slug = ANY(${clean}::text[]) AND image_url IS NOT NULL AND image_url <> ''
    `) as { slug: string; image_url: string }[]
    const out: Record<string, string> = {}
    for (const r of rows) out[r.slug] = r.image_url
    return out
  } catch {
    return {}
  }
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
