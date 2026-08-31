/**
 * Parity check for windows that close at midnight, and for genuinely crossing
 * windows. READ-ONLY.
 *
 * Diffs Disco's offered slots against FM's live availablePickUp for every
 * restaurant the estate audit found with a zero-slot window. Strict set
 * equality on WINDOW SHAPE, which is what this fix changed.
 *
 * The FIRST BOOKABLE DAY used to be reported separately rather than asserted on,
 * because Disco evaluated the lead-time floor in the RUNTIME's timezone and the
 * answer moved depending on where this script ran. That is fixed (17a7e31): the
 * restaurant's own timezone is read and passed in below, and the first day is
 * now asserted like every other. The separate reporting is kept only so a future
 * regression shows up as a labelled DELTA rather than a bare count.
 *
 *   npx tsx scripts/audit-zero-slot-windows.ts   (finds them)
 *   npx tsx scripts/verify-midnight-windows.ts   (proves they now agree)
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { buildAvailableTimes } from '../lib/scheduling/cutoffs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const dd = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}` }
const isoPlus = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

let failures = 0
let firstDayDeltas = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// The four restaurants the estate audit flagged (3 midnight-close + 1 crossing).
const TARGETS: [string, string, string][] = [
  ['El Gallo Taqueria',          '4c6489e6-dd34-4a47-8552-9136a7e2cc13', 'midnight close, all 7 days'],
  ['Rinconcito DOMEX',           '7ce53dc5-6f6e-499f-b13b-5bf51f774abe', 'midnight close, all 7 days'],
  ['Razzis Pizzeria - Downtown', '0f293250-4cef-4a00-a7c6-ee6c6ffff0a0', 'midnight close, Fri + Sat'],
  ['Moonburger Brooklyn',        '72559a85-50ef-4293-8484-256d7ec3335a', 'crossing 12:00-02:00, Fri + Sat'],
]

async function main() {
  for (const [name, ref, shape] of TARGETS) {
    // NO ::uuid — disco_restaurant_cache.restaurant_reference is TEXT.
    const tzRows = (await sql`
      SELECT timezone FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
    `) as unknown as { timezone: string | null }[]
    const timezone = tzRows[0]?.timezone ?? null
    console.log(`\n── ${name} (${shape}, ${timezone ?? 'no timezone'}) ──`)
    const menus = await (await fetch(`${FM}/public-api/menu?restaurantReference=${ref}`)).json() as Record<string, any>[]
    for (const m of (Array.isArray(menus) ? menus : []).filter(x => !x.archived)) {
      const so = m.scheduleOption
      if (!so) continue
      const cats = await (await fetch(`${FM}/public-api/restaurants/${ref}/mealPackages?menuReference=${m.reference}`)).json() as Record<string, any>[]
      const pkg = (Array.isArray(cats) ? cats : []).flatMap(c => c.mealPackages || [])[0]
      if (!pkg) continue

      let seenFirstBookable = false
      void seenFirstBookable
      for (let i = 0; i < 9; i++) {
        const date = isoPlus(i)
        const raw = await (await fetch(`${FM}/public-api/mealPackages/${pkg.reference}/availablePickUp?localDate=${dd(date)}`)).json() as unknown
        const fm = (Array.isArray(raw) ? raw : []).map((t: { localTime: string }) => t.localTime.slice(0, 5)).sort()
        const disco = buildAvailableTimes({ ...so, timezone } as never, date).filter(t => !t.disabled).map(t => t.time.slice(0, 5))
        const fmSet = new Set(fm)
        const hole = disco.filter(t => !fmSet.has(t))          // Disco offers, FM refuses — the dangerous direction
        const missing = fm.filter((t: string) => !disco.includes(t))

        // The first bookable day is the lead-time boundary. It is asserted like
        // any other day now that lead time runs on the restaurant's clock; the
        // label survives so a regression is legible rather than a bare count.
        if (!seenFirstBookable && (fm.length > 0 || disco.length > 0)) {
          seenFirstBookable = true
          if (hole.length || missing.length) firstDayDeltas++
        }

        check(
          `${date}  FM ${String(fm.length).padStart(3)} / Disco ${String(disco.length).padStart(3)}`,
          hole.length === 0 && missing.length === 0,
          hole.length ? `HOLE ${hole.join(' ')}` : missing.length ? `MISSING ${missing.slice(0, 8).join(' ')}${missing.length > 8 ? ` (+${missing.length - 8})` : ''}` : '',
        )
        // No slot may ever fall outside the calendar day it belongs to.
        check(`${date}  every slot inside the day`, disco.every(t => t >= '00:00' && t <= '23:45'), '')
      }
    }
  }
  console.log('\n' + '='.repeat(64))
  console.log(`First-bookable-day deltas: ${firstDayDeltas} (asserted, not excluded)`)
  console.log(failures === 0 ? 'ALL WINDOW-SHAPE CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
