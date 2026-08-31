/**
 * Estate-wide audit for pickup windows that produce ZERO bookable slots.
 *
 * READ-ONLY. Same silent-failure class as the dead notification domain: the day
 * simply does not appear, nothing errors, and no customer or restaurant is told.
 *
 * Classifies every day-of-week window on every live menu:
 *   MIDNIGHT   to === 00:00           — the Razzis shape
 *   INVERTED   to <  from  (non-zero) — a genuinely crossing window (22:00-02:00)
 *   TOO_SHORT  0 < to - from < step   — a window narrower than one slot
 *   OK
 *
 * FM-backed menus are read from FM's scheduleOption (the same source the customer
 * page derives its grid from); native menus from disco_menus.schedule_config.
 *
 * Scans EVERY unarchived restaurant, not just the 321 flagged is_live — is_live is
 * a narrow operational flag, and a window this broken is worth knowing about before
 * a restaurant goes live, not after.
 *
 *   npx tsx scripts/audit-zero-slot-windows.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { buildNativeScheduleOption } from '../lib/scheduling/native-schedule'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const SLOT_MINUTES = 15
const CONCURRENCY = 24

const hhmm = (t: string): number => {
  const [h, m] = String(t).split(':')
  return Number(h) * 60 + Number(m || 0)
}

type Verdict = 'OK' | 'MIDNIGHT' | 'INVERTED' | 'TOO_SHORT'
function classify(from: string, to: string): Verdict {
  const f = hhmm(from), t = hhmm(to)
  if (!Number.isFinite(f) || !Number.isFinite(t)) return 'OK'
  if (f === t) return 'OK'                      // single seating — one slot, by design
  if (t === 0) return 'MIDNIGHT'
  if (t < f) return 'INVERTED'
  if (t - f < SLOT_MINUTES) return 'TOO_SHORT'
  return 'OK'
}

interface Finding {
  restaurant: string; ref: string; native: boolean; live: boolean
  menu: string; days: string; window: string; verdict: Verdict
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]) }
  }))
  return out
}

async function main() {
  const rows = (await sql`
    SELECT restaurant_reference AS ref, name, COALESCE(is_disco_native, false) AS native,
           COALESCE(is_live, false) AS live
    FROM disco_restaurant_cache
    WHERE archived_at IS NULL
    ORDER BY name
  `) as unknown as { ref: string; name: string; native: boolean; live: boolean }[]

  console.log(`Scanning ${rows.length} unarchived restaurants (${rows.filter(r => r.native).length} native)\n`)

  const findings: Finding[] = []
  let menusScanned = 0, windowsScanned = 0, unreachable = 0

  await mapLimit(rows, CONCURRENCY, async (r) => {
    let menus: { name: string; windows: { from: string; to: string; days: string }[] }[] = []
    try {
      if (r.native) {
        const m = (await sql`
          SELECT name, schedule_config, availability_mode, start_date, end_date
          FROM disco_menus WHERE restaurant_reference = ${r.ref}::uuid AND NOT archived
        `) as unknown as Record<string, unknown>[]
        menus = m.map(x => {
          const so = buildNativeScheduleOption(
            x.schedule_config as never, x.availability_mode as never,
            x.start_date as never, x.end_date as never,
          ) as { repeatWeekDays?: { fromPickUpTime?: string; toPickUpTime?: string; days?: string }[] }
          return {
            name: String(x.name ?? '(unnamed)'),
            windows: (so.repeatWeekDays ?? [])
              .filter(w => w?.fromPickUpTime && w?.toPickUpTime)
              .map(w => ({ from: w.fromPickUpTime as string, to: w.toPickUpTime as string, days: String(w.days ?? '?') })),
          }
        })
      } else {
        const res = await fetch(`${FM}/public-api/menu?restaurantReference=${r.ref}`, { headers: { Accept: 'application/json' } })
        if (!res.ok) { unreachable++; return }
        const raw = await res.json() as Record<string, any>[]
        menus = (Array.isArray(raw) ? raw : []).filter(m => !m.archived).map(m => ({
          name: String(m.name ?? '(unnamed)'),
          windows: (m.scheduleOption?.repeatWeekDays ?? [])
            .filter((w: any) => w?.fromPickUpTime && w?.toPickUpTime)
            .map((w: any) => ({ from: w.fromPickUpTime, to: w.toPickUpTime, days: String(w.days ?? '?') })),
        }))
      }
    } catch { unreachable++; return }

    for (const m of menus) {
      menusScanned++
      // Group identical windows so a 7-day-identical schedule reports once.
      const byShape = new Map<string, string[]>()
      for (const w of m.windows) {
        windowsScanned++
        const v = classify(w.from, w.to)
        if (v === 'OK') continue
        const key = `${w.from}|${w.to}|${v}`
        if (!byShape.has(key)) byShape.set(key, [])
        byShape.get(key)!.push(w.days.slice(0, 3))
      }
      for (const [key, days] of byShape) {
        const [from, to, verdict] = key.split('|')
        findings.push({
          restaurant: r.name, ref: r.ref, native: r.native, live: r.live, menu: m.name,
          days: days.join(','), window: `${from.slice(0, 5)}-${to.slice(0, 5)}`,
          verdict: verdict as Verdict,
        })
      }
    }
  })

  console.log(`Scanned ${menusScanned} live menus / ${windowsScanned} day-windows.`)
  if (unreachable) console.log(`${unreachable} restaurant(s) unreachable on FM (skipped, not counted clean).`)

  for (const v of ['MIDNIGHT', 'INVERTED', 'TOO_SHORT'] as Verdict[]) {
    const f = findings.filter(x => x.verdict === v)
    const restaurants = new Set(f.map(x => x.ref))
    const liveOnes = new Set(f.filter(x => x.live).map(x => x.ref))
    console.log(`\n── ${v} — ${f.length} window group(s) across ${restaurants.size} restaurant(s) (${liveOnes.size} is_live) ──`)
    for (const x of f) {
      console.log(`   ${x.native ? 'NATIVE' : 'FM    '}  ${x.live ? 'LIVE' : '    '}  ${x.restaurant}  |  ${x.menu}  |  ${x.window}  |  ${x.days}`)
    }
    if (!f.length) console.log('   (none)')
  }

  const affected = new Set(findings.map(x => x.ref))
  console.log(`\n${'='.repeat(72)}`)
  const affectedLive = new Set(findings.filter(x => x.live).map(x => x.ref))
  console.log(`${affected.size} restaurant(s) have at least one zero-slot window (${affectedLive.size} of them is_live).`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
