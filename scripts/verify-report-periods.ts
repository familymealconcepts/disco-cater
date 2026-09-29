/**
 * Verifies the scheduled-report window maths: the three defects that affected
 * every report sent to date (partial current day, "monthly" = 31 days, UTC vs
 * local), plus every new range option and the due-check.
 *
 *   npx tsx scripts/verify-report-periods.ts
 */
import { resolvePeriod, isReportDue } from '../lib/reports/report-period'

let fail = 0
const chk = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : ` — expected ${JSON.stringify(want)}`}`)
}
const TZ = 'America/New_York'
// Monday 2026-09-28 09:00 in New York = 13:00Z
const mon = new Date('2026-09-28T13:00:00Z')

console.log('=== PREVIOUS_PERIOD ===')
chk('weekly from a Monday = the previous complete Mon–Sun',
  resolvePeriod({ frequency: 'WEEKLY', timezone: TZ }, mon), { from: '2026-09-21', to: '2026-09-27' })
chk('daily = yesterday only',
  resolvePeriod({ frequency: 'DAILY', timezone: TZ }, mon), { from: '2026-09-27', to: '2026-09-27' })
chk('monthly on the 1st = the whole previous CALENDAR month',
  resolvePeriod({ frequency: 'MONTHLY', timezone: TZ }, new Date('2026-10-01T13:00:00Z')),
  { from: '2026-09-01', to: '2026-09-30' })
chk('monthly across a year boundary',
  resolvePeriod({ frequency: 'MONTHLY', timezone: TZ }, new Date('2027-01-01T14:00:00Z')),
  { from: '2026-12-01', to: '2026-12-31' })

console.log('\n=== the old bugs must not reproduce ===')
const w = resolvePeriod({ frequency: 'WEEKLY', timezone: TZ }, mon)
chk('never includes today', w.to < '2026-09-28', true)
const m = resolvePeriod({ frequency: 'MONTHLY', timezone: TZ }, new Date('2026-10-01T13:00:00Z'))
const days = (new Date(m.to).getTime() - new Date(m.from).getTime()) / 86400000 + 1
chk('september is 30 days, not 31', days, 30)

console.log('\n=== timezone / DST ===')
// 00:30 UTC on the 29th is still the 28th in New York.
chk('window is cut on the LOCAL date, not the UTC one',
  resolvePeriod({ frequency: 'DAILY', timezone: TZ }, new Date('2026-09-29T00:30:00Z')),
  { from: '2026-09-27', to: '2026-09-27' })
chk('...and the same instant in UTC gives the next day',
  resolvePeriod({ frequency: 'DAILY', timezone: 'UTC' }, new Date('2026-09-29T00:30:00Z')),
  { from: '2026-09-28', to: '2026-09-28' })
// US DST ends 2026-11-01. A window spanning it must still be exactly 7 days.
const dst = resolvePeriod({ frequency: 'WEEKLY', timezone: TZ }, new Date('2026-11-02T14:00:00Z'))
chk('a week spanning the DST change is still Mon–Sun', dst, { from: '2026-10-26', to: '2026-11-01' })

console.log('\n=== other ranges ===')
chk('LAST_7_DAYS ends yesterday', resolvePeriod({ frequency: 'WEEKLY', timezone: TZ, rangeType: 'LAST_7_DAYS' }, mon), { from: '2026-09-21', to: '2026-09-27' })
chk('LAST_30_DAYS', resolvePeriod({ frequency: 'WEEKLY', timezone: TZ, rangeType: 'LAST_30_DAYS' }, mon), { from: '2026-08-29', to: '2026-09-27' })
chk('MONTH_TO_DATE', resolvePeriod({ frequency: 'WEEKLY', timezone: TZ, rangeType: 'MONTH_TO_DATE' }, mon), { from: '2026-09-01', to: '2026-09-27' })
chk('QUARTER_TO_DATE', resolvePeriod({ frequency: 'WEEKLY', timezone: TZ, rangeType: 'QUARTER_TO_DATE' }, mon), { from: '2026-07-01', to: '2026-09-27' })
chk('YEAR_TO_DATE', resolvePeriod({ frequency: 'WEEKLY', timezone: TZ, rangeType: 'YEAR_TO_DATE' }, mon), { from: '2026-01-01', to: '2026-09-27' })
chk('ROLLING_N_DAYS(14)', resolvePeriod({ frequency: 'WEEKLY', timezone: TZ, rangeType: 'ROLLING_N_DAYS', rangeDays: 14 }, mon), { from: '2026-09-14', to: '2026-09-27' })
chk('MONTH_TO_DATE on the 1st falls back to the previous month rather than inverting',
  resolvePeriod({ frequency: 'WEEKLY', timezone: TZ, rangeType: 'MONTH_TO_DATE' }, new Date('2026-10-01T13:00:00Z')),
  { from: '2026-09-01', to: '2026-09-30' })
chk('rangeDays 0 falls back to the 30-day default, never an inverted window',
  resolvePeriod({ frequency: 'WEEKLY', timezone: TZ, rangeType: 'ROLLING_N_DAYS', rangeDays: 0 }, mon),
  { from: '2026-08-29', to: '2026-09-27' })
chk('a negative rangeDays does the same',
  resolvePeriod({ frequency: 'WEEKLY', timezone: TZ, rangeType: 'ROLLING_N_DAYS', rangeDays: -5 }, mon),
  { from: '2026-08-29', to: '2026-09-27' })
chk('rangeDays is capped at 400',
  resolvePeriod({ frequency: 'WEEKLY', timezone: TZ, rangeType: 'ROLLING_N_DAYS', rangeDays: 99999 }, mon).from,
  '2025-08-24')

console.log('\n=== due check ===')
const base = { time: '09:00', timezone: TZ, last_run_at: null }
chk('weekly defaults to Monday', isReportDue({ ...base, frequency: 'WEEKLY' }, mon), true)
chk('weekly not due on Tuesday', isReportDue({ ...base, frequency: 'WEEKLY' }, new Date('2026-09-29T13:00:00Z')), false)
chk('weekly with weekday=2 IS due on Tuesday', isReportDue({ ...base, frequency: 'WEEKLY', weekday: 2 }, new Date('2026-09-29T13:00:00Z')), true)
chk('wrong hour is never due', isReportDue({ ...base, frequency: 'WEEKLY' }, new Date('2026-09-28T14:00:00Z')), false)
chk('daily is due every day at the hour', isReportDue({ ...base, frequency: 'DAILY' }, new Date('2026-09-29T13:00:00Z')), true)
chk('monthly day 1', isReportDue({ ...base, frequency: 'MONTHLY', day_of_month: '1' }, new Date('2026-10-01T13:00:00Z')), true)
chk('monthly day 15 not due on the 1st', isReportDue({ ...base, frequency: 'MONTHLY', day_of_month: '15' }, new Date('2026-10-01T13:00:00Z')), false)
chk('monthly LAST is due on Sept 30', isReportDue({ ...base, frequency: 'MONTHLY', day_of_month: 'LAST' }, new Date('2026-09-30T13:00:00Z')), true)
chk('monthly LAST is NOT due on Sept 29', isReportDue({ ...base, frequency: 'MONTHLY', day_of_month: 'LAST' }, new Date('2026-09-29T13:00:00Z')), false)
chk('minutes are ignored (08:56 fires at 08:00)', isReportDue({ ...base, time: '08:56', frequency: 'DAILY' }, new Date('2026-09-29T12:00:00Z')), true)
chk('a run 1h ago blocks a re-fire', isReportDue({ ...base, frequency: 'DAILY', last_run_at: new Date(mon.getTime() - 3600000).toISOString() }, mon), false)
chk('a run 24h ago does not', isReportDue({ ...base, frequency: 'DAILY', last_run_at: new Date(mon.getTime() - 24 * 3600000).toISOString() }, mon), true)

console.log('\n' + '='.repeat(62))
console.log(fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`)
process.exit(fail === 0 ? 0 : 1)
