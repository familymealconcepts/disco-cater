// A multi-unit link's BANNER image, pulled from FM once and re-hosted in Vercel Blob.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
// getLocationLink's FM branch falls back to FM's own /links/{slug} image, so an FM-backed
// locations page shows FM's uploaded banner. The NATIVE branch has no such fallback — by
// design; reaching back to FM for a converted chain reintroduces the dependency conversion
// exists to sever. The consequence is that seeding a native link silently drops the banner and
// the page falls to its auto-extracted gradient. That happened to Gracious on 2026-09-02.
//
// So the banner has to be CARRIED ACROSS at seed time, the same way the slug and title are.
//
// ── RE-HOSTED, NEVER HOTLINKED ──────────────────────────────────────────────────────────────
// Storing FM's download URL would "fix" the page while creating exactly the runtime dependency
// on api.familymeal.com that the native branch refuses to have — and it would break silently,
// because a dead <img> appears in no log. Same reasoning, same shape, and deliberately the same
// content-addressed scheme as lib/menu-import/fm-item-images.ts and
// scripts/backfill-logos-from-fm.ts ("Never stores the FM URL itself").
//
// CONTENT-ADDRESSED on the sha256 of the BYTES, so a chain that uploaded the same banner at
// several slugs collapses to one object, and re-running a backfill overwrites the same path
// instead of accumulating copies.
import { createHash } from 'node:crypto'
import { put } from '@vercel/blob'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const BLOB_PREFIX = 'fm-link-banners'
const MAX_RETRIES = 2

/**
 * Magic-byte sniffing — never trust Content-Type alone. FM serves its 404 body with a 200 in
 * some paths, and an HTML error page must never be written to the database as a banner. Same
 * list and reasoning as fm-item-images.ts's detectImageType.
 */
function detectImageType(buf: Buffer): { ext: string; contentType: string } | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', contentType: 'image/png' }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' }
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return { ext: 'gif', contentType: 'image/gif' }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', contentType: 'image/webp' }
  return null
}

export type FmLinkMeta = { header: string | null; imageReference: string | null }

/**
 * FM's own record for a group slug: the human title and the banner's image reference.
 * PUBLIC and unauthenticated, the same endpoint lib/locations.ts's fetchFmLink uses.
 *
 * Returns nulls rather than throwing on a 404 — a chain with no FM links record is a normal
 * case (a Disco-native chain that never existed in FM), not an error.
 */
export async function fetchFmLinkMeta(slug: string): Promise<FmLinkMeta> {
  try {
    const res = await fetch(`${FM}/public-api/restaurants/links/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { header: null, imageReference: null }
    const data = (await res.json().catch(() => null)) as { header?: string; image?: { reference?: string } } | null
    const header = data?.header?.trim() || null
    const ref = data?.image?.reference
    return { header, imageReference: typeof ref === 'string' && ref ? ref : null }
  } catch {
    return { header: null, imageReference: null }
  }
}

export type BannerOutcome =
  | { ok: true; url: string; bytes: number; sha256: string; contentType: string }
  | { ok: false; reason: string }

/**
 * Download one FM banner and re-host it. Returns the Blob URL to store in
 * disco_location_links.image_url.
 *
 * NEVER THROWS. A banner is decoration: a failed fetch must leave the page on its gradient,
 * not fail a seed or a conversion. Callers treat `ok: false` as "no image", and a later re-run
 * picks it up because the path is content-addressed and the write only fills a blank.
 */
export async function rehostFmBanner(imageReference: string): Promise<BannerOutcome> {
  if (!imageReference) return { ok: false, reason: 'no image reference' }
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { ok: false, reason: 'BLOB_READ_WRITE_TOKEN is not set' }

  // size=600 matches what fetchFmLink already requests for the FM-branch banner, so the
  // re-hosted copy is the same asset the page was showing before it was carried across.
  const url = `${FM}/public-api/images/${encodeURIComponent(imageReference)}/download?size=600`

  let lastReason = 'unknown'
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (!res.ok) { lastReason = `HTTP ${res.status}`; continue }
      const header = res.headers.get('content-type') || ''
      const buf = Buffer.from(await res.arrayBuffer())
      if (!header.startsWith('image/')) { lastReason = `non-image content-type: ${header || '(none)'}`; continue }
      const detected = detectImageType(buf)
      if (!detected) { lastReason = 'bytes are not a recognized image (likely an HTML error page)'; continue }

      const sha = createHash('sha256').update(buf).digest('hex')
      const blob = await put(`${BLOB_PREFIX}/${sha}.${detected.ext}`, buf, {
        access: 'public', contentType: detected.contentType, allowOverwrite: true,
      })
      return { ok: true, url: blob.url, bytes: buf.length, sha256: sha, contentType: detected.contentType }
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: false, reason: lastReason }
}
