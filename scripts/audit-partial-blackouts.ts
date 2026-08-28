/**
 * URGENT AUDIT — FM partial-day menu blackouts that Disco is not enforcing.
 *
 * READ-ONLY. Nothing is written.
 *
 * FM's SkippedDay is { name, intervals: TimeInterval[], fromDate, toDate }. An entry
 * with an EMPTY intervals array blocks the whole date; an entry WITH intervals blocks
 * only those hours and leaves the rest of the day orderable.
 *
 * Disco's disco_menus.skipped_days has no intervals concept, so the faithful importer
 * (fmSkippedDaysToDisco) applies FM's own filter — both dates present AND intervals
 * empty — and DROPS interval-bearing entries, counting them as
 * skippedDayIntervalsDropped. That was the right call against the alternative (a naive
 * copy would black out dates FM leaves open) but the consequence is that a customer
 * can book INTO a window the restaurant has closed.
 *
 * This lists every such window per restaurant, split into ones still in the future
 * (live exposure) and ones already past (no longer bookable anyway).
 *
 *   npx tsx scripts/audit-partial-blackouts.ts
 *   npx tsx scripts/audit-partial-blackouts.ts --ref <uuid>
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { getFmServiceAuthHeader } from '../lib/fm-service-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const ONLY_REF = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : null
const TODAY = new Date().toISOString().slice(0, 10)

interface Window { menu: string; date: string; toDate: string; from: string; to: string; label: string; future: boolean }

let auth: Record<string, string> | null = null
const fmGet = async (path: string): Promise<unknown> => {
  if (!auth) auth = await getFmServiceAuthHeader()
  const r = await fetch(`${FM}${path}`, { headers: { ...auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}
const arrOf = (d: unknown): Record<string, unknown>[] => {
  if (Array.isArray(d)) return d as Record<string, unknown>[]
  const o = d as { content?: unknown; data?: unknown } | null
  return (Array.isArray(o?.content) ? o!.content : Array.isArray(o?.data) ? o!.data : []) as Record<string, unknown>[]
}
// FM LocalTime is "H:mm:ss" — normalize to HH:mm for display/comparison.
const hhmm = (t: unknown) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ''))
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : String(t ?? '?')
}
const ampm = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  const ap = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`
}

async function main() {
  const restaurants = (await sql`
    SELECT DISTINCT c.restaurant_reference AS ref, c.name, c.is_live
    FROM disco_restaurant_cache c
    JOIN disco_menus m ON m.restaurant_reference = c.restaurant_reference::uuid AND NOT m.archived
    WHERE c.is_disco_native ${ONLY_REF ? sql`AND c.restaurant_reference = ${ONLY_REF}` : sql``}
    ORDER BY c.name
  `) as unknown as { ref: string; name: string; is_live: boolean }[]

  console.log(`Auditing ${restaurants.length} Disco-native restaurant(s) against FM. Today = ${TODAY}\n`)

  const exposed: { name: string; ref: string; isLive: boolean; windows: Window[] }[] = []
  let fmUnreachable = 0

  for (const r of restaurants) {
    let menus: Record<string, unknown>[]
    try {
      menus = arrOf(await fmGet(`/api/admin/menu?restaurantReference=${r.ref}`))
    } catch {
      fmUnreachable++
      continue   // no FM record (Disco-only / test restaurant) — nothing to be missing
    }
    const windows: Window[] = []
    let wholeDayInFm = 0
    for (const m of menus) {
      if (m.archived === true) continue
      const sched = (m.scheduleOption as Record<string, unknown> | undefined) ?? {}
      for (const sd of arrOf(sched.skippedDays)) {
        const fromDate = String(sd.fromDate ?? ''), toDate = String(sd.toDate ?? '')
        if (!fromDate || !toDate) continue
        const intervals = arrOf(sd.intervals)
        if (!intervals.length) { wholeDayInFm++; continue }   // imported fine
        for (const iv of intervals) {
          windows.push({
            menu: String(m.name ?? '?'), date: fromDate, toDate,
            from: hhmm(iv.fromTime), to: hhmm(iv.toTime),
            label: String(sd.name ?? ''), future: toDate >= TODAY,
          })
        }
      }
    }
    // Cross-check: what Disco actually holds for this restaurant.
    const stored = (await sql`
      SELECT COALESCE(SUM(jsonb_array_length(COALESCE(skipped_days, '[]'::jsonb))), 0)::int AS n
      FROM disco_menus WHERE restaurant_reference = ${r.ref}::uuid AND NOT archived
    `) as unknown as { n: number }[]

    if (windows.length === 0) continue
    exposed.push({ name: r.name, ref: r.ref, isLive: r.is_live, windows })
    const future = windows.filter(w => w.future)
    console.log(`── ${r.name}${r.is_live ? '' : '  (NOT LIVE)'}`)
    console.log(`   FM: ${wholeDayInFm} whole-day + ${windows.length} partial window(s)   |   Disco stores: ${stored[0]?.n ?? 0} blackout(s)`)
    for (const w of windows.sort((a, b) => a.date.localeCompare(b.date))) {
      console.log(`   ${w.future ? 'FUTURE ' : 'past   '} ${w.date}  ${ampm(w.from)} – ${ampm(w.to)}   ${w.label ? `“${w.label}”` : ''}${w.menu !== 'Catering Menu' ? `  [${w.menu}]` : ''}`)
    }
    console.log(`   → ${future.length} still bookable-into today\n`)
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalWindows = exposed.reduce((a, e) => a + e.windows.length, 0)
  const futureWindows = exposed.reduce((a, e) => a + e.windows.filter(w => w.future).length, 0)
  const liveExposed = exposed.filter(e => e.isLive && e.windows.some(w => w.future))

  console.log('='.repeat(84))
  console.log(`Restaurants with partial blackouts in FM : ${exposed.length}`)
  console.log(`  ...of which LIVE and still exposed     : ${liveExposed.length}`)
  console.log(`Partial windows total                    : ${totalWindows}`)
  console.log(`  ...still in the future (live exposure)  : ${futureWindows}`)
  console.log(`Restaurants with no FM record (skipped)   : ${fmUnreachable}`)
  console.log('='.repeat(84))

  if (liveExposed.length) {
    console.log('\nLIVE EXPOSURE — a customer can book into these windows right now:\n')
    for (const e of liveExposed) {
      const f = e.windows.filter(w => w.future).sort((a, b) => a.date.localeCompare(b.date))
      console.log(`  ${e.name}  [${e.ref}]  — ${f.length} window(s)`)
      for (const w of f) console.log(`      ${w.date}  ${ampm(w.from)} – ${ampm(w.to)}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
