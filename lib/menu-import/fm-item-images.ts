// Per-ITEM images from FM, re-hosted in Vercel Blob.
//
// FM carries an image on most catering items (55 of 67 at each Atlanta Bread
// Georgia location, 39 of 47 at Asheville) as `mealPackage.image.reference`, served
// from its public unauthenticated download endpoint. Disco had ZERO item images,
// because the faithful importer's disco_menu_items INSERT never listed image_url —
// nothing regressed, the column was simply never written.
//
// WHY RE-HOST INSTEAD OF STORING FM'S URL. Two reasons, and the second is the real
// one:
//   1. There is a documented precedent — scripts/backfill-logos-from-fm.ts pulls
//      FM logos and states "Never stores the FM URL itself."
//   2. Sunsetting FM is the project's whole goal. Writing ~600 item rows that each
//      resolve through api.familymeal.com would create 600 runtime dependencies on
//      the system being switched off, and they would all break silently — a broken
//      <img> is invisible in logs.
//
// NOTE the faithful importer's RESTAURANT-level image handling (fm-faithful-import's
// section 0b) does store FM URLs directly, in icon_url/image_url. That is the same
// latent dependency at restaurant scale. Not changed here — out of scope for item
// images — but it wants the same treatment.
//
// CONTENT-ADDRESSED, so dedupe is free and re-runs are idempotent. FM clones its
// image rows per restaurant, so the nine Atlanta Bread locations hold nine DIFFERENT
// image references for the same picture — but the bytes are byte-identical (verified:
// Smyrna's Fruit Medley 2db77005… and Alpharetta's 830d13ca… are both 203336 bytes,
// sha256 7e0e70b21d463cae…). Keying the blob path on the sha256 of the bytes means
// those nine references collapse to ONE upload and ONE URL, and re-running the
// backfill re-uploads to the same path rather than accumulating copies.
import { createHash } from 'node:crypto'
import { put } from '@vercel/blob'
import { fmImageUrl } from '../fm-image'

// FM's Resolution enum is 70 | 150 | 300 | 550. The customer menu renders item
// cards well under 550px wide, but at 2-3x DPI; 550 is the largest FM offers and
// the only one that holds up on a retina card.
const FM_SIZE = 550
const MAX_RETRIES = 2
const BLOB_PREFIX = 'fm-item-images'

// Magic-byte sniffing — never trust Content-Type alone. An HTML error page served
// with a 200 and a wrong content-type must never become an item photo. Same list
// and reasoning as backfill-logos-from-fm.ts's detectImageType.
function detectImageType(buf: Buffer): { ext: string; contentType: string } | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', contentType: 'image/png' }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' }
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return { ext: 'gif', contentType: 'image/gif' }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', contentType: 'image/webp' }
  return null
}

export type ItemImageOutcome =
  | { ok: true; url: string; bytes: number; deduped: boolean }
  | { ok: false; reason: string }

/** Pull the FM image reference out of a mealPackage, whatever shape it arrives in. */
export function fmItemImageReference(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null
  const img = (item as Record<string, unknown>).image
  if (!img || typeof img !== 'object') return null
  const ref = (img as Record<string, unknown>).reference
  return typeof ref === 'string' && ref ? ref : null
}

/**
 * FM's image.name — the UNDERLYING STORAGE KEY, and the thing that actually
 * identifies a picture across restaurants.
 *
 * FM clones an image ROW per restaurant, so `image.reference` differs per location
 * for the same photo, but `image.name` does not: Fruit Medley is reference
 * 2db77005…/830d13ca…/fcb4f38d… at Smyrna/Alpharetta/Decatur and
 * name e44b4446-5359-48a3-ab7d-26f99328d044 at all three. Caching on the name lets
 * a nine-location chain download and upload one picture once instead of nine times.
 */
export function fmItemImageStorageKey(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null
  const img = (item as Record<string, unknown>).image
  if (!img || typeof img !== 'object') return null
  const name = (img as Record<string, unknown>).name
  return typeof name === 'string' && name ? name : null
}

/**
 * Per-run cache. Keyed by FM image reference → resolved Blob URL, so an item list
 * that repeats a reference costs one fetch. Content-addressing already dedupes
 * ACROSS references with identical bytes at the storage layer; this just avoids
 * re-downloading within a single run.
 */
export type ItemImageCache = Map<string, ItemImageOutcome>
export const newItemImageCache = (): ItemImageCache => new Map()

/**
 * Fetch one FM item image and re-host it. Returns the Blob URL to store in
 * disco_menu_items.image_url.
 *
 * NEVER THROWS. An image is decoration: a failed fetch must not fail a menu import
 * or a backfill row. Callers treat `ok: false` as "leave image_url NULL" and the
 * backfill can be re-run later to pick it up, since it only fills blanks.
 */
export async function resolveFmItemImage(
  imageReference: string,
  cache?: ItemImageCache,
  storageKey?: string | null,
): Promise<ItemImageOutcome> {
  if (!imageReference) return { ok: false, reason: 'no image reference' }
  // Cache on FM's storage key (image.name) when we have it — that's what identifies
  // a picture across restaurants — and only fall back to the per-restaurant
  // reference when it's absent. This is what turns a nine-location chain's 495
  // downloads into ~55.
  const cacheKey = storageKey || imageReference
  const cached = cache?.get(cacheKey)
  if (cached) return cached.ok ? { ...cached, deduped: true } : cached

  const record = (out: ItemImageOutcome): ItemImageOutcome => {
    cache?.set(cacheKey, out)
    return out
  }

  const url = fmImageUrl({ reference: imageReference })?.replace(/size=\d+/, `size=${FM_SIZE}`)
  if (!url) return record({ ok: false, reason: 'could not build FM image URL' })

  let lastReason = 'unknown'
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) { lastReason = `HTTP ${res.status}`; continue }
      const header = res.headers.get('content-type') || ''
      const buf = Buffer.from(await res.arrayBuffer())
      if (!header.startsWith('image/')) { lastReason = `non-image content-type: ${header || '(none)'}`; continue }
      const detected = detectImageType(buf)
      if (!detected) { lastReason = 'bytes are not a recognized image (likely an HTML error page)'; continue }

      // Content-addressed path: identical bytes → identical URL, across
      // restaurants and across runs.
      const sha = createHash('sha256').update(buf).digest('hex')
      const blob = await put(`${BLOB_PREFIX}/${sha}.${detected.ext}`, buf, {
        access: 'public', contentType: detected.contentType, allowOverwrite: true,
      })
      return record({ ok: true, url: blob.url, bytes: buf.length, deduped: false })
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e)
    }
  }
  return record({ ok: false, reason: lastReason })
}
