// A location's STORE hours (disco_restaurant_overrides.store_hours) — see the
// column's note in lib/db.ts. Several windows a day are allowed ("12:00 PM -
// 2:00 PM; 5:00 PM - 9:15 PM"), and a window whose close is earlier than its
// open runs past midnight ("10:30 AM - 12:50 AM"). Times are the restaurant's
// own local time. Record and display only: a menu's ordering window lives on
// that menu's schedule.

export const STORE_DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const
export type StoreDay = typeof STORE_DAYS[number]
export type StoreWindow = { open: string; close: string }
export type StoreHours = Partial<Record<StoreDay, StoreWindow[]>>

const TIME_RE = /^\s*(\d{1,2}):(\d{2})\s*([AP])\.?M\.?\s*$/i

/** "5:00 PM" → "17:00"; null when unreadable. */
export function to24h(t: string): string | null {
  const m = TIME_RE.exec(t || '')
  if (!m) return null
  let h = Number(m[1]) % 12
  if (m[3].toUpperCase() === 'P') h += 12
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

/** "12:00 PM - 2:00 PM; 5:00 PM - 9:15 PM" → windows; null when any part is unreadable. "Closed"/blank → []. */
export function parseDayHours(text: string | null | undefined): StoreWindow[] | null {
  const s = String(text || '').trim()
  if (!s || /^closed$/i.test(s)) return []
  const out: StoreWindow[] = []
  for (const part of s.split(/[;,]/).map(x => x.trim()).filter(Boolean)) {
    const [a, b] = part.split(/\s*[-–—]\s*/)
    const open = to24h(a || ''), close = to24h(b || '')
    if (!open || !close) return null
    out.push({ open, close })
  }
  return out
}

function to12h(t: string): string {
  const [h, m] = t.split(':').map(Number)
  const ap = h >= 12 ? 'PM' : 'AM'
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ap}`
}

/** One line per day, e.g. "Monday: 12:00 PM – 2:00 PM, 5:00 PM – 9:15 PM". */
export function formatStoreHours(hours: StoreHours | null | undefined): { day: string; text: string }[] {
  if (!hours || typeof hours !== 'object') return []
  return STORE_DAYS.filter(d => d in hours).map(d => {
    const w = hours[d] || []
    const label = d[0] + d.slice(1).toLowerCase()
    return {
      day: label,
      text: w.length
        ? w.map(x => `${to12h(x.open)} – ${to12h(x.close)}${x.close < x.open ? ' (next day)' : ''}`).join(', ')
        : 'Closed',
    }
  })
}
