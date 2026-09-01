/**
 * What does FM's DAILY cutoff actually MEAN?
 *
 * READ-ONLY. Disco's earliestPickup rolls the earliest bookable DAY forward by
 * one whenever the current time-of-day is past the cutoff. Pelons Tex Mex shows
 * FM does not agree (FM 45 slots, Disco 0). One restaurant is an anecdote, so
 * this tests the rule across every DAILY-cutoff menu in the estate.
 *
 * THREE HYPOTHESES, each scored against FM's live availablePickUp:
 *   H0  current Disco — roll the day forward when now > cutoff
 *   H1  no roll at all — the cutoff never moves the date
 *   H2  same-day only — the cutoff blocks TODAY, never a later date
 *
 * "Several times of day" without waiting: `now` is fixed, but every restaurant
 * has a DIFFERENT cutoff and a different timezone, so the estate gives a natural
 * spread of before-cutoff and after-cutoff cases at one instant. Each row is
 * labelled with which side of its own cutoff it currently sits, and results are
 * broken out by that, by scheduleType and by prepTime.
 *
 *   npx tsx scripts/audit-daily-cutoff-semantics.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { buildAvailableTimes } from '../lib/scheduling/cutoffs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const dd = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}` }
const CONCURRENCY = 6
const HORIZON = 5

const hhmm = (t: string) => { const [h, m] = String(t).split(':'); return Number(h) * 60 + Number(m || 0) }

/** Local wall clock in a zone, as "HH:MM" + the local ISO date. */
function localNow(tz: string | null): { minutes: number; date: string } {
  const d = new Date()
  if (!tz) return { minutes: d.getHours() * 60 + d.getMinutes(), date: d.toISOString().slice(0, 10) }
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(d)
  const g = (t: string) => p.find(x => x.type === t)?.value ?? '0'
  let h = Number(g('hour')); if (h === 24) h = 0
  return { minutes: h * 60 + Number(g('minute')), date: `${g('year')}-${g('month')}-${g('day')}` }
}
function isoPlus(base: string, n: number) {
  const d = new Date(base + 'T12:00:00'); d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

interface Case {
  restaurant: string; ref: string; menu: string; tz: string | null
  scheduleType: string; prepTime: number; cutOff: string
  pastCutoff: boolean
  fmFirst: string | null; fmFirstCount: number; fmFirstSlot: string
  h0First: string | null; h0CountOnFmFirst: number
  h1First: string | null; h1CountOnFmFirst: number
  h2First: string | null; h2CountOnFmFirst: number
  slotsLost: number
  live: boolean
}

async function mapLimit<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++])
  }))
}

async function main() {
  const rows = (await sql`
    SELECT restaurant_reference AS ref, name, timezone, COALESCE(is_live,false) AS live
    FROM disco_restaurant_cache WHERE archived_at IS NULL ORDER BY name
  `) as unknown as { ref: string; name: string; timezone: string | null; live: boolean }[]

  const cases: Case[] = []
  let menusSeen = 0

  await mapLimit(rows, CONCURRENCY, async (r) => {
    let menus: Record<string, any>[] = []
    try {
      const res = await fetch(`${FM}/public-api/menu?restaurantReference=${r.ref}`, { headers: { Accept: 'application/json' } })
      if (!res.ok) return
      const raw = await res.json()
      menus = (Array.isArray(raw) ? raw : []).filter((m: Record<string, any>) => !m.archived)
    } catch { return }

    for (const m of menus) {
      const so = m.scheduleOption
      if (!so || so.cutOffType !== 'DAILY' || !so.cutOff) continue
      menusSeen++

      const cats = await (await fetch(`${FM}/public-api/restaurants/${r.ref}/mealPackages?menuReference=${m.reference}`)).json() as Record<string, any>[]
      const pkg = (Array.isArray(cats) ? cats : []).flatMap(c => c.mealPackages || [])[0]
      if (!pkg) continue

      const ln = localNow(r.timezone)
      const pastCutoff = ln.minutes > hhmm(so.cutOff)

      // Three schedule shapes fed to the SAME slot builder.
      const h0 = { ...so, timezone: r.timezone }                                  // as shipped
      const h1 = { ...so, cutOffType: null, cutOff: null, timezone: r.timezone }  // no roll
      // H2: the cutoff blocks TODAY only. Modelled by using h1 and dropping
      // today's date from consideration when we're past the cutoff.
      const h2Blocked = pastCutoff ? ln.date : null

      let fmFirst: string | null = null, fmFirstCount = 0, fmFirstSlot = ''
      let h0First: string | null = null, h1First: string | null = null, h2First: string | null = null
      let h0Count = 0, h1Count = 0, h2Count = 0

      for (let i = 0; i < HORIZON; i++) {
        const date = isoPlus(ln.date, i)
        const raw = await (await fetch(`${FM}/public-api/mealPackages/${pkg.reference}/availablePickUp?localDate=${dd(date)}`)).json() as unknown
        const fm = (Array.isArray(raw) ? raw : []).map((t: { localTime: string }) => t.localTime.slice(0, 5)).sort()
        const a0 = buildAvailableTimes(h0 as never, date).filter(t => !t.disabled)
        const a1 = buildAvailableTimes(h1 as never, date).filter(t => !t.disabled)
        const a2 = date === h2Blocked ? [] : a1

        if (!fmFirst && fm.length) { fmFirst = date; fmFirstCount = fm.length; fmFirstSlot = fm[0] }
        if (!h0First && a0.length) h0First = date
        if (!h1First && a1.length) h1First = date
        if (!h2First && a2.length) h2First = date
        if (fmFirst === date) { h0Count = a0.length; h1Count = a1.length; h2Count = a2.length }
      }

      if (!fmFirst) continue
      cases.push({
        restaurant: r.name, ref: r.ref, menu: String(m.name).trim(), tz: r.timezone,
        scheduleType: String(so.scheduleType ?? '?'), prepTime: Number(so.prepTime ?? 0),
        cutOff: String(so.cutOff).slice(0, 5), pastCutoff,
        fmFirst, fmFirstCount, fmFirstSlot,
        h0First, h0CountOnFmFirst: h0Count,
        h1First, h1CountOnFmFirst: h1Count,
        h2First, h2CountOnFmFirst: h2Count,
        slotsLost: Math.max(0, fmFirstCount - h0Count),
        live: r.live,
      })
    }
  })

  const now = new Date()
  console.log(`now (UTC) ${now.toISOString()}`)
  console.log(`${menusSeen} DAILY-cutoff menu(s) found; ${cases.length} with a bookable day inside ${HORIZON} days\n`)

  const score = (k: 'h0First' | 'h1First' | 'h2First') => cases.filter(c => c[k] === c.fmFirst).length
  const scoreCount = (k: 'h0CountOnFmFirst' | 'h1CountOnFmFirst' | 'h2CountOnFmFirst') =>
    cases.filter(c => c[k] === c.fmFirstCount).length

  console.log('── WHICH HYPOTHESIS MATCHES FM ──')
  console.log(`   H0 current (roll the day)   first-day match ${score('h0First')}/${cases.length}   slot-count match ${scoreCount('h0CountOnFmFirst')}/${cases.length}`)
  console.log(`   H1 no roll                  first-day match ${score('h1First')}/${cases.length}   slot-count match ${scoreCount('h1CountOnFmFirst')}/${cases.length}`)
  console.log(`   H2 blocks TODAY only        first-day match ${score('h2First')}/${cases.length}   slot-count match ${scoreCount('h2CountOnFmFirst')}/${cases.length}`)

  const past = cases.filter(c => c.pastCutoff)
  const before = cases.filter(c => !c.pastCutoff)
  console.log(`\n── SPLIT BY WHERE 'NOW' SITS RELATIVE TO EACH CUTOFF ──`)
  for (const [label, set] of [['PAST the cutoff', past], ['BEFORE the cutoff', before]] as const) {
    if (!set.length) { console.log(`   ${label}: none right now`); continue }
    console.log(`   ${label} (${set.length} menu(s)):`)
    console.log(`      H0 ${set.filter(c => c.h0First === c.fmFirst).length}/${set.length}   H1 ${set.filter(c => c.h1First === c.fmFirst).length}/${set.length}   H2 ${set.filter(c => c.h2First === c.fmFirst).length}/${set.length}`)
  }

  console.log(`\n── BY scheduleType ──`)
  for (const st of [...new Set(cases.map(c => c.scheduleType))]) {
    const set = cases.filter(c => c.scheduleType === st)
    console.log(`   ${st.padEnd(10)} n=${String(set.length).padStart(2)}  H0 ${set.filter(c => c.h0First === c.fmFirst).length}  H1 ${set.filter(c => c.h1First === c.fmFirst).length}  H2 ${set.filter(c => c.h2First === c.fmFirst).length}`)
  }
  console.log(`\n── BY prepTime ──`)
  for (const pt of [...new Set(cases.map(c => c.prepTime))].sort((a, b) => a - b)) {
    const set = cases.filter(c => c.prepTime === pt)
    console.log(`   ${String(pt).padStart(5)}h n=${String(set.length).padStart(2)}  H0 ${set.filter(c => c.h0First === c.fmFirst).length}  H1 ${set.filter(c => c.h1First === c.fmFirst).length}  H2 ${set.filter(c => c.h2First === c.fmFirst).length}`)
  }

  const losing = cases.filter(c => c.slotsLost > 0).sort((a, b) => b.slotsLost - a.slotsLost)
  console.log(`\n── SLOTS LOST ON FM's FIRST BOOKABLE DAY (H0 as shipped) ──`)
  console.log(`   ${losing.length} menu(s) across ${new Set(losing.map(c => c.ref)).size} restaurant(s) (${new Set(losing.filter(c => c.live).map(c => c.ref)).size} live) lose slots`)
  console.log(`   total slots lost: ${losing.reduce((a, c) => a + c.slotsLost, 0)}\n`)
  losing.slice(0, 25).forEach(c => console.log(
    `   ${c.live ? 'LIVE' : '    '} -${String(c.slotsLost).padStart(3)}  ${c.restaurant.slice(0, 28).padEnd(28)} ${c.menu.slice(0, 20).padEnd(20)} ` +
    `${c.scheduleType.padEnd(9)} prep ${String(c.prepTime).padStart(5)}h cut ${c.cutOff} ${c.pastCutoff ? 'PAST ' : 'before'}  ` +
    `FM ${c.fmFirst} ${String(c.fmFirstCount).padStart(3)} from ${c.fmFirstSlot} | H0 ${c.h0First ?? '-'} ${String(c.h0CountOnFmFirst).padStart(3)} | H1 ${String(c.h1CountOnFmFirst).padStart(3)}`))
  if (losing.length > 25) console.log(`   … and ${losing.length - 25} more`)

  // ── THE DISCRIMINATING CASES ────────────────────────────────────────────
  // A "match" is cheap when H0 and H1 give the same answer (the next day isn't a
  // window day, the lead time dominates, ...). Only cases where they DISAGREE
  // say anything about the rule, so score those separately.
  const disc = cases.filter(c => c.h0First !== c.h1First)
  console.log(`\n── DISCRIMINATING CASES (H0 and H1 actually disagree): ${disc.length} ──`)
  const h0w = disc.filter(c => c.h0First === c.fmFirst)
  const h1w = disc.filter(c => c.h1First === c.fmFirst)
  const neither = disc.filter(c => c.h0First !== c.fmFirst && c.h1First !== c.fmFirst)
  console.log(`   FM agrees with H0 (roll):    ${h0w.length}`)
  console.log(`   FM agrees with H1 (no roll): ${h1w.length}`)
  console.log(`   FM agrees with neither:      ${neither.length}`)
  const fmt = (c: Case) => `      prep ${String(c.prepTime).padStart(5)}h  ${c.scheduleType.padEnd(9)} cut ${c.cutOff}  ` +
    `${c.restaurant.slice(0, 26).padEnd(26)} ${c.menu.slice(0, 18).padEnd(18)} FM ${c.fmFirst} | H0 ${c.h0First ?? '-'} | H1 ${c.h1First ?? '-'}`
  console.log(`\n   ROLL IS RIGHT (FM = H0):`); h0w.forEach(c => console.log(fmt(c)))
  console.log(`\n   ROLL IS WRONG (FM = H1):`); h1w.forEach(c => console.log(fmt(c)))
  if (neither.length) { console.log(`\n   NEITHER:`); neither.forEach(c => console.log(fmt(c))) }

  const wholeDays = (h: number) => h > 0 && h % 24 === 0
  console.log(`\n   Split of the discriminating cases by whether prepTime is a whole number of DAYS:`)
  console.log(`      prepTime % 24 == 0 :  roll right ${h0w.filter(c => wholeDays(c.prepTime)).length}, roll wrong ${h1w.filter(c => wholeDays(c.prepTime)).length}`)
  console.log(`      prepTime % 24 != 0 :  roll right ${h0w.filter(c => !wholeDays(c.prepTime)).length}, roll wrong ${h1w.filter(c => !wholeDays(c.prepTime)).length}`)

  // Where H1 would OVER-offer relative to FM: the safety question.
  const overshoot = cases.filter(c => c.h1First && c.fmFirst && c.h1First < c.fmFirst)
  console.log(`\n── SAFETY: cases where H1 (no roll) would offer a day FM does NOT: ${overshoot.length} ──`)
  overshoot.forEach(c => console.log(`   ${c.restaurant} | ${c.menu} | prep ${c.prepTime}h cut ${c.cutOff} ${c.pastCutoff ? 'PAST' : 'before'} | H1 ${c.h1First} vs FM ${c.fmFirst}`))
  const overshoot2 = cases.filter(c => c.h2First && c.fmFirst && c.h2First < c.fmFirst)
  console.log(`── SAFETY: cases where H2 would offer a day FM does NOT: ${overshoot2.length} ──`)
  overshoot2.forEach(c => console.log(`   ${c.restaurant} | ${c.menu} | prep ${c.prepTime}h cut ${c.cutOff} | H2 ${c.h2First} vs FM ${c.fmFirst}`))
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
