/**
 * Re-import ONLY disco_menus.skipped_days from FM, now that Disco can represent
 * partial-day blackouts (intervals).
 *
 * Narrow on purpose: a full menu re-import would rewrite items, categories,
 * modifiers and settings for restaurants that have been edited in Disco since
 * conversion. This touches one JSONB column.
 *
 * Menus are matched by NAME, because the importer mints its own menu references and
 * does not preserve FM's (Smyrna's Catering Menu is c17771e2… in FM, 01b4c2f6… in
 * Neon). An unmatched menu is reported and skipped, never guessed at.
 *
 * REPLACES the column with FM's data, so it also removes the temporary whole-day
 * cover entries added on 2026-08-28 ("TEMP full-day cover …") ahead of this fix.
 * Every removal is printed before it happens; a Disco-only blackout that FM has no
 * record of is called out separately, because replacing would delete it.
 *
 *   npx tsx scripts/reimport-skipped-days.ts                  # dry run
 *   npx tsx scripts/reimport-skipped-days.ts --execute
 *   npx tsx scripts/reimport-skipped-days.ts --ref <uuid>
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { getFmServiceAuthHeader } from '../lib/fm-service-auth'
import { fmSkippedDaysToDisco } from '../lib/menu-import/fm-faithful-import'
import type { SkippedDay } from '../lib/menu-settings'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const EXECUTE = process.argv.includes('--execute')
const ONLY_REF = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : null
const TEMP_MARKER = 'TEMP full-day cover'

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
const arrOf = (d: unknown): Record<string, unknown>[] => {
  if (Array.isArray(d)) return d as Record<string, unknown>[]
  const o = d as { content?: unknown; data?: unknown } | null
  return (Array.isArray(o?.content) ? o!.content : Array.isArray(o?.data) ? o!.data : []) as Record<string, unknown>[]
}
const describe = (d: SkippedDay) => {
  const ivs = d.intervals ?? []
  const when = ivs.length ? ivs.map(i => `${i.fromTime}-${i.toTime}`).join(',') : 'ALL DAY'
  return `${d.fromDate}${d.toDate !== d.fromDate ? `..${d.toDate}` : ''} ${when}${d.name ? ` "${d.name}"` : ''}`
}
const keyOf = (d: SkippedDay) => `${d.fromDate}|${d.toDate}|${(d.intervals ?? []).map(i => `${i.fromTime}-${i.toTime}`).sort().join(',')}`

let auth: Record<string, string> | null = null
async function fmGet(path: string): Promise<unknown> {
  if (!auth) auth = await getFmServiceAuthHeader()
  const r = await fetch(`${FM}${path}`, { headers: { ...auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function main() {
  const restaurants = (await sql`
    SELECT DISTINCT c.restaurant_reference AS ref, c.name
    FROM disco_restaurant_cache c
    JOIN disco_menus m ON m.restaurant_reference = c.restaurant_reference::uuid AND NOT m.archived
    WHERE c.is_disco_native ${ONLY_REF ? sql`AND c.restaurant_reference = ${ONLY_REF}` : sql``}
    ORDER BY c.name
  `) as unknown as { ref: string; name: string }[]

  console.log(`${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — ${restaurants.length} native restaurant(s)\n`)
  let changed = 0, partials = 0, tempRemoved = 0, discoOnly = 0, unmatched = 0

  for (const r of restaurants) {
    let fmMenus: Record<string, unknown>[]
    try { fmMenus = arrOf(await fmGet(`/api/admin/menu?restaurantReference=${r.ref}`)) }
    catch { continue }   // no FM record — Disco-only/test restaurant

    const byName = new Map<string, Record<string, unknown>>()
    for (const m of fmMenus) { if (m.archived !== true) byName.set(norm(m.name), m) }

    const discoMenus = (await sql`
      SELECT reference, name, COALESCE(skipped_days, '[]'::jsonb) AS skipped_days
      FROM disco_menus WHERE restaurant_reference = ${r.ref}::uuid AND NOT archived
    `) as unknown as { reference: string; name: string; skipped_days: SkippedDay[] }[]

    for (const dm of discoMenus) {
      const fm = byName.get(norm(dm.name))
      const current = Array.isArray(dm.skipped_days) ? dm.skipped_days : []
      if (!fm) {
        if (current.length) { unmatched++; console.log(`   ? ${r.name} · "${dm.name}" — no FM menu with this name; leaving ${current.length} blackout(s) alone`) }
        continue
      }
      const { skippedDays: next, partialImported, droppedWithIntervals } =
        fmSkippedDaysToDisco((fm.scheduleOption || {}) as Record<string, unknown>)

      const nextKeys = new Set(next.map(keyOf))
      const removed = current.filter(c => !nextKeys.has(keyOf(c)))
      const curKeys = new Set(current.map(keyOf))
      const added = next.filter(n => !curKeys.has(keyOf(n)))
      if (!removed.length && !added.length) continue

      changed++
      partials += partialImported
      console.log(`── ${r.name} · "${dm.name}"   ${current.length} → ${next.length} blackout(s), ${partialImported} partial`)
      for (const d of removed) {
        const temp = (d.name || '').includes(TEMP_MARKER)
        if (temp) tempRemoved++; else discoOnly++
        console.log(`     - ${describe(d)}${temp ? '   [temporary cover, expected]' : '   [NOT IN FM — will be deleted]'}`)
      }
      for (const d of added) console.log(`     + ${describe(d)}`)
      if (droppedWithIntervals.length) console.log(`     ! ${droppedWithIntervals.length} FM entry(ies) had unparseable intervals and were skipped`)

      if (EXECUTE) {
        await sql`
          UPDATE disco_menus SET skipped_days = ${JSON.stringify(next)}::jsonb, updated_at = NOW()
          WHERE reference = ${dm.reference}::uuid
        `
      }
    }
  }

  console.log(`\n${'='.repeat(72)}`)
  console.log(`menus ${EXECUTE ? 'updated' : 'to update'} : ${changed}`)
  console.log(`partial-day blackouts now carried : ${partials}`)
  console.log(`temporary cover entries removed   : ${tempRemoved}`)
  console.log(`Disco-only blackouts deleted      : ${discoOnly}${discoOnly ? '   <-- review these' : ''}`)
  console.log(`menus with no FM name match       : ${unmatched}`)
  console.log('='.repeat(72))
  if (!EXECUTE) console.log('\nRe-run with --execute to write.')
}

main().catch(e => { console.error(e); process.exit(1) })
