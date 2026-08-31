/**
 * Estate-wide audit: how many restaurants lose bookable morning hours because
 * Disco treats FM's DAILY cutoff as a floor on the PICKUP time rather than as a
 * deadline for PLACING the order.
 *
 * READ-ONLY. A restaurant is affected when it has cutOffType=DAILY and a cutOff
 * later than the day's window start — the hours between window start and cutOff
 * are offered by FM and refused by Disco on the first bookable day.
 *
 *   npx tsx scripts/audit-daily-cutoff-floor.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { buildNativeScheduleOption } from '../lib/scheduling/native-schedule'
import { menuRowToScheduleExtras } from '../lib/menu-settings'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const CONCURRENCY = 24

const hhmm = (t: string): number => {
  const [h, m] = String(t).split(':')
  return Number(h) * 60 + Number(m || 0)
}
const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

interface Hit { name: string; ref: string; native: boolean; live: boolean; menu: string; cutOff: string; earliestWindow: string; lostMinutes: number }

async function mapLimit<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++])
  }))
}

async function main() {
  const rows = (await sql`
    SELECT restaurant_reference AS ref, name, COALESCE(is_disco_native,false) AS native, COALESCE(is_live,false) AS live
    FROM disco_restaurant_cache WHERE archived_at IS NULL ORDER BY name
  `) as unknown as { ref: string; name: string; native: boolean; live: boolean }[]

  const hits: Hit[] = []
  let menus = 0, withDaily = 0

  await mapLimit(rows, CONCURRENCY, async (r) => {
    let list: { name: string; cutOffType: string | null; cutOff: string | null; windows: { from: string }[] }[] = []
    try {
      if (r.native) {
        const m = (await sql`
          SELECT name, schedule_config, availability_mode, start_date, end_date,
                 lead_time_hours, rolling_availability_days, daily_cutoff_time, hard_cutoff_date, max_orders_per_day
          FROM disco_menus WHERE restaurant_reference = ${r.ref}::uuid AND NOT archived
        `) as unknown as Record<string, unknown>[]
        list = m.map(x => {
          const so = buildNativeScheduleOption(x.schedule_config as never, x.availability_mode as never, x.start_date as never, x.end_date as never) as { repeatWeekDays?: { fromPickUpTime?: string }[] }
          const ex = menuRowToScheduleExtras(x as never) as { cutOffType?: string | null; cutOff?: string | null }
          return {
            name: String(x.name ?? '?'), cutOffType: ex.cutOffType ?? null, cutOff: ex.cutOff ?? null,
            windows: (so.repeatWeekDays ?? []).filter(w => w?.fromPickUpTime).map(w => ({ from: w.fromPickUpTime as string })),
          }
        })
      } else {
        const res = await fetch(`${FM}/public-api/menu?restaurantReference=${r.ref}`, { headers: { Accept: 'application/json' } })
        if (!res.ok) return
        const raw = await res.json() as Record<string, any>[]
        list = (Array.isArray(raw) ? raw : []).filter(m => !m.archived).map(m => ({
          name: String(m.name ?? '?'),
          cutOffType: m.scheduleOption?.cutOffType ?? null,
          cutOff: m.scheduleOption?.cutOff ?? null,
          windows: (m.scheduleOption?.repeatWeekDays ?? []).filter((w: any) => w?.fromPickUpTime).map((w: any) => ({ from: w.fromPickUpTime })),
        }))
      }
    } catch { return }

    for (const m of list) {
      menus++
      if (m.cutOffType !== 'DAILY' || !m.cutOff) continue
      withDaily++
      const cut = hhmm(m.cutOff)
      const starts = m.windows.map(w => hhmm(w.from)).filter(Number.isFinite)
      if (!starts.length) continue
      const earliest = Math.min(...starts)
      if (cut <= earliest) continue          // cutoff at/before opening — no hours lost
      hits.push({
        name: r.name, ref: r.ref, native: r.native, live: r.live, menu: m.name,
        cutOff: fmt(cut), earliestWindow: fmt(earliest), lostMinutes: cut - earliest,
      })
    }
  })

  hits.sort((a, b) => b.lostMinutes - a.lostMinutes)
  console.log(`Scanned ${rows.length} restaurants / ${menus} live menus.`)
  console.log(`${withDaily} menu(s) use cutOffType=DAILY.`)
  const affected = new Set(hits.map(h => h.ref))
  const affectedLive = new Set(hits.filter(h => h.live).map(h => h.ref))
  console.log(`\n${hits.length} menu(s) across ${affected.size} restaurant(s) (${affectedLive.size} is_live) lose morning hours on the first bookable day:\n`)
  for (const h of hits.slice(0, 40)) {
    console.log(`   ${h.live ? 'LIVE' : '    '} ${h.native ? 'NATIVE' : 'FM    '}  ${(h.lostMinutes / 60).toFixed(2).padStart(5)}h lost  ${h.name} | ${h.menu} | opens ${h.earliestWindow}, cutoff ${h.cutOff}`)
  }
  if (hits.length > 40) console.log(`   ... and ${hits.length - 40} more`)
  const totalH = hits.reduce((a, h) => a + h.lostMinutes, 0) / 60
  console.log(`\nMedian hours lost per affected menu: ${(hits.length ? hits[Math.floor(hits.length / 2)].lostMinutes / 60 : 0).toFixed(2)}h; total across all: ${totalH.toFixed(1)}h`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
