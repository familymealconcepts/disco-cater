// One-time (but resumable/re-runnable) migration: backfill missing
// disco_restaurant_cache.icon_url values from FamilyMeal's own logo (NOT
// marketplace-image) records in the local fm_backup Postgres instance.
//
// Source of truth for the field mapping: familymeal-java-backend's
// RestaurantImageUploadHandler (entity type "restaurants") sets
// Restaurant.image, backed by tbl_restaurants.image_id -> tbl_image_details —
// that is FM's Logo. tbl_marketplace_images is a SEPARATE table for FM's own
// Marketplace Image and is never read here.
//
// Downloads each image from FM's public CDN ONCE (a one-time migration read,
// not a runtime dependency — see the task's own note that this is acceptable),
// re-hosts it in Vercel Blob under fm-logos/{restaurant_reference}.{ext}, and
// only then writes the Blob URL into icon_url. Never stores the FM URL itself.
//
// FILL BLANK ONLY: every write is guarded by `WHERE icon_url IS NULL`, both in
// the candidate query and the final UPDATE. This is also what makes the script
// resumable — re-running after a partial failure naturally skips every
// restaurant a prior run already filled, with no separate state file needed.
//
// Usage:
//   npx tsx scripts/backfill-logos-from-fm.ts            # dry run (default)
//   npx tsx scripts/backfill-logos-from-fm.ts --execute   # real downloads/uploads/writes

import { config } from 'dotenv'
config({ path: '.env.local' })
import { Client } from 'pg'
import { neon } from '@neondatabase/serverless'
import { put } from '@vercel/blob'

const EXECUTE = process.argv.includes('--execute')
const CONCURRENCY = 6
const MAX_RETRIES = 2
const FM_SIZE = 300 // FM's Resolution enum: 70 | 150 | 300 | 550 — 300 covers the 80x80 header slot up to 3x DPI

const neonSql = neon(process.env.DATABASE_URL as string)

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }

// Magic-byte sniffing — never trust Content-Type alone. An HTML error page
// served with a 200 and a wrong/missing content-type must never become a
// "logo".
function detectImageType(buf: Buffer): { ext: string; contentType: string } | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', contentType: 'image/png' }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' }
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return { ext: 'gif', contentType: 'image/gif' }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', contentType: 'image/webp' }
  return null
}

type FetchResult =
  | { ok: true; buf: Buffer; ext: string; contentType: string }
  | { ok: false; reason: string }

async function fetchLogo(imageReference: string): Promise<FetchResult> {
  const url = `https://api.familymeal.com/public-api/images/${imageReference}/download?size=${FM_SIZE}`
  let lastReason = 'unknown'
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) {
        lastReason = `HTTP ${res.status}`
      } else {
        const contentTypeHeader = res.headers.get('content-type') || ''
        const buf = Buffer.from(await res.arrayBuffer())
        if (!contentTypeHeader.startsWith('image/')) {
          lastReason = `non-image content-type: ${contentTypeHeader || '(none)'}`
        } else {
          const detected = detectImageType(buf)
          if (!detected) {
            lastReason = 'bytes are not a recognized image format (likely an HTML error page or corrupt download)'
          } else {
            return { ok: true, buf, ext: detected.ext, contentType: detected.contentType }
          }
        }
      }
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e)
    }
    if (attempt < MAX_RETRIES) await sleep(500 * Math.pow(3, attempt))
  }
  return { ok: false, reason: lastReason }
}

interface Candidate { restaurantRef: string; name: string; imageReference: string }

async function loadCandidates(): Promise<{ candidates: Candidate[]; noSourceAvailable: number }> {
  const fm = new Client({ database: 'fm_backup' })
  await fm.connect()
  const fmRes = await fm.query(`
    SELECT r.reference AS restaurant_reference, d.reference AS image_reference
    FROM familymeal.tbl_restaurants r
    JOIN familymeal.tbl_image_details d ON d.id = r.image_id
    WHERE r.image_id IS NOT NULL
  `)
  await fm.end()
  const fmByRef = new Map(fmRes.rows.map(r => [r.restaurant_reference, r.image_reference]))

  // Re-queried fresh on every invocation — this IS the resumability
  // mechanism: a restaurant a prior run already filled no longer has a NULL
  // icon_url, so it naturally drops out of this candidate set.
  const neonRows = (await neonSql`SELECT restaurant_reference, name, icon_url FROM disco_restaurant_cache`) as { restaurant_reference: string; name: string; icon_url: string | null }[]
  const candidates: Candidate[] = []
  let noSourceAvailable = 0
  for (const r of neonRows) {
    if (r.icon_url && r.icon_url.trim()) continue // fill blank only
    const imageReference = fmByRef.get(r.restaurant_reference)
    if (!imageReference) { noSourceAvailable++; continue } // no-source-available
    candidates.push({ restaurantRef: r.restaurant_reference, name: r.name, imageReference })
  }
  return { candidates, noSourceAvailable }
}

async function processOne(c: Candidate): Promise<{ status: 'filled' | 'skipped-because-present' | 'download-failed'; reason?: string; blobUrl?: string }> {
  const fetched = await fetchLogo(c.imageReference)
  if (!fetched.ok) return { status: 'download-failed', reason: fetched.reason }

  const path = `fm-logos/${c.restaurantRef}.${fetched.ext}`
  const blob = await put(path, fetched.buf, { access: 'public', contentType: fetched.contentType, allowOverwrite: true })

  const rows = (await neonSql`
    UPDATE disco_restaurant_cache SET icon_url = ${blob.url}, cached_at = NOW()
    WHERE restaurant_reference = ${c.restaurantRef} AND icon_url IS NULL
    RETURNING restaurant_reference
  `) as { restaurant_reference: string }[]
  if (rows.length === 0) {
    // Someone else filled it between our candidate query and this write —
    // the blob we just uploaded is simply unused; never overwrite.
    return { status: 'skipped-because-present' }
  }
  return { status: 'filled', blobUrl: blob.url }
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function runner() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner))
  return results
}

async function main() {
  const { candidates, noSourceAvailable } = await loadCandidates()
  console.log(`${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — ${candidates.length} candidates (blank icon_url, source available in fm_backup)`)
  console.log(`no-source-available (blank icon_url, no fm_backup image_id match): ${noSourceAvailable}`)

  if (!EXECUTE) {
    for (const c of candidates) {
      console.log(JSON.stringify({
        restaurant_reference: c.restaurantRef,
        name: c.name,
        fm_image_reference: c.imageReference,
        intended_blob_path: `fm-logos/${c.restaurantRef}.<ext-detected-at-download-time>`,
      }))
    }
    console.log(`\nDRY RUN — no downloads, no uploads, no writes. ${candidates.length} would be attempted.`)
    process.exit(0)
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('BLOB_READ_WRITE_TOKEN is not set — cannot upload. Aborting before touching anything.')
    process.exit(1)
  }

  let filled = 0, skippedPresent = 0
  const failures: { restaurantRef: string; name: string; reason: string }[] = []

  const results = await runWithConcurrency(candidates, CONCURRENCY, async (c) => {
    const r = await processOne(c)
    if (r.status === 'filled') { filled++; console.log(`FILLED  ${c.restaurantRef}  ${c.name}  -> ${r.blobUrl}`) }
    else if (r.status === 'skipped-because-present') { skippedPresent++; console.log(`SKIP    ${c.restaurantRef}  ${c.name}  (filled concurrently)`) }
    else { failures.push({ restaurantRef: c.restaurantRef, name: c.name, reason: r.reason || 'unknown' }); console.log(`FAILED  ${c.restaurantRef}  ${c.name}  :: ${r.reason}`) }
    return r
  })

  console.log('\n=== SUMMARY ===')
  console.log('filled:', filled)
  console.log('skipped-because-present (race with a concurrent fill):', skippedPresent)
  console.log('download-failed:', failures.length)
  console.log(JSON.stringify(failures, null, 2))
  console.log('no-source-available (blank icon_url, no fm_backup image_id match):', noSourceAvailable)
  console.log('total processed:', results.length)
}

main().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1) })
