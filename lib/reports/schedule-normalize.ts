// Shared normalisation for the scheduling half of a scheduled-report payload.
// Used by both the create route and the edit route so the two cannot drift —
// they already did once over frequency, which is how a report could be saved
// with a value the cron would never fire on.
const RANGE_TYPES = new Set([
  'PREVIOUS_PERIOD', 'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS',
  'MONTH_TO_DATE', 'QUARTER_TO_DATE', 'YEAR_TO_DATE', 'ROLLING_N_DAYS',
])

/**
 * Normalise the scheduling half of a create/update payload.
 *
 * Every value is clamped here rather than trusted, because these drive a cron
 * that nobody watches: an out-of-range day_of_month would simply never fire, and
 * a report that silently stops arriving is the failure mode this whole area
 * already has history with.
 *
 * MINUTES ARE DISCARDED ON PURPOSE. The cron runs hourly, so a stored 08:56 can
 * only ever fire at 08:00 — one live report is saved exactly that way. The
 * picker no longer offers minutes; this makes the stored value honest too.
 */
export function normalizeSchedule(body: Record<string, unknown>) {
  const freqRaw = String(body?.frequency || 'WEEKLY').toUpperCase()
  const frequency = freqRaw === 'DAILY' || freqRaw === 'MONTHLY' ? freqRaw : 'WEEKLY'

  const hour = Math.min(23, Math.max(0, parseInt(String(body?.time ?? '09:00').split(':')[0], 10) || 0))
  const time = `${String(hour).padStart(2, '0')}:00`

  let weekday: number | null = null
  if (frequency === 'WEEKLY' && body?.weekday != null && body.weekday !== '') {
    const w = Number(body.weekday)
    weekday = Number.isFinite(w) ? Math.min(6, Math.max(0, Math.floor(w))) : null
  }

  let dayOfMonth: string | null = null
  if (frequency === 'MONTHLY' && body?.dayOfMonth != null && body.dayOfMonth !== '') {
    const raw = String(body.dayOfMonth).toUpperCase()
    // Capped at 28 so a monthly report can never skip February.
    dayOfMonth = raw === 'LAST' ? 'LAST' : String(Math.min(28, Math.max(1, parseInt(raw, 10) || 1)))
  }

  const rt = String(body?.rangeType || 'PREVIOUS_PERIOD').toUpperCase()
  const rangeType = RANGE_TYPES.has(rt) ? rt : 'PREVIOUS_PERIOD'
  const rangeDays = rangeType === 'ROLLING_N_DAYS'
    ? Math.min(400, Math.max(1, parseInt(String(body?.rangeDays ?? 30), 10) || 30))
    : null

  return {
    frequency, time, timezone: String(body?.timezone || 'America/New_York'),
    weekday, dayOfMonth, rangeType, rangeDays,
    autoTidy: body?.autoTidy === true,
    fanOut: body?.fanOut === true,
  }
}
