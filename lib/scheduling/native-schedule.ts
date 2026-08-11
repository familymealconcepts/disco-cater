// Convert a Disco-native menu's stored `schedule_config` (+ availability window)
// into the FM-shaped `scheduleOption` that the client availability engine
// (lib/scheduling/cutoffs) and the pickup date/time pickers consume. This is the
// zero-FM bridge: the native menu-manager writes schedule_config; the customer
// ordering flow reads scheduleOption. Lead time / daily+hard cutoffs / rolling
// window / skipped days are authored in later stages; until then the engine's
// defaults apply (prepTime→24h, rolling→90d). A menu with no explicit day window
// falls back to all 7 days 11:00–19:00 so ordering is never dead.

export type NativeWin = { from?: string; to?: string }
export type NativeScheduleConfig = {
  scheduleType?: string
  days?: string[]
  sameWindow?: NativeWin
  perDay?: Record<string, NativeWin>
}

export interface NativeScheduleOption {
  scheduleType: 'SAME_DAY' | 'CUSTOM'
  repeatWeekDays: { days: string; fromPickUpTime: string; toPickUpTime: string }[]
  startDate?: string
  endDate?: string
}

export const ALL_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']

export function buildNativeScheduleOption(
  sc: NativeScheduleConfig | null,
  availabilityMode: string | null,
  startDate: string | null,
  endDate: string | null,
): NativeScheduleOption {
  const cfg = sc && typeof sc === 'object' ? sc : {}
  const scheduleType = cfg.scheduleType === 'CUSTOM' ? 'CUSTOM' : 'SAME_DAY'
  const same = { from: cfg.sameWindow?.from || '11:00', to: cfg.sameWindow?.to || '19:00' }
  const perDay = cfg.perDay || {}
  const days = Array.isArray(cfg.days) && cfg.days.length ? cfg.days : ALL_DAYS
  const repeatWeekDays = days.map(d => {
    const w = scheduleType === 'CUSTOM' ? { from: perDay[d]?.from || same.from, to: perDay[d]?.to || same.to } : same
    return { days: d, fromPickUpTime: w.from, toPickUpTime: w.to }
  })
  return {
    scheduleType,
    repeatWeekDays,
    ...(availabilityMode === 'CUSTOM' && startDate ? { startDate } : {}),
    ...(availabilityMode === 'CUSTOM' && endDate ? { endDate } : {}),
  }
}
