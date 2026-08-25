/**
 * Re-read two things the faithful importer never carried across:
 *   1. scheduleOption.skippedDays  -> disco_menus.skipped_days  (blackout dates)
 *   2. scheduleOption.prepTime     -> disco_menus.lead_time_hours, where the old
 *      `num(prepTime) || 24` turned an explicit FM 0 into a 24-hour lead time.
 *
 * DRY RUN BY DEFAULT; writing needs --apply.
 *
 *   npx tsx scripts/backfill-schedule-gaps.ts
 *   npx tsx scripts/backfill-schedule-gaps.ts --apply
 *
 * ONLY WHOLE-DAY SKIPS ARE IMPORTED, mirroring FM's own filter — see
 * fmSkippedDaysToDisco in lib/menu-import/fm-faithful-import.ts for the full
 * argument. Interval-bearing skips narrow FM's ordering WINDOW and leave the
 * date orderable; Disco's skipped_days has no intervals concept, so importing
 * one would black out a whole day FM allows. They are reported, not written.
 *
 * Name-matching is the only available join (FM's admin and customer menu objects
 * share no key), so an unmatched or ambiguous menu is SKIPPED and listed rather
 * than guessed at.
 */
import { neon } from '@neondatabase/serverless'
import { getFmServiceAuthHeader } from '../lib/fm-service-auth'
import { fmSkippedDaysToDisco } from '../lib/menu-import/fm-faithful-import'

const sql = neon(process.env.DATABASE_URL!)
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const APPLY = process.argv.includes('--apply')
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
const num = (v: unknown) => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }
const TODAY = new Date().toISOString().slice(0, 10)

type Range = { name?: string; fromDate: string; toDate: string }
const key = (r: Range) => `${r.fromDate}..${r.toDate}`

async function main() {
  const auth = await getFmServiceAuthHeader()
  const menus = (await sql`
    SELECT m.reference, m.restaurant_reference ref, m.name, c.name rest,
           m.skipped_days, m.lead_time_hours, m.rolling_availability_days
    FROM disco_menus m LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference::text = m.restaurant_reference::text
    ORDER BY c.name, m.name
  `) as Record<string, unknown>[]
  const refs = [...new Set(menus.map(m => String(m.ref)))]

  console.log(APPLY ? '*** APPLY MODE — THIS WILL WRITE ***' : 'DRY RUN — nothing will be written')
  console.log(`${menus.length} native menus across ${refs.length} restaurants   (today = ${TODAY})\n`)

  const skipWrites: { reference: string; ranges: Range[] }[] = []
  const leadWrites: { reference: string; hours: number; was: number }[] = []
  let unmatched = 0, intervalsDropped = 0, futureRanges = 0, pastRanges = 0

  for (const ref of refs) {
    const res = await fetch(`${FM}/api/admin/menu?restaurantReference=${ref}&page=0&size=200`, { headers: { ...auth, Accept: 'application/json' } })
    if (!res.ok) { console.log(`!! ${ref}: FM HTTP ${res.status} — SKIPPED`); continue }
    const j = await res.json() as Record<string, unknown>
    const fmMenus = (j.content ?? j.data ?? (Array.isArray(j) ? j : [])) as Record<string, unknown>[]
    const mine = menus.filter(m => String(m.ref) === ref)
    const header = String(mine[0]?.rest ?? ref)
    const lines: string[] = []

    for (const dm of mine) {
      const cand = fmMenus.filter(f => norm(f.name) === norm(dm.name))
      if (cand.length !== 1) {
        unmatched++
        lines.push(`   ?? "${dm.name}" — ${cand.length === 0 ? 'NO FM menu with this name' : `${cand.length} FM menus share this name`} — SKIPPED`)
        continue
      }
      const sched = (cand[0].scheduleOption ?? {}) as Record<string, unknown>
      const { skippedDays: fmRanges, droppedWithIntervals } = fmSkippedDaysToDisco(sched)
      intervalsDropped += droppedWithIntervals.length

      // ── skipped_days ──
      const cur = (Array.isArray(dm.skipped_days) ? dm.skipped_days : []) as Range[]
      const have = new Set(cur.map(key))
      const adding = fmRanges.filter(r => !have.has(key(r)))
      if (adding.length) {
        // Union, so a range added by hand in Disco is never destroyed.
        const merged = [...cur, ...adding]
        skipWrites.push({ reference: String(dm.reference), ranges: merged })
        lines.push(`   ~~ "${dm.name}"  +${adding.length} blackout range(s)  (Disco had ${cur.length})`)
        for (const r of adding) {
          const future = r.toDate >= TODAY
          if (future) futureRanges++; else pastRanges++
          lines.push(`        ${future ? 'FUTURE' : 'past  '}  ${r.fromDate}..${r.toDate}  ${r.name ? `"${r.name}"` : ''}`)
        }
      }
      if (droppedWithIntervals.length) {
        for (const d of droppedWithIntervals) {
          lines.push(`        (not imported: ${d.fromDate}..${d.toDate} "${d.name || '—'}" has ${d.intervals} time interval(s) — FM does not block this date either)`)
        }
      }

      // ── lead_time_hours ──
      if (sched.prepTime != null) {
        const want = num(sched.prepTime)
        const was = Number(dm.lead_time_hours ?? 0)
        if (want !== was) {
          leadWrites.push({ reference: String(dm.reference), hours: want, was })
          lines.push(`   ~~ "${dm.name}"  lead_time_hours ${was} -> ${want}   (FM prepTime=${sched.prepTime})`)
        }
      }
    }
    if (lines.length) { console.log(`── ${header}`); console.log(lines.join('\n')) }
  }

  console.log(`\n=== summary ===`)
  console.log(`  menus gaining blackout ranges : ${skipWrites.length}`)
  console.log(`    ranges in the FUTURE (live risk today) : ${futureRanges}`)
  console.log(`    ranges already in the past (historical): ${pastRanges}`)
  console.log(`  menus with a lead_time_hours correction : ${leadWrites.length}`)
  console.log(`  FM skips NOT imported (carry time intervals): ${intervalsDropped}`)
  console.log(`  skipped, name unmatched : ${unmatched}`)

  if (!APPLY) { console.log(`\nDRY RUN — no writes. Re-run with --apply.`); return }
  for (const w of skipWrites) {
    await sql`UPDATE disco_menus SET skipped_days = ${JSON.stringify(w.ranges)}::jsonb, updated_at = NOW() WHERE reference = ${w.reference}::uuid`
  }
  for (const w of leadWrites) {
    await sql`UPDATE disco_menus SET lead_time_hours = ${w.hours}, updated_at = NOW() WHERE reference = ${w.reference}::uuid`
  }
  console.log(`\nwrote ${skipWrites.length} skipped_days and ${leadWrites.length} lead_time_hours.`)
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
