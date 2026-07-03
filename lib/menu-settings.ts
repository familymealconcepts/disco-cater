// Per-menu money/timing settings (Stage 5): parse from the admin form for storage,
// and map a disco_menus row into the FM-shaped `settings` + `scheduleOption` the
// customer flow (pricer + availability engine) already consumes. Zero FM.

export interface MenuSettingsInput {
  offersPickup: boolean
  offersDelivery: boolean
  serviceChargePct: number
  serviceChargeName: string | null
  tipDefaultType: 'PERCENTAGE' | 'CUSTOM' | 'NONE'
  tipDefaultValue: number
  pickupOrderMinimum: number
  deliveryOrderMinimum: number
  maxOrdersPerDay: number | null
  leadTimeHours: number
  rollingAvailabilityDays: number
  dailyCutoffTime: string | null // 'HH:mm'
  hardCutoffDate: string | null  // 'yyyy-mm-dd'
}

const n = (v: unknown, d = 0): number => { const x = Number(v); return Number.isFinite(x) ? x : d }
const clampInt = (v: unknown, min: number, max: number, d: number): number => {
  const x = Math.trunc(Number(v)); return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : d
}

// Normalize the admin form body into storable settings (safe defaults + clamping).
export function parseMenuSettingsInput(body: Record<string, unknown>): MenuSettingsInput {
  const tipType = String(body?.tipDefaultType || 'PERCENTAGE').toUpperCase()
  return {
    offersPickup: body?.offersPickup !== false,
    offersDelivery: body?.offersDelivery !== false,
    serviceChargePct: Math.max(0, n(body?.serviceChargePct)),
    serviceChargeName: String(body?.serviceChargeName || '').trim() || null,
    tipDefaultType: tipType === 'CUSTOM' ? 'CUSTOM' : tipType === 'NONE' ? 'NONE' : 'PERCENTAGE',
    tipDefaultValue: Math.max(0, n(body?.tipDefaultValue, 15)),
    pickupOrderMinimum: Math.max(0, n(body?.pickupOrderMinimum)),
    deliveryOrderMinimum: Math.max(0, n(body?.deliveryOrderMinimum)),
    maxOrdersPerDay: body?.maxOrdersPerDay == null || body?.maxOrdersPerDay === '' ? null : Math.max(0, clampInt(body?.maxOrdersPerDay, 0, 100000, 0)),
    leadTimeHours: clampInt(body?.leadTimeHours, 0, 24 * 90, 24),
    rollingAvailabilityDays: clampInt(body?.rollingAvailabilityDays, 1, 365, 90),
    dailyCutoffTime: String(body?.dailyCutoffTime || '').trim() || null,
    hardCutoffDate: String(body?.hardCutoffDate || '').trim() || null,
  }
}

// The disco_menus columns as read back (snake_case).
export interface MenuSettingsRow {
  offers_pickup?: boolean
  offers_delivery?: boolean
  service_charge_pct?: string | number | null
  service_charge_name?: string | null
  tip_default_type?: string | null
  tip_default_value?: string | number | null
  pickup_order_minimum?: string | number | null
  delivery_order_minimum?: string | number | null
  max_orders_per_day?: number | null
  lead_time_hours?: number | null
  rolling_availability_days?: number | null
  daily_cutoff_time?: string | null
  hard_cutoff_date?: string | null
}

// FM-shaped `settings` the client pricer/min-order gate read.
export function menuRowToSettings(row: MenuSettingsRow) {
  const menuAvailability: string[] = []
  if (row.offers_pickup !== false) menuAvailability.push('PICKUP')
  if (row.offers_delivery !== false) menuAvailability.push('DELIVERY')
  const tipType = String(row.tip_default_type || 'PERCENTAGE').toUpperCase()
  return {
    menuAvailability: menuAvailability.length ? menuAvailability : ['PICKUP', 'DELIVERY'],
    serviceCharge: n(row.service_charge_pct),
    serviceChargeName: row.service_charge_name || null,
    ...(tipType === 'NONE' ? {} : { tipOption: { tipsPrice: n(row.tip_default_value, 15), tipsType: tipType === 'CUSTOM' ? 'CUSTOM' : 'PERCENTAGE' } }),
    pickupOrderMinimum: n(row.pickup_order_minimum),
    deliveryOrderMinimum: n(row.delivery_order_minimum),
  }
}

// Timing fields merged into the scheduleOption the availability engine reads.
export function menuRowToScheduleExtras(row: MenuSettingsRow) {
  return {
    prepTime: row.lead_time_hours != null ? Number(row.lead_time_hours) : 24,
    rollingAvailability: row.rolling_availability_days != null ? Number(row.rolling_availability_days) : 90,
    ...(row.daily_cutoff_time ? { cutOff: row.daily_cutoff_time } : {}),
    ...(row.hard_cutoff_date ? { cutOffDate: row.hard_cutoff_date } : {}),
    ...(row.max_orders_per_day != null ? { maxOrder: row.max_orders_per_day } : {}),
  }
}

// The service-charge % a native order should use, read from its restaurant's
// primary (lowest-position, visible) menu. 0 when none.
export function primaryMenuServiceChargePct(row: MenuSettingsRow | undefined): number {
  return row ? n(row.service_charge_pct) : 0
}
