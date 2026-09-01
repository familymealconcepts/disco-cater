/**
 * How many FM-backed restaurants publish an announcement banner that Disco
 * never shows? READ-ONLY.
 *
 * The banner lives on GET /public-api/restaurants/{ref}/feesAndTips, which is
 * PUBLIC — no session, no master password. It carries exactly the three fields
 * Disco already stores in disco_restaurant_overrides for native restaurants
 * (announcement, deliveryOrderTimeWindows, enableMenuSearch), and the FM branch
 * of the customer page simply never reads it.
 *
 *   npx tsx scripts/audit-fm-announcements.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const CONCURRENCY = 24

interface Row { ref: string; name: string; slug: string | null; live: boolean; native: boolean }
interface Hit extends Row { announcement: string; deliveryOrderTimeWindows: string | null; enableMenuSearch: boolean | null }

async function mapLimit<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++])
  }))
}

async function main() {
  const rows = (await sql`
    SELECT restaurant_reference AS ref, name, slug,
           COALESCE(is_live,false) AS live, COALESCE(is_disco_native,false) AS native
    FROM disco_restaurant_cache WHERE archived_at IS NULL ORDER BY name
  `) as unknown as Row[]

  const hits: Hit[] = []
  let checked = 0, unreachable = 0, blank = 0

  await mapLimit(rows, CONCURRENCY, async (r) => {
    try {
      const res = await fetch(`${FM}/public-api/restaurants/${r.ref}/feesAndTips`, { headers: { Accept: 'application/json' } })
      if (!res.ok) { unreachable++; return }
      const d = await res.json() as Record<string, unknown>
      checked++
      const a = typeof d.announcement === 'string' ? d.announcement.trim() : ''
      if (!a) { blank++; return }
      hits.push({
        ...r, announcement: a,
        deliveryOrderTimeWindows: typeof d.deliveryOrderTimeWindows === 'string' ? d.deliveryOrderTimeWindows : null,
        enableMenuSearch: typeof d.enableMenuSearch === 'boolean' ? d.enableMenuSearch : null,
      })
    } catch { unreachable++ }
  })

  console.log(`Checked ${checked} of ${rows.length} restaurants (${unreachable} unreachable, ${blank} with no announcement)\n`)

  const fmBacked = hits.filter(h => !h.native)
  const native = hits.filter(h => h.native)
  console.log(`${hits.length} restaurant(s) publish an announcement:`)
  console.log(`   FM-backed : ${fmBacked.length}  (${fmBacked.filter(h => h.live).length} live)  <- currently INVISIBLE on Disco`)
  console.log(`   native    : ${native.length}  (${native.filter(h => h.live).length} live)  <- already shown, from Neon\n`)

  console.log('── FM-BACKED, LIVE — a customer sees this on FM and not on Disco ──')
  fmBacked.filter(h => h.live).forEach(h =>
    console.log(`   ${(h.slug || h.ref).slice(0, 30).padEnd(30)} ${h.name.slice(0, 26).padEnd(26)} ${h.announcement.slice(0, 96)}`))

  const notLive = fmBacked.filter(h => !h.live)
  console.log(`\n── FM-BACKED, not live (${notLive.length}) ──`)
  notLive.slice(0, 15).forEach(h =>
    console.log(`   ${h.name.slice(0, 30).padEnd(30)} ${h.announcement.slice(0, 88)}`))
  if (notLive.length > 15) console.log(`   … and ${notLive.length - 15} more`)

  // The other two fields ride along on the same payload — worth knowing whether
  // they diverge from what Disco stores, since the FM branch reads neither.
  const nonExact = hits.filter(h => h.deliveryOrderTimeWindows && h.deliveryOrderTimeWindows !== 'exact')
  const search = hits.filter(h => h.enableMenuSearch === true)
  console.log(`\n── RIDING ALONG on the same payload ──`)
  console.log(`   deliveryOrderTimeWindows != 'exact': ${nonExact.length}`)
  nonExact.slice(0, 8).forEach(h => console.log(`      ${h.name} = ${h.deliveryOrderTimeWindows}`))
  console.log(`   enableMenuSearch = true: ${search.length}`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
