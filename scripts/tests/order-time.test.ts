// Order instants shown in the restaurant's own time zone, with its abbreviation (Peter, 2026-11-24). lib/order-time.ts.
import assert from 'node:assert/strict'
import { formatOrderTime, formatOrderClock, formatOrderDay, orderDayKey, orderTimeZone, parseOrderInstant, ORDER_TIME_FALLBACK_TZ } from '../../lib/order-time'

let n = 0
const ok = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok  ${name}`) }
const NOW = new Date('2026-11-24T20:00:00Z')
const AT = '2026-11-24T17:15:00Z' // 12:15 PM EST, 11:15 AM CST, 9:15 AM PST

ok('Eastern, Central and Pacific restaurants each see their own clock and abbreviation', () => {
  assert.equal(formatOrderTime(AT, 'America/New_York', { now: NOW }), 'Nov 24, 12:15 PM EST')
  assert.equal(formatOrderTime(AT, 'America/Chicago', { now: NOW }), 'Nov 24, 11:15 AM CST')
  assert.equal(formatOrderTime(AT, 'America/Los_Angeles', { now: NOW }), 'Nov 24, 9:15 AM PST')
  assert.equal(formatOrderTime(AT, 'America/Phoenix', { now: NOW }), 'Nov 24, 10:15 AM MST')
})

ok('daylight saving time gives the daylight abbreviation', () => {
  assert.equal(formatOrderTime('2026-07-04T17:15:00Z', 'America/Los_Angeles', { now: NOW }), 'Jul 4, 10:15 AM PDT')
})

ok('no zone, a blank zone or an invalid zone falls back to Eastern, and says so', () => {
  assert.equal(orderTimeZone(null), ORDER_TIME_FALLBACK_TZ)
  assert.equal(orderTimeZone('  '), ORDER_TIME_FALLBACK_TZ)
  assert.equal(orderTimeZone('Mars/Olympus'), ORDER_TIME_FALLBACK_TZ)
  assert.equal(formatOrderTime(AT, undefined, { now: NOW }), 'Nov 24, 12:15 PM EST')
})

ok('the year shows only when it is not the current year in that zone', () => {
  assert.equal(formatOrderTime('2025-11-24T17:15:00Z', 'America/Chicago', { now: NOW }), 'Nov 24, 2025, 11:15 AM CST')
  assert.equal(formatOrderTime(AT, 'America/Chicago', { now: NOW, year: 'always' }), 'Nov 24, 2026, 11:15 AM CST')
  // New Year's Eve 11 PM in LA is already Jan 1 in UTC: the year is LA's.
  assert.equal(formatOrderTime('2027-01-01T07:00:00Z', 'America/Los_Angeles', { now: new Date('2026-12-31T23:30:00-08:00') }), 'Dec 31, 11:00 PM PST')
})

ok('the day an instant falls on is the restaurant\'s day', () => {
  const lateLA = '2026-11-25T05:30:00Z' // 9:30 PM PST on Nov 24, already Nov 25 in New York and UTC
  assert.equal(formatOrderDay(lateLA, 'America/Los_Angeles'), 'Nov 24, 2026')
  assert.equal(orderDayKey(lateLA, 'America/Los_Angeles'), '2026-11-24')
  assert.equal(orderDayKey(lateLA, 'America/New_York'), '2026-11-25')
  assert.equal(formatOrderClock(lateLA, 'America/Los_Angeles'), '9:30 PM PST')
})

ok('a date with no time is a calendar day and is never shifted', () => {
  assert.equal(formatOrderTime('2026-11-24', 'America/Los_Angeles'), 'Nov 24, 2026')
  assert.equal(formatOrderTime('24.11.2026', 'America/Los_Angeles'), 'Nov 24, 2026')
  assert.equal(orderDayKey('2026-11-24', 'America/Los_Angeles'), '2026-11-24')
})

ok('Postgres timestamptz strings, Dates and FamilyMeal date-times (UTC) parse; junk gives an empty string', () => {
  assert.equal(formatOrderTime('2026-11-24 17:15:00+00', 'America/Los_Angeles', { now: NOW }), 'Nov 24, 9:15 AM PST')
  assert.equal(formatOrderTime(new Date(AT), 'America/Los_Angeles', { now: NOW }), 'Nov 24, 9:15 AM PST')
  assert.equal(parseOrderInstant('24.11.2026 17:15')?.toISOString(), '2026-11-24T17:15:00.000Z')
  assert.equal(formatOrderTime('not a date', 'America/Chicago'), '')
  assert.equal(formatOrderTime(null, 'America/Chicago'), '')
})

console.log(`order-time: ${n} passed`)
