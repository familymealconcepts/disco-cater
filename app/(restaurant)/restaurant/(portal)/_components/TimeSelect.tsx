import React from 'react'

// FM serializes times as "H:mm:ss" (non-zero-padded hour, with seconds). HTML
// inputs / our <select> options need strict "HH:mm". Normalize on load so values
// match option values and single-digit hours don't blank.
export function normalizeTime(t: string | null | undefined): string {
  if (!t) return ''
  const parts = String(t).split(':')
  if (parts.length < 2) return String(t)
  return parts[0].padStart(2, '0') + ':' + parts[1]
}

// Reverse of normalizeTime: our "HH:mm" (or an already-FM "H:mm:ss") → FM's exact
// LocalTime wire format "H:mm:ss" (non-zero-padded hour, WITH seconds). FM's
// deserializer is DateTimeFormatter.ofPattern("H:mm:ss") and 500s on "09:00"
// ("Text '09:00' could not be parsed at index 5"). Idempotent — normalizeTime first
// strips any seconds/padding, then we re-emit non-padded hour + ":00".
export function toFmTime(t: string | null | undefined): string {
  const v = normalizeTime(t)
  if (!v) return ''
  const [h, m] = v.split(':')
  return `${parseInt(h, 10)}:${m}:00`
}

// 15-minute time options — "HH:mm" value with a 12-hour label. Built once.
export const TIME_OPTIONS: { value: string; label: string }[] = (() => {
  const out: { value: string; label: string }[] = []
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      const ampm = h >= 12 ? 'PM' : 'AM'
      const h12 = h % 12 || 12
      out.push({ value, label: `${h12}:${String(m).padStart(2, '0')} ${ampm}` })
    }
  }
  return out
})()

// Time picker as a 15-minute-interval dropdown (value + onChange use "HH:mm").
// An off-grid current value (e.g. a legacy "11:20") stays selectable so loading
// never blanks or silently changes it.
export function TimeSelect({ value, onChange, style }: {
  value: string
  onChange: (v: string) => void
  style?: React.CSSProperties
}) {
  const v = normalizeTime(value)
  const opts = !v || TIME_OPTIONS.some(o => o.value === v)
    ? TIME_OPTIONS
    : [{ value: v, label: v }, ...TIME_OPTIONS]
  return (
    <select value={v} onChange={e => onChange(e.target.value)} style={style}>
      {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
