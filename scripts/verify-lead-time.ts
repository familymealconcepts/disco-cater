/**
 * Verification for the two lead-time fixes. READ-ONLY.
 *
 *  (a) The DAILY cutoff is a deadline for placing an order, not a floor on the
 *      pickup time.
 *  (b) Lead time is evaluated on the RESTAURANT's clock, not the runtime's.
 *
 * Both are diffed against FM's live availablePickUp for restaurants in four
 * timezones. The decisive check is the last one: the PICKER (what the customer's
 * browser offers) and the PLACEMENT GATE (isDateTimeBookable, which runs on
 * Vercel in UTC) must return the same answer for the same order. That
 * disagreement is what produced a failed checkout, so it is asserted directly
 * rather than inferred from the two halves separately.
 *
 * Run it under several TZs — the point is that the answer no longer moves:
 *   TZ=UTC                  npx tsx scripts/verify-lead-time.ts
 *   TZ=America/New_York     npx tsx scripts/verify-lead-time.ts
 *   TZ=America/Los_Angeles  npx tsx scripts/verify-lead-time.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { buildAvailableTimes, isDateTimeBookable } from '../lib/scheduling/cutoffs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const dd = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}` }
const isoPlus = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// Deliberately spread across zones AND across the two defects:
//   Northside  — cutOffType=DAILY, cutOff 13:00, window opens 09:00  → defect (a)
//   Razzis     — America/Los_Angeles, no cutoff                      → defect (b)
//   Pelons     — DAILY cutoff 19:00, opens 10:30, America/Chicago    → both
//   El Gallo   — America/New_York control (was already correct)
const TARGETS: [string, string][] = [
  ['Northside Inc. Cafe',        '79adde42-639c-442b-8e31-781e3003b5c9'],
  ['Razzis Pizzeria - Downtown', '0f293250-4cef-4a00-a7c6-ee6c6ffff0a0'],
  ['Pelons Tex Mex',             '29f6688e-ee59-4226-af9f-8525c53fd8ec'],
  ['El Gallo Taqueria',          '4c6489e6-dd34-4a47-8552-9136a7e2cc13'],
  ['Surf Taco - Manasquan',      '90104ec3-9713-4a1d-bb90-25362266842f'],
]

async function main() {
  console.log(`runtime TZ = ${Intl.DateTimeFormat().resolvedOptions().timeZone}   now = ${new Date().toISOString()}\n`)

  for (const [name, ref] of TARGETS) {
    // No ::uuid — this column is TEXT (disco_menus' is UUID). Casting throws.
    const tzRows = (await sql`
      SELECT timezone FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
    `) as unknown as { timezone: string | null }[]
    const timezone = tzRows[0]?.timezone ?? null
    if (!timezone) { failures++; console.log(`   FAIL  no timezone on record for ${ref} — the fix cannot apply`) }
    console.log(`── ${name}  (${timezone ?? 'no timezone'}) ──`)

    const menus = await (await fetch(`${FM}/public-api/menu?restaurantReference=${ref}`)).json() as Record<string, any>[]
    for (const m of (Array.isArray(menus) ? menus : []).filter(x => !x.archived)) {
      if (!m.scheduleOption) continue
      const sched = { ...m.scheduleOption, timezone }
      const cats = await (await fetch(`${FM}/public-api/restaurants/${ref}/mealPackages?menuReference=${m.reference}`)).json() as Record<string, any>[]
      const pkg = (Array.isArray(cats) ? cats : []).flatMap(c => c.mealPackages || [])[0]
      if (!pkg) continue
      const cut = m.scheduleOption.cutOffType === 'DAILY' ? ` cutoff ${String(m.scheduleOption.cutOff).slice(0, 5)}` : ''
      console.log(`   menu "${m.name}"  prepTime=${m.scheduleOption.prepTime}h${cut}`)

      for (let i = 0; i < 6; i++) {
        const date = isoPlus(i)
        const raw = await (await fetch(`${FM}/public-api/mealPackages/${pkg.reference}/availablePickUp?localDate=${dd(date)}`)).json() as unknown
        const fm = (Array.isArray(raw) ? raw : []).map((t: { localTime: string }) => t.localTime.slice(0, 5)).sort()
        const picker = buildAvailableTimes(sched, date).filter(t => !t.disabled).map(t => t.time.slice(0, 5))
        if (!fm.length && !picker.length) continue

        const fmSet = new Set(fm)
        const hole = picker.filter(t => !fmSet.has(t))
        const missing = fm.filter((t: string) => !picker.includes(t))
        check(
          `${date}  FM ${String(fm.length).padStart(3)} / picker ${String(picker.length).padStart(3)}`,
          hole.length === 0 && missing.length === 0,
          hole.length ? `HOLE ${hole.slice(0, 6).join(' ')}` : missing.length ? `MISSING ${missing.slice(0, 6).join(' ')}${missing.length > 6 ? ` (+${missing.length - 6})` : ''}` : '',
        )

        // THE ONE THAT PRODUCES A FAILED CHECKOUT. Sample across the day
        // (including the boundaries and times just outside) and require the
        // picker and the gate to agree on every one.
        const probes = [...new Set([
          ...picker.slice(0, 2), ...picker.slice(-2),
          ...fm.slice(0, 2), ...fm.slice(-2),
          '00:15', '09:00', '12:00', '18:00', '23:30',
        ])]
        const disagreements = probes.filter(t =>
          picker.includes(t) !== isDateTimeBookable(sched, date, t))
        check(`${date}  picker and placement gate agree on ${probes.length} probe time(s)`,
          disagreements.length === 0, disagreements.length ? `DISAGREE ${disagreements.join(' ')}` : '')
      }
    }
    console.log('')
  }

  console.log('='.repeat(70))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
