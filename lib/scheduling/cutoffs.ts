// Three-tier ordering scheduling: Lead Time + Daily Cutoff + Hard Cutoff.
//
// WHY THIS IS CLIENT-SIDE: FM computes availability on the server
// (GET /public-api/mealPackages/{ref}/availableDates|availablePickUp and the
// menuPackages /availableTime variant — meal-package.service.ts:272-292). Those
// are opaque endpoints; the date math isn't in the FM Angular source. FM's
// per-menu model also has only ONE cutoff (scheduleOption.cutOffType =
// NO | DAILY | BY_DATE, with cutOff a time and cutOffDate a DATE) — it cannot
// express a Daily Cutoff and a Hard Cutoff at the same time, and cutOffDate
// carries no time. Per the session rule ("where FM doesn't expose what we need
// server-side, build client-side to match the spec"), this module implements
// the three stacked tiers precisely.
//
// FM field mapping (read by the adapter below):
//   Lead Time   → scheduleOption.prepTime   (total hours = days*24 + hours)
//   Daily Cutoff→ scheduleOption.cutOff      ("HH:mm" time-of-day)
//   Hard Cutoff → scheduleOption.cutOffDate  ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm")

// ── Core (pure, testable) ────────────────────────────────────────────────────

export interface CutoffConfig {
  leadTimeMinutes: number
  dailyCutoff?: string | null // "HH:mm"
  hardCutoff?: Date | null
}

const MIN = 60_000
const DAY_MS = 86_400_000

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
function hhmmToMinutes(t: string | null | undefined): number {
  // Defensive: FM emits null pickup times for closed days. Returning NaN makes
  // the callers treat the slot as not-bookable instead of throwing on null.split.
  if (!t) return NaN
  const [h, m] = String(t).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
function atTime(day: Date, minutes: number): Date {
  const x = startOfDay(day)
  x.setMinutes(minutes)
  return x
}

/**
 * Earliest valid pickup/delivery datetime given Lead Time + Daily Cutoff.
 *
 * Rule (matches the four lead/daily test cases):
 *   leadAbsolute = now + leadTime
 *   earliestDay  = startOfDay(leadAbsolute)              // lead time floors the day
 *   if dailyCutoff set AND now's time-of-day > dailyCutoff: earliestDay += 1 day
 *   floor = (earliestDay is leadAbsolute's day) ? leadAbsolute : startOfDay(earliestDay)
 *   if dailyCutoff set: floor = max(floor, earliestDay @ dailyCutoff)
 *
 * Using startOfDay(leadAbsolute) (rather than today + leadTimeDays) makes the
 * hours component carry across midnight correctly; the spec's day-only examples
 * still pass.
 */
export function earliestPickup(now: Date, cfg: CutoffConfig): Date {
  const leadAbsolute = new Date(now.getTime() + cfg.leadTimeMinutes * MIN)
  let earliestDay = startOfDay(leadAbsolute)

  if (cfg.dailyCutoff) {
    const nowMinutes = now.getHours() * 60 + now.getMinutes()
    if (nowMinutes > hhmmToMinutes(cfg.dailyCutoff)) {
      earliestDay = new Date(earliestDay.getTime() + DAY_MS)
    }
  }

  let floor =
    earliestDay.getTime() === startOfDay(leadAbsolute).getTime()
      ? leadAbsolute
      : startOfDay(earliestDay)

  if (cfg.dailyCutoff) {
    const cutoffOnDay = atTime(earliestDay, hhmmToMinutes(cfg.dailyCutoff))
    if (cutoffOnDay > floor) floor = cutoffOnDay
  }
  return floor
}

/** True once the hard cutoff has passed — ordering is globally closed. */
export function isOrderingClosed(now: Date, cfg: CutoffConfig): boolean {
  return !!cfg.hardCutoff && now.getTime() > cfg.hardCutoff.getTime()
}

/**
 * A slot is bookable iff ordering isn't closed, the slot is at/after the
 * earliest pickup, and (when a hard cutoff exists) at/before it. The hard
 * cutoff therefore acts as an upper bound on pickup datetimes, which is what
 * makes "hard cutoff before the earliest valid slot → nothing bookable" work.
 */
export function isSlotEnabled(now: Date, cfg: CutoffConfig, slot: Date): boolean {
  if (isOrderingClosed(now, cfg)) return false
  if (slot.getTime() < earliestPickup(now, cfg).getTime()) return false
  if (cfg.hardCutoff && slot.getTime() > cfg.hardCutoff.getTime()) return false
  return true
}

// ── FM adapter + date/time generation ────────────────────────────────────────

export interface FmScheduleLike {
  prepTime?: number // total lead hours
  cutOff?: string | null // daily cutoff "HH:mm"
  cutOffDate?: string | null // hard cutoff date or datetime
  cutOffType?: string | null
  // FM emits null from/to for closed days — reflected here so the null-guard is honest.
  repeatWeekDays?: { days: string; fromPickUpTime: string | null; toPickUpTime: string | null }[]
  rollingAvailability?: number
  // Menu Availability = Custom (date range) — the menu is orderable ONLY within
  // [startDate, endDate], on top of (not instead of) the day-of-week pickup
  // window. Absent when availability is "Always".
  startDate?: string | null
  endDate?: string | null
  skippedDays?: (SkippedDay | string)[] | null
}
interface SkippedDay { fromDate?: string; toDate?: string }

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
const SLOT_MINUTES = 30

function parseHardCutoff(raw?: string | null): Date | null {
  if (!raw) return null
  // Date-only ("YYYY-MM-DD") → whole day allowed, so the bound is end of day.
  // Full datetime ("YYYY-MM-DDTHH:mm") → exact local time.
  return raw.includes('T') ? new Date(raw) : new Date(`${raw}T23:59:59`)
}

export function toCutoffConfig(s: FmScheduleLike): CutoffConfig {
  return {
    leadTimeMinutes: Math.max(0, Math.round((s.prepTime ?? 24) * 60)),
    dailyCutoff: s.cutOff || null,
    hardCutoff: parseHardCutoff(s.cutOffDate),
  }
}

// Map a weekday name → its pickup window. repeatWeekDays entries may list a
// single day or a comma-joined set (SAME_DAY mode joins them into one entry).
function windowForDay(s: FmScheduleLike, dayName: string): { from: string; to: string } | null {
  for (const w of s.repeatWeekDays ?? []) {
    const days = (w.days || '').split(',').map(d => d.trim().toUpperCase())
    // FM lists closed days as repeatWeekDays entries with null from/to times.
    // Only treat an entry as a bookable window when BOTH times are present; skip
    // otherwise so the day is correctly unavailable (and we never split(null)).
    if (days.includes(dayName) && w.fromPickUpTime && w.toPickUpTime) {
      return { from: w.fromPickUpTime, to: w.toPickUpTime }
    }
  }
  return null
}

function skippedDateSet(s: FmScheduleLike): Set<string> {
  const out = new Set<string>()
  for (const sd of s.skippedDays ?? []) {
    if (typeof sd === 'string') { out.add(sd); continue }
    const from = sd.fromDate, to = sd.toDate || sd.fromDate
    if (!from) continue
    const cur = new Date(`${from}T00:00:00`)
    const end = new Date(`${to}T00:00:00`)
    for (let i = 0; i < 366 && cur <= end; i++) {
      out.add(cur.toISOString().slice(0, 10))
      cur.setDate(cur.getDate() + 1)
    }
  }
  return out
}

function localISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function orderingClosed(s: FmScheduleLike, now = new Date()): boolean {
  return isOrderingClosed(now, toCutoffConfig(s))
}

/** Slot start-times (minutes since midnight) a pickup window produces. A
 *  window where from === to means "exactly one pickup time" (a single
 *  seating/delivery slot), not a zero-width range — it produces exactly that
 *  one slot. A normal [from, to) window produces 30-min slots, each ending
 *  no later than `to`. */
function windowSlotMinutes(win: { from: string; to: string }): number[] {
  const fromMin = hhmmToMinutes(win.from)
  const toMinVal = hhmmToMinutes(win.to)
  if (fromMin === toMinVal) return [fromMin]
  const out: number[] = []
  for (let m = fromMin; m + SLOT_MINUTES <= toMinVal; m += SLOT_MINUTES) out.push(m)
  return out
}

/** Calendar dates within the horizon, each flagged disabled when it has no
 *  bookable slot (past earliest pickup, after hard cutoff, skipped, or no
 *  window that day). A Custom-availability menu's startDate is a hard lower
 *  bound — dates before it are never generated, even if they'd otherwise fall
 *  within the rolling horizon and match the day-of-week window. */
export function buildAvailableDates(
  s: FmScheduleLike,
  now = new Date(),
  horizonDays?: number,
): { date: string; disabled: boolean }[] {
  const cfg = toCutoffConfig(s)
  const skipped = skippedDateSet(s)
  const horizon = horizonDays ?? s.rollingAvailability ?? 90
  const end = s.endDate ? new Date(`${s.endDate}T23:59:59`) : new Date(now.getTime() + horizon * DAY_MS)
  const startBound = s.startDate ? startOfDay(new Date(`${s.startDate}T00:00:00`)) : null

  const out: { date: string; disabled: boolean }[] = []
  const cur = startBound && startBound > startOfDay(now) ? new Date(startBound) : startOfDay(now)
  for (let i = 0; i <= horizon && cur <= end; i++) {
    const iso = localISODate(cur)
    const win = windowForDay(s, DAY_NAMES[cur.getDay()])
    if (win && !skipped.has(iso)) {
      // The day is bookable if its LAST window slot is still enabled.
      const slots = windowSlotMinutes(win)
      const enabled = slots.length > 0 && isSlotEnabled(now, cfg, atTime(cur, slots[slots.length - 1]))
      out.push({ date: iso, disabled: !enabled })
    }
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

/** 30-minute pickup slots for a date, each flagged disabled per the three tiers.
 *  Defense-in-depth: rejects a date outside a Custom-availability menu's
 *  [startDate, endDate] range outright, independent of whatever surfaced the
 *  date (calendar pick, deep link, stale client state). */
export function buildAvailableTimes(
  s: FmScheduleLike,
  dateStr: string,
  now = new Date(),
): { time: string; disabled: boolean }[] {
  if (!dateStr) return []
  if (s.startDate && dateStr < s.startDate) return []
  if (s.endDate && dateStr > s.endDate) return []
  const cfg = toCutoffConfig(s)
  const day = new Date(`${dateStr}T12:00:00`)
  const win = windowForDay(s, DAY_NAMES[day.getDay()])
  if (!win) return []
  const out: { time: string; disabled: boolean }[] = []
  for (const m of windowSlotMinutes(win)) {
    const slot = atTime(new Date(`${dateStr}T00:00:00`), m)
    const time = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`
    out.push({ time, disabled: !isSlotEnabled(now, cfg, slot) })
  }
  return out
}

/** Whether an exact date+time is genuinely bookable under this schedule — every
 *  rule this module enforces (lead time, daily/hard cutoff, day-of-week window,
 *  Custom [startDate, endDate] range, skipped/blackout days, rolling horizon) in
 *  one call. This is the single source of truth: the customer-facing picker
 *  calls buildAvailableDates/buildAvailableTimes for UX (what to show/greys
 *  out), and order placement calls THIS to re-check the exact submitted
 *  date+time server-side — so a request that bypasses the picker entirely
 *  can't slip through a rule the UI never actually removed, it just hid it. */
export function isDateTimeBookable(s: FmScheduleLike, dateStr: string, timeStr: string, now = new Date()): boolean {
  if (!dateStr || !timeStr) return false
  const dateEntry = buildAvailableDates(s, now).find(d => d.date === dateStr)
  if (!dateEntry || dateEntry.disabled) return false
  const hhmm = timeStr.slice(0, 5)
  const timeEntry = buildAvailableTimes(s, dateStr, now).find(t => t.time.slice(0, 5) === hhmm)
  return !!timeEntry && !timeEntry.disabled
}

// ── Self-tests (Part D) ──────────────────────────────────────────────────────
// Run: npx ts-node --skip-project -e "require('./lib/scheduling/cutoffs').runSelfTests()"

export function runSelfTests(): void {
  let pass = 0
  const eq = (label: string, got: Date, want: Date) => {
    if (got.getTime() !== want.getTime()) throw new Error(`FAIL ${label}: got ${got.toString()} want ${want.toString()}`)
    pass++
  }
  const isTrue = (label: string, v: boolean) => { if (!v) throw new Error(`FAIL ${label}: expected true`); pass++ }
  const isFalse = (label: string, v: boolean) => { if (v) throw new Error(`FAIL ${label}: expected false`); pass++ }

  // Anchor: Wed 2026-06-03 15:00 local; Tue 2026-06-02 for daily-cutoff cases.
  const wed3pm = new Date(2026, 5, 3, 15, 0, 0, 0)
  const tue859 = new Date(2026, 5, 2, 8, 59, 0, 0)
  const tue901 = new Date(2026, 5, 2, 9, 1, 0, 0)

  // 1. Lead 1d0h, order 3pm Wed → 3pm Thu
  eq('1 lead 1d0h', earliestPickup(wed3pm, { leadTimeMinutes: 1440 }), new Date(2026, 5, 4, 15, 0))
  // 2. Lead 1d1h, order 3pm Wed → 4pm Thu
  eq('2 lead 1d1h', earliestPickup(wed3pm, { leadTimeMinutes: 1500 }), new Date(2026, 5, 4, 16, 0))
  // 3. Lead 1d + daily 9am, order 8:59am Tue → 9am Wed
  eq('3 daily before', earliestPickup(tue859, { leadTimeMinutes: 1440, dailyCutoff: '09:00' }), new Date(2026, 5, 3, 9, 0))
  // 4. Lead 1d + daily 9am, order 9:01am Tue → 9am Thu
  eq('4 daily after', earliestPickup(tue901, { leadTimeMinutes: 1440, dailyCutoff: '09:00' }), new Date(2026, 5, 4, 9, 0))

  // 5. Hard cutoff in the past → ordering closed, no slot enabled
  const past = new Date(wed3pm.getTime() - 5 * MIN)
  isTrue('5 closed', isOrderingClosed(wed3pm, { leadTimeMinutes: 0, hardCutoff: past }))
  isFalse('5 slot', isSlotEnabled(wed3pm, { leadTimeMinutes: 1440, hardCutoff: past }, new Date(2026, 5, 4, 15, 0)))

  // 6. Hard cutoff well beyond lead time → a valid slot is enabled
  const farHard = new Date(2026, 5, 10, 23, 59)
  isFalse('6 not closed', isOrderingClosed(wed3pm, { leadTimeMinutes: 1440, hardCutoff: farHard }))
  isTrue('6 slot', isSlotEnabled(wed3pm, { leadTimeMinutes: 1440, hardCutoff: farHard }, new Date(2026, 5, 4, 16, 0)))

  // 7. Hard cutoff in the future but BEFORE the earliest valid slot → nothing bookable
  const earliest = earliestPickup(wed3pm, { leadTimeMinutes: 1440 }) // Thu 3pm
  const hardBeforeEarliest = new Date(earliest.getTime() - 60 * MIN) // Thu 2pm (future vs now, before earliest)
  isFalse('7 not closed', isOrderingClosed(wed3pm, { leadTimeMinutes: 1440, hardCutoff: hardBeforeEarliest }))
  isFalse('7 slot', isSlotEnabled(wed3pm, { leadTimeMinutes: 1440, hardCutoff: hardBeforeEarliest }, earliest))

  // 8. A window where from === to is a single seating, not zero-width — one slot, not none.
  const farPast = new Date(2026, 4, 1)
  const sameTimeSlots = buildAvailableTimes(
    { prepTime: 0, repeatWeekDays: [{ days: 'WEDNESDAY', fromPickUpTime: '18:30', toPickUpTime: '18:30' }] },
    '2026-06-03',
    farPast,
  )
  if (sameTimeSlots.length !== 1 || sameTimeSlots[0].time !== '18:30:00') {
    throw new Error(`FAIL 8 same-time slot: got ${JSON.stringify(sameTimeSlots)}`)
  }
  pass++

  // 9. A normal multi-hour window is unaffected — still 30-min slots ending by `to`.
  const normalSlots = buildAvailableTimes(
    { prepTime: 0, repeatWeekDays: [{ days: 'WEDNESDAY', fromPickUpTime: '11:00', toPickUpTime: '13:00' }] },
    '2026-06-03',
    farPast,
  )
  if (normalSlots.length !== 4) throw new Error(`FAIL 9 normal window slot count: got ${normalSlots.length}`)
  pass++

  // 10. Custom availability (startDate === endDate) — ONLY that date is bookable,
  // even though the day-of-week window would otherwise match every week.
  const customRangeSchedule = {
    prepTime: 0,
    repeatWeekDays: [{ days: 'FRIDAY', fromPickUpTime: '18:30', toPickUpTime: '18:30' }],
    startDate: '2026-08-21',
    endDate: '2026-08-21',
  }
  const rangeEnabled = buildAvailableDates(customRangeSchedule, farPast).filter(d => !d.disabled)
  if (rangeEnabled.length !== 1 || rangeEnabled[0].date !== '2026-08-21') {
    throw new Error(`FAIL 10 custom-range dates: got ${JSON.stringify(rangeEnabled)}`)
  }
  pass++
  // A date before startDate must be rejected even if requested directly (bypassing the calendar).
  if (buildAvailableTimes(customRangeSchedule, '2026-08-14', farPast).length !== 0) {
    throw new Error('FAIL 10 custom-range out-of-range date produced times')
  }
  pass++
  if (buildAvailableTimes(customRangeSchedule, '2026-08-21', farPast).length !== 1) {
    throw new Error('FAIL 10 custom-range in-range date produced no times')
  }
  pass++

  // 11. isDateTimeBookable — the composite check order placement re-validates
  // against server-side. Must agree with buildAvailableDates/Times exactly.
  isFalse('11 out-of-range rejected', isDateTimeBookable(customRangeSchedule, '2026-08-14', '18:30', farPast))
  isTrue('11 in-range accepted', isDateTimeBookable(customRangeSchedule, '2026-08-21', '18:30', farPast))
  isFalse('11 wrong time on valid date rejected', isDateTimeBookable(customRangeSchedule, '2026-08-21', '19:00', farPast))
  isFalse('11 missing time rejected', isDateTimeBookable(customRangeSchedule, '2026-08-21', '', farPast))

  console.log(`cutoffs.ts self-tests: ${pass} assertions passed`)
}
