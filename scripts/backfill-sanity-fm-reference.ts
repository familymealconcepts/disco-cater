// One-time backfill: set `fmReference` on Sanity restaurant docs by matching
// them to FamilyMeal restaurants (so the SUPER_ADMIN Edit dialog's Marketplace
// section can find the Sanity doc by fmReference).
//
// Matching order, per Sanity doc:
//   1. Exact name match (case-insensitive, trimmed) vs FM businessName
//   2. Slug match: Sanity slug.current vs FM businessNameWithoutSpaces
//   3. Otherwise → logged for manual review
// Docs that already have fmReference are skipped. FM names/slugs that map to
// more than one restaurant are treated as ambiguous (logged, not written).
//
// Run from the disco-cater folder:
//   SANITY_TOKEN=xxx FM_AUTH=xxx \
//     npx ts-node --skip-project scripts/backfill-sanity-fm-reference.ts --dry-run --limit=10
//
// Flags:
//   --dry-run    preview matches, write nothing
//   --limit=N    process only the first N Sanity restaurants (safe testing)
//
// Env:
//   SANITY_TOKEN      Sanity write token (required)
//   FM_AUTH           FM admin JWT, raw — no "Bearer " prefix (required)
//   FM_API_BASE_URL   optional, defaults to https://api.familymeal.com

import { createClient } from '@sanity/client'
import * as https from 'https'
import { URL } from 'url'

const sanity = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  token: process.env.SANITY_TOKEN,
  apiVersion: '2024-01-01',
  useCdn: false,
})

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const FM_AUTH = process.env.FM_AUTH || ''

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const limitArg = args.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity

interface FmRestaurant { reference?: string; businessName?: string; businessNameWithoutSpaces?: string }
interface SanityDoc { _id: string; name?: string; slug?: string; fmReference?: string }

// FM expects the raw JWT in Authorization (no Bearer prefix) — see lib/admin-auth.ts.
function fmGetJson(path: string): Promise<{ content?: FmRestaurant[]; totalPages?: number } | null> {
  return new Promise((resolve, reject) => {
    const u = new URL(`${FM}${path}`)
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { Authorization: FM_AUTH, Accept: 'application/json' } },
      res => {
        let data = ''
        res.on('data', c => (data += c))
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) return reject(new Error(`FM ${path} → HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
          try { resolve(data ? JSON.parse(data) : null) } catch (e) { reject(e) }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function fetchAllFm(path: string): Promise<FmRestaurant[]> {
  const out: FmRestaurant[] = []
  let page = 0
  const size = 200
  // Guard against runaway loops.
  for (let i = 0; i < 1000; i++) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fmGetJson(`${path}${sep}page=${page}&size=${size}`)
    const content = res?.content || []
    out.push(...content)
    const totalPages = res?.totalPages ?? 1
    page++
    if (page >= totalPages || content.length === 0) break
  }
  return out
}

const norm = (s?: string): string => (s || '').trim().toLowerCase()

function indexBy(list: FmRestaurant[], key: (r: FmRestaurant) => string): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const r of list) {
    const k = key(r)
    if (!k || !r.reference) continue
    m.set(k, [...(m.get(k) || []), r.reference])
  }
  return m
}

async function main(): Promise<void> {
  if (!process.env.SANITY_TOKEN) { console.error('ERROR: SANITY_TOKEN is required'); process.exit(1) }
  if (!FM_AUTH) { console.error('ERROR: FM_AUTH (raw FM admin JWT) is required'); process.exit(1) }

  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (will write)'}${LIMIT !== Infinity ? ` · limit ${LIMIT}` : ''}`)

  // 1. Pull both FM lists and dedupe by reference.
  const [ordering, marketplace] = await Promise.all([
    fetchAllFm('/api/admin/restaurants'),
    fetchAllFm('/api/admin/restaurants/marketplace'),
  ])
  const fmById = new Map<string, FmRestaurant>()
  for (const r of [...ordering, ...marketplace]) if (r.reference) fmById.set(r.reference, r)
  const fmAll = [...fmById.values()]
  console.log(`FM restaurants: ${fmAll.length} unique (${ordering.length} ordering + ${marketplace.length} marketplace)`)

  const byName = indexBy(fmAll, r => norm(r.businessName))
  const bySlug = indexBy(fmAll, r => norm(r.businessNameWithoutSpaces))

  // 2. Pull Sanity restaurants.
  const sanityDocs: SanityDoc[] = await sanity.fetch(
    `*[_type == "restaurant"]{ _id, name, "slug": slug.current, fmReference }`,
  )
  console.log(`Sanity restaurants: ${sanityDocs.length}\n`)

  let matched = 0
  let skipped = 0
  const unmatched: string[] = []
  const ambiguous: string[] = []

  let processed = 0
  for (const doc of sanityDocs) {
    if (processed >= LIMIT) break
    processed++

    if (doc.fmReference) { skipped++; continue }

    let refs = byName.get(norm(doc.name))
    let how = 'name'
    if (!refs || refs.length === 0) { refs = bySlug.get(norm(doc.slug)); how = 'slug' }

    if (!refs || refs.length === 0) { unmatched.push(doc.name || doc._id); continue }
    if (refs.length > 1) { ambiguous.push(`"${doc.name}" → ${refs.length} FM matches by ${how}`); continue }

    const ref = refs[0]
    console.log(`MATCH (${how}): "${doc.name}" → ${ref}`)
    if (!DRY_RUN) {
      await sanity.patch(doc._id).set({ fmReference: ref }).commit()
    }
    matched++
  }

  console.log('\n── Report ─────────────────────────────')
  console.log(`Matched & ${DRY_RUN ? 'would update' : 'updated'}: ${matched}`)
  console.log(`Skipped (already had fmReference): ${skipped}`)
  console.log(`Ambiguous (manual review): ${ambiguous.length}`)
  ambiguous.forEach(a => console.log(`  - ${a}`))
  console.log(`Unmatched (manual review): ${unmatched.length}`)
  unmatched.forEach(n => console.log(`  - ${n}`))
  if (DRY_RUN) console.log('\nDRY RUN — no documents were modified. Re-run without --dry-run to apply.')
}

main().catch(e => { console.error(e); process.exit(1) })
