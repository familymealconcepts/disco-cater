// "Shift third-party delivery times by 30 minutes" (Peter, 2026-11-10).
// Box off: every slot and every answer is byte-for-byte what it was. Box on: an
// EXPLICITLY third-party menu's DELIVERY slots are its ready slots + 30, every
// rule (window, blackouts, lead time incl. category, cutoffs) is judged on the
// ready time, nothing rolls past 23:45 into the next day, an unset delivery
// method and an FM-backed restaurant never shift, and a pickup <-> delivery
// switch keeps the food-ready time. Plus source guards so every surface keeps
// going through the one helper.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  buildAvailableTimes, buildAvailableDates, isDateTimeBookable,
  thirdPartyShiftFor, slotShiftMinutes, readyTimeForSlot, shiftSlotTime, timeAfterFulfillmentSwitch,
  type FmScheduleLike,
} from '../../lib/scheduling/cutoffs'
import { isCategoryLeadSatisfied } from '../../lib/menu/category-lead-time'

let n = 0
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++ }
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); n++ }

// Mon–Thu 10:00–13:00, no lead time. "Now" is Tue 2026-11-10 08:00 local; Wed is 2026-11-11.
const WED = '2026-11-11'
const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY'].map(d => ({ days: d, fromPickUpTime: '10:00', toPickUpTime: '13:00' }))
const base: FmScheduleLike = { prepTime: 0, repeatWeekDays: days, rollingAvailability: 30, timezone: null }
const shifted: FmScheduleLike = { ...base, thirdPartyShiftMinutes: 30 }
const early = new Date(2026, 10, 10, 8, 0)
const open = (s: FmScheduleLike, d: string, now: Date, shift = 0) =>
  buildAvailableTimes(s, d, now, shift).filter(t => !t.disabled).map(t => t.time.slice(0, 5))

// ── who shifts ──────────────────────────────────────────────────────────────
eq(thirdPartyShiftFor({ flag: true, isDiscoNative: true, deliveryMethod: 'THIRD_PARTY' }), 30, 'box on + native + explicit third-party = 30')
eq(thirdPartyShiftFor({ flag: true, isDiscoNative: true, deliveryMethod: undefined }), 0, 'unset method is NOT shifted')
eq(thirdPartyShiftFor({ flag: true, isDiscoNative: true, deliveryMethod: null }), 0, 'null method is NOT shifted')
eq(thirdPartyShiftFor({ flag: true, isDiscoNative: true, deliveryMethod: 'OWN_DELIVERY' }), 0, 'self-delivery is NOT shifted')
eq(thirdPartyShiftFor({ flag: true, isDiscoNative: false, deliveryMethod: 'THIRD_PARTY' }), 0, 'FM-backed restaurant ignores the flag')
eq(thirdPartyShiftFor({ flag: false, isDiscoNative: true, deliveryMethod: 'THIRD_PARTY' }), 0, 'box off = 0')
eq(slotShiftMinutes(shifted, 'PICKUP'), 0, 'pickup never shifts')
eq(slotShiftMinutes(shifted, 'DELIVERY'), 30, 'delivery on a shifted menu shifts')
eq(slotShiftMinutes(base, 'DELIVERY'), 0, 'delivery on an unshifted menu does not')

// ── box off: identical ──────────────────────────────────────────────────────
eq(buildAvailableTimes(base, WED, early), buildAvailableTimes(base, WED, early, 0), 'shift 0 = old slots')
eq(buildAvailableTimes(shifted, WED, early, slotShiftMinutes(shifted, 'PICKUP')), buildAvailableTimes(base, WED, early), 'pickup on a shifted menu = old slots')
eq(buildAvailableDates(base, early), buildAvailableDates(base, early, undefined, 0), 'shift 0 = old dates')
for (const t of ['09:45', '10:00', '12:45', '13:00', '13:15']) {
  eq(isDateTimeBookable(base, WED, t, early, 0), isDateTimeBookable(base, WED, t, early), `shift 0 = old answer at ${t}`)
}

// ── box on: +30 ─────────────────────────────────────────────────────────────
const pick = open(base, WED, early)
const del = open(shifted, WED, early, 30)
eq(pick[0], '10:00', 'pickup opens 10:00'); eq(pick[pick.length - 1], '13:00', 'pickup closes 13:00'); eq(pick.length, 13, '13 pickup slots')
eq(del[0], '10:30', 'third-party opens 10:30'); eq(del[del.length - 1], '13:30', 'third-party closes 13:30'); eq(del.length, 13, '13 third-party slots')
ok(!isDateTimeBookable(shifted, WED, '10:00', early, 30), '10:00 delivery refused (ready 9:30, before the window)')
ok(isDateTimeBookable(shifted, WED, '13:30', early, 30), '13:30 delivery accepted (ready 13:00)')
eq(readyTimeForSlot('10:30:00', 30), '10:00:00', 'ready = delivery - 30')

// ── lead time judged on the ready time ──────────────────────────────────────
const lead: FmScheduleLike = { ...shifted, prepTime: 24 }
const tue1020 = new Date(2026, 10, 10, 10, 20)
eq(open({ ...lead, thirdPartyShiftMinutes: undefined }, WED, tue1020)[0], '10:30', '24h lead: pickup from 10:30')
eq(open(lead, WED, tue1020, 30)[0], '11:00', '24h lead: third-party from 11:00')
ok(!isDateTimeBookable(lead, WED, '10:30', tue1020, 30), '10:30 delivery refused (ready 10:00 inside 24h)')
ok(!isDateTimeBookable(lead, WED, '10:45', tue1020, 30), '10:45 delivery refused (ready 10:15 inside 24h)')
ok(isDateTimeBookable(lead, WED, '11:00', tue1020, 30), '11:00 delivery accepted (ready 10:30)')

// ── partial-day blackout 11:00–12:00 judged on the ready time ───────────────
const bl: FmScheduleLike = { ...shifted, skippedDays: [{ fromDate: WED, toDate: WED, intervals: [{ fromTime: '11:00', toTime: '12:00' }] }] }
ok(isDateTimeBookable(bl, WED, '11:15', early, 30), '11:15 delivery ok (ready 10:45)')
ok(!isDateTimeBookable(bl, WED, '11:30', early, 30), '11:30 delivery refused (ready 11:00 blacked out)')
ok(!isDateTimeBookable(bl, WED, '12:30', early, 30), '12:30 delivery refused (ready 12:00 blacked out)')
ok(isDateTimeBookable(bl, WED, '12:45', early, 30), '12:45 delivery ok (ready 12:15)')

// ── category lead time on the ready time ────────────────────────────────────
// 48h from Mon 2026-11-09 10:15 = Wed 10:15: a 10:45 delivery (ready 10:15) passes, 10:30 (ready 10:00) fails.
const mon = new Date(2026, 10, 9, 10, 15)
ok(isCategoryLeadSatisfied(48, WED, readyTimeForSlot('10:45', 30)!, mon, null), 'category 48h: 10:45 delivery ok on ready time')
ok(!isCategoryLeadSatisfied(48, WED, readyTimeForSlot('10:30', 30)!, mon, null), 'category 48h: 10:30 delivery refused on ready time')

// ── never into the next day: stop at 23:45 ──────────────────────────────────
const late: FmScheduleLike = { ...shifted, repeatWeekDays: [{ days: 'WEDNESDAY', fromPickUpTime: '22:00', toPickUpTime: '00:00' }] }
const lateDel = open(late, WED, early, 30)
eq(lateDel[lateDel.length - 1], '23:45', 'last shifted slot is 23:45')
ok(lateDel.every(t => t >= '22:30'), 'shifted slots start at 22:30')
ok(!lateDel.some(t => t < '22:30'), 'nothing wraps to 00:xx')
eq(shiftSlotTime('23:30', 30), null, '23:30 + 30 dropped, never 00:00 next day')
eq(readyTimeForSlot('00:15', 30), null, 'a 00:15 delivery has no same-day ready time')
const onlyLate: FmScheduleLike = { ...shifted, repeatWeekDays: [{ days: 'WEDNESDAY', fromPickUpTime: '23:30', toPickUpTime: '23:45' }] }
ok(buildAvailableDates(onlyLate, early, 3, 30).find(d => d.date === WED)?.disabled === true, 'a date whose every slot would cross midnight is disabled')

// ── edit switch keeps the ready time ────────────────────────────────────────
eq(timeAfterFulfillmentSwitch('10:00:00', 0, 30), '10:30:00', 'pickup 10:00 -> third-party 10:30')
eq(timeAfterFulfillmentSwitch('10:30', 30, 0), '10:00', 'third-party 10:30 -> pickup 10:00')
eq(timeAfterFulfillmentSwitch('10:00', 0, 0), '10:00', 'no shift on either side = unchanged')
eq(timeAfterFulfillmentSwitch('23:45', 0, 30), null, 'a switch that would cross midnight is refused')

// ── source guards: every surface goes through the one helper ────────────────
const src = (p: string) => readFileSync(p, 'utf8')
const place = src('lib/order/native-place-checkout.ts')
ok(/loadThirdPartyShiftMinutes\(ref, menuReference\)/.test(place), 'placement resolves the shift from the menu (all callers, direct entry included)')
ok(/isNativeDateTimeValid\([^)]*shiftMinutes \}\)/.test(place), 'placement gate receives the shift')
ok(/findCategoryLeadBreaches\(ref, itemReferences, orderDate, readyTime\)/.test(place), 'category breach message uses the ready time')
const nc = src('lib/order/native-checkout.ts')
ok(/isDateTimeBookable\(scheduleOption, orderDate, orderTime, undefined, shift\)/.test(nc), 'server gate passes the shift to the engine')
ok(/findCategoryLeadBreaches\(restaurantReference, opts\.itemReferences, orderDate, readyTime\)/.test(nc), 'server category gate uses the ready time')
ok(/is_disco_native/.test(nc.slice(nc.indexOf('export async function loadThirdPartyShiftMinutes'), nc.indexOf('export async function isNativeOrderingOpen'))), 'loader checks Disco-native')
const rc = src('app/(customer)/restaurants/[slug]/RestaurantClient.tsx')
ok(/buildAvailableTimes\(sched, dateStr, undefined, slotShiftMinutes\(sched, type\)\)/.test(rc), 'customer times use the shift')
ok(/buildAvailableDates\(sched, undefined, undefined, slotShiftMinutes\(sched, type\)\)/.test(rc), 'customer dates use the shift')
ok(!/isCategoryLeadSatisfied\([^)]*selTime/.test(rc), 'customer category checks never use the raw delivery time')
ok(/switchTempType\(type\)/.test(rc), 'customer pickup/delivery toggle re-maps the picked time')
const edit = src('app/api/restaurant/orders/[ref]/edit/route.ts')
ok(/timeAfterFulfillmentSwitch\(effTime, fromShift, toShift\)/.test(edit), 'edit switch keeps the ready time on the server')
const ec = src('app/(restaurant)/restaurant/(portal)/orders/[orderRef]/edit/EditOrderClient.tsx')
ok(/buildAvailableTimes\(sched, draftDate, undefined, shiftAfter\)/.test(ec), 'staff reschedule picker uses the shift')
const settings = src('app/api/restaurant/disco-settings/route.ts')
ok(/typeof body\?\.shiftThirdPartyDeliveryTimes === 'boolean'/.test(settings) && /: storedShift/.test(settings), 'a save that omits the flag keeps the stored value')
ok(/is_disco_native === true/.test(settings), 'the flag can only be turned on for a Disco-native restaurant')
ok(/'shift_third_party_delivery_times',\n\] as const/.test(settings), 'the flag is in the settings audit')

console.log(`third-party-shift: ALL PASS ${n} assertions`)
