// "Pause new orders" (lib/order/order-pause.ts): the pure rule. Run: npx tsx scripts/tests/order-pause.test.ts
import assert from 'node:assert/strict'
import { isPauseActive, buildPauseState, pauseMessage, pauseDateLabel, localToday } from '../../lib/order/order-pause'

const NY = 'America/New_York'
// 2026-11-21 12:30 EST = 17:30Z
const satNoon = new Date('2026-11-21T17:30:00Z')
// 2026-11-26 23:59 EST = 2026-11-27 04:59Z — still Nov 26 in New York
const thuLate = new Date('2026-11-27T04:59:00Z')
// 2026-11-27 00:01 EST
const friMidnight = new Date('2026-11-27T05:01:00Z')

assert.equal(localToday(NY, thuLate), '2026-11-26', 'the restaurant’s date, not UTC')
assert.equal(isPauseActive('2026-11-27', NY, satNoon), true, 'paused now')
assert.equal(isPauseActive('2026-11-27', NY, thuLate), true, 'paused through the whole last day')
assert.equal(isPauseActive('2026-11-27', NY, friMidnight), false, 'resumes on the resume date, by itself')
assert.equal(isPauseActive(null, NY, satNoon), false, 'unset = not paused')
assert.equal(isPauseActive('2026-11-21', NY, satNoon), false, 'a resume date of today is not a pause')
assert.equal(isPauseActive('garbage', NY, satNoon), false)

assert.equal(pauseDateLabel('2026-11-27'), 'Friday, November 27')
assert.equal(pauseMessage('2026-11-27'), 'Not accepting new orders until Friday, November 27.')

const s = buildPauseState('2026-11-27', ['m1'], NY, satNoon)
assert.deepEqual([s.active, s.pausedUntil, s.excludedMenus, s.message], [true, '2026-11-27', ['m1'], 'Not accepting new orders until Friday, November 27.'])
const off = buildPauseState('2026-11-27', ['m1'], NY, friMidnight)
assert.deepEqual([off.active, off.message], [false, ''], 'a lapsed pause shows no message')
assert.equal(buildPauseState(new Date('2026-11-27T00:00:00Z'), null, null, satNoon).pausedUntil, '2026-11-27', 'Date values from the driver')

console.log('order-pause: all assertions passed')
