/**
 * Hard ("holiday") cutoff with an optional restaurant-local TIME.
 *
 *   npx tsx scripts/test-holiday-cutoff-time.ts
 *   TZ=America/Los_Angeles npx tsx scripts/test-holiday-cutoff-time.ts   # same answers in any runtime zone
 *
 * Pure — no database, no network. Asserts:
 *   1. date-only behaves EXACTLY as before (old wall-clock formula reproduced
 *      here and compared second-by-second around the boundary, several zones);
 *   2. a timed cutoff is open before / at, and closed after, the cutoff time;
 *   3. DST: fall-back and spring-forward dates resolve with the right offset,
 *      plus the skipped (02:30) and repeated (01:30) wall-clock times;
 *   4. a non-UTC zone (Los Angeles) where the UTC date has already rolled over;
 *   5. the engine (picker builders + isDateTimeBookable gate) honours it, and
 *      menuRowToScheduleExtras emits the unchanged string when time is NULL.
 */
import {
  isHardCutoffPassed, composeHardCutoff, zonedLocalToInstant, wallClockInZone,
  buildAvailableDates, buildAvailableTimes, isDateTimeBookable, orderingClosed, runSelfTests,
  type FmScheduleLike,
} from '../lib/scheduling/cutoffs'
import { menuRowToScheduleExtras, parseMenuSettingsInput } from '../lib/menu-settings'

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown) {
  if (got === want) { pass++; return }
  fail++
  console.error(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}
const Z = (iso: string) => new Date(iso)   // explicit-UTC instants only

console.log(`runtime TZ = ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)

// ── 1. DATE-ONLY IS UNCHANGED ────────────────────────────────────────────────
// The formula orderingClosed used before this change, verbatim:
//   isOrderingClosed(wallClockInZone(now, tz), { hardCutoff: new Date(`${d}T23:59:59`) })
const oldDateOnlyClosed = (now: Date, date: string, tz: string | null) =>
  wallClockInZone(now, tz).getTime() > new Date(`${date}T23:59:59`).getTime()

for (const tz of ['America/New_York', 'America/Los_Angeles', 'America/Chicago', 'UTC', null, 'Not/AZone']) {
  for (const date of ['2026-11-21', '2026-03-08', '2026-11-01', '2026-12-31']) {
    // Every second from 2 minutes before to 2 minutes after the local boundary,
    // plus a coarse sweep of ±36h, in both the restaurant's zone and the runtime's.
    const centers: number[] = []
    const z = zonedLocalToInstant(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10) + 1, 0, 0, 0, tz)
    if (z != null) centers.push(z)
    centers.push(new Date(`${date}T23:59:59`).getTime() + 1000)
    let mismatches = 0
    for (const c of centers) {
      for (let t = c - 120_000; t <= c + 120_000; t += 250) {
        const now = new Date(t)
        if (isHardCutoffPassed(now, date, tz) !== oldDateOnlyClosed(now, date, tz)) mismatches++
      }
      for (let t = c - 36 * 3_600_000; t <= c + 36 * 3_600_000; t += 600_000) {
        const now = new Date(t)
        if (isHardCutoffPassed(now, date, tz) !== oldDateOnlyClosed(now, date, tz)) mismatches++
      }
    }
    check(`1 date-only identical to old rule (${tz ?? 'null'} ${date})`, mismatches, 0)
  }
}
// And the concrete meaning: NY, cutoff 2026-11-21 → open all of the 21st local.
check('1 NY 21st 23:59:59.900 local open', isHardCutoffPassed(Z('2026-11-22T04:59:59.900Z'), '2026-11-21', 'America/New_York'), false)
check('1 NY 22nd 00:00:00 local closed', isHardCutoffPassed(Z('2026-11-22T05:00:00Z'), '2026-11-21', 'America/New_York'), true)
check('1 no cutoff → never closed', isHardCutoffPassed(Z('2030-01-01T00:00:00Z'), null, 'America/New_York'), false)
check('1 garbage → never closed (as before)', isHardCutoffPassed(Z('2030-01-01T00:00:00Z'), 'not-a-date', 'America/New_York'), false)

// composeHardCutoff / menuRowToScheduleExtras: NULL time emits the old string.
check('1 compose null time', composeHardCutoff('2026-11-21', null), '2026-11-21')
check('1 compose blank time', composeHardCutoff('2026-11-21', ''), '2026-11-21')
check('1 compose with time', composeHardCutoff('2026-11-21', '9:05'), '2026-11-21T09:05')
check('1 compose no date', composeHardCutoff(null, '17:00'), null)
check('1 extras date-only unchanged', menuRowToScheduleExtras({ hard_cutoff_date: '2026-11-21', hard_cutoff_time: null }).cutOffDate, '2026-11-21')
check('1 extras with time', menuRowToScheduleExtras({ hard_cutoff_date: '2026-11-21', hard_cutoff_time: '17:00' }).cutOffDate, '2026-11-21T17:00')
check('1 extras no cutoff', 'cutOffDate' in menuRowToScheduleExtras({ hard_cutoff_date: null, hard_cutoff_time: '17:00' }), false)
check('1 parse: time without date dropped', parseMenuSettingsInput({ hardCutoffTime: '17:00' }).hardCutoffTime, null)
check('1 parse: time kept with date', parseMenuSettingsInput({ hardCutoffDate: '2026-11-21', hardCutoffTime: '7:30' }).hardCutoffTime, '07:30')
check('1 parse: bad time → null', parseMenuSettingsInput({ hardCutoffDate: '2026-11-21', hardCutoffTime: '25:00' }).hardCutoffTime, null)

// ── 2. TIME BEFORE / AT / AFTER ──────────────────────────────────────────────
// NY, 2026-11-21 17:00 EST = 22:00:00Z. Inclusive of the cutoff second.
const NY = 'America/New_York'
check('2 one minute before → open', isHardCutoffPassed(Z('2026-11-21T21:59:00Z'), '2026-11-21T17:00', NY), false)
check('2 at 17:00:00 → open (inclusive)', isHardCutoffPassed(Z('2026-11-21T22:00:00Z'), '2026-11-21T17:00', NY), false)
check('2 at 17:00:00.999 → open', isHardCutoffPassed(Z('2026-11-21T22:00:00.999Z'), '2026-11-21T17:00', NY), false)
check('2 at 17:00:01 → closed', isHardCutoffPassed(Z('2026-11-21T22:00:01Z'), '2026-11-21T17:00', NY), true)
check('2 later that evening → closed (date-only would still be open)', isHardCutoffPassed(Z('2026-11-22T01:00:00Z'), '2026-11-21T17:00', NY), true)
check('2 ...date-only same instant → open', isHardCutoffPassed(Z('2026-11-22T01:00:00Z'), '2026-11-21', NY), false)
check('2 day before → open', isHardCutoffPassed(Z('2026-11-20T23:00:00Z'), '2026-11-21T17:00', NY), false)

// ── 3. DST ───────────────────────────────────────────────────────────────────
// Fall back: 2026-11-01 02:00 EDT → 01:00 EST. A 17:00 cutoff that day is EST
// (UTC-5) = 22:00Z. A fixed EDT offset would put it at 21:00Z.
check('3 fall-back day 17:00 → 22:00Z', zonedLocalToInstant(2026, 11, 1, 17, 0, 0, NY), Date.parse('2026-11-01T22:00:00Z'))
check('3 fall-back 21:30Z still open', isHardCutoffPassed(Z('2026-11-01T21:30:00Z'), '2026-11-01T17:00', NY), false)
check('3 fall-back 22:00:01Z closed', isHardCutoffPassed(Z('2026-11-01T22:00:01Z'), '2026-11-01T17:00', NY), true)
// Spring forward: 2026-03-08 02:00 EST → 03:00 EDT. 12:00 that day is EDT
// (UTC-4) = 16:00Z; a fixed EST offset would say 17:00Z.
check('3 spring day 12:00 → 16:00Z', zonedLocalToInstant(2026, 3, 8, 12, 0, 0, NY), Date.parse('2026-03-08T16:00:00Z'))
check('3 spring 16:30Z closed', isHardCutoffPassed(Z('2026-03-08T16:30:00Z'), '2026-03-08T12:00', NY), true)
check('3 spring 15:59Z open', isHardCutoffPassed(Z('2026-03-08T15:59:00Z'), '2026-03-08T12:00', NY), false)
// Skipped wall time 02:30 → 03:30 EDT (07:30Z). Repeated 01:30 → first (EDT, 05:30Z).
check('3 skipped 02:30 → 03:30 EDT', zonedLocalToInstant(2026, 3, 8, 2, 30, 0, NY), Date.parse('2026-03-08T07:30:00Z'))
check('3 repeated 01:30 → first occurrence', zonedLocalToInstant(2026, 11, 1, 1, 30, 0, NY), Date.parse('2026-11-01T05:30:00Z'))
check('3 repeated 01:30: second pass (06:15Z) is closed', isHardCutoffPassed(Z('2026-11-01T06:15:00Z'), '2026-11-01T01:30', NY), true)
// Date-only across DST: 2026-03-08 date-only closes at local midnight → 04:00Z on the 9th (EDT).
check('3 date-only spring day 03:59:59Z open', isHardCutoffPassed(Z('2026-03-09T03:59:59Z'), '2026-03-08', NY), false)
check('3 date-only spring day 04:00:00Z closed', isHardCutoffPassed(Z('2026-03-09T04:00:00Z'), '2026-03-08', NY), true)

// ── 4. A ZONE OTHER THAN UTC ─────────────────────────────────────────────────
// LA, 2026-11-25 17:00 PST = 2026-11-26 01:00Z. At 00:30Z the UTC date is
// already the 26th — past the cutoff DATE in UTC — but it is 16:30 in LA: open.
const LA = 'America/Los_Angeles'
check('4 LA 16:30 local (UTC already next day) open', isHardCutoffPassed(Z('2026-11-26T00:30:00Z'), '2026-11-25T17:00', LA), false)
check('4 LA 17:00:01 local closed', isHardCutoffPassed(Z('2026-11-26T01:00:01Z'), '2026-11-25T17:00', LA), true)
check('4 same instant read as NY would be closed', isHardCutoffPassed(Z('2026-11-26T00:30:00Z'), '2026-11-25T17:00', NY), true)
// Missing zone on a TIMED cutoff → America/New_York, not the runtime zone.
check('4 timed, no tz → NY', isHardCutoffPassed(Z('2026-11-21T22:00:01Z'), '2026-11-21T17:00', null), true)
check('4 timed, no tz → NY (before)', isHardCutoffPassed(Z('2026-11-21T21:59:00Z'), '2026-11-21T17:00', null), false)
check('4 timed, bad tz → NY', isHardCutoffPassed(Z('2026-11-21T22:00:01Z'), '2026-11-21T17:00', 'Not/AZone'), true)
check('4 absolute instant honoured', isHardCutoffPassed(Z('2026-11-21T12:00:01Z'), '2026-11-21T12:00:00Z', LA), true)

// ── 5. ENGINE: picker + server gate ─────────────────────────────────────────
// Thanksgiving pre-order: order by Tue 2026-11-24 15:00 LA, collect Wed 25 / Thu 26.
const sched: FmScheduleLike = {
  prepTime: 0, timezone: LA, cutOffDate: '2026-11-24T15:00', cutOffType: 'BY_DATE',
  repeatWeekDays: [{ days: 'WEDNESDAY,THURSDAY', fromPickUpTime: '10:00', toPickUpTime: '14:00' }],
}
const before = Z('2026-11-24T22:59:00Z')   // 14:59 LA
const after = Z('2026-11-24T23:01:00Z')    // 15:01 LA
check('5 picker: dates offered before cutoff', buildAvailableDates(sched, before, 3).filter(d => !d.disabled).map(d => d.date).join(','), '2026-11-25,2026-11-26')
check('5 picker: no dates after cutoff', buildAvailableDates(sched, after, 3).filter(d => !d.disabled).length, 0)
check('5 picker: times offered before', buildAvailableTimes(sched, '2026-11-26', before).filter(t => !t.disabled).length, 17)
check('5 picker: no times after', buildAvailableTimes(sched, '2026-11-26', after).filter(t => !t.disabled).length, 0)
check('5 banner: orderingClosed before', orderingClosed(sched, before), false)
check('5 banner: orderingClosed after', orderingClosed(sched, after), true)
check('5 GATE: accepts before cutoff', isDateTimeBookable(sched, '2026-11-26', '12:00', before), true)
check('5 GATE: refuses after cutoff', isDateTimeBookable(sched, '2026-11-26', '12:00', after), false)
// Same menu date-only (no time): still open at 15:01 on the 24th — unchanged rule.
const dateOnly = { ...sched, cutOffDate: '2026-11-24' }
check('5 GATE: date-only still open 15:01 same day', isDateTimeBookable(dateOnly, '2026-11-26', '12:00', after), true)
check('5 GATE: date-only closed next local day', isDateTimeBookable(dateOnly, '2026-11-26', '12:00', Z('2026-11-25T08:00:01Z')), false)
// Gate and picker agree around the boundary, second by second.
let disagreements = 0
for (let t = Date.parse('2026-11-24T22:58:00Z'); t <= Date.parse('2026-11-24T23:02:00Z'); t += 500) {
  const now = new Date(t)
  const offered = buildAvailableTimes(sched, '2026-11-26', now).some(x => !x.disabled && x.time.startsWith('12:00'))
  if (offered !== isDateTimeBookable(sched, '2026-11-26', '12:00', now)) disagreements++
}
check('5 picker/gate agree across the boundary', disagreements, 0)

// The module's own existing self-tests must still pass.
try { runSelfTests(); pass++ } catch (e) { fail++; console.error(e instanceof Error ? e.message : e) }

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
