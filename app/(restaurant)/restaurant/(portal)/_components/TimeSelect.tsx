import React from 'react'
import { formatTime12 } from '../../../../../lib/utils/time'

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
      out.push({ value, label: formatTime12(value) })
    }
  }
  return out
})()

// Whole-hour options only — for pickers whose consumer cannot act on minutes.
export const HOUR_OPTIONS: { value: string; label: string }[] =
  TIME_OPTIONS.filter(o => o.value.endsWith(':00'))

// Time picker as a 15-minute-interval dropdown (value + onChange use "HH:mm").
// An off-grid current value (e.g. a legacy "11:20") stays selectable so loading
// never blanks or silently changes it.
//
// hourOnly restricts the list to whole hours. Scheduled reports use it because
// the cron that sends them runs hourly: a stored 08:56 can only ever fire at
// 08:00, and one live report is saved exactly that way. Offering a minute the
// system will discard is an interface that lies, so it stops being offered.
// An existing off-grid value is still shown (rounded down, with a note in the
// form) rather than silently blanked.
export function TimeSelect({ value, onChange, style, hourOnly, allowNone, noneLabel }: {
  value: string
  onChange: (v: string) => void
  style?: React.CSSProperties
  hourOnly?: boolean
  allowNone?: boolean
  noneLabel?: string
}) {
  const v = normalizeTime(value)
  const BASE = hourOnly ? HOUR_OPTIONS : TIME_OPTIONS
  const grid = !v || BASE.some(o => o.value === v)
    ? BASE
    // An off-grid legacy value keeps its slot, but is LABELLED in 12-hour form
    // like every other option rather than shown raw as "11:20".
    : [{ value: v, label: formatTime12(v) }, ...BASE]
  // OPT-IN ONLY. Without it the empty value matches no option, and a browser
  // renders such a <select> showing its FIRST option — "12:00 AM" — while the
  // bound state is still "". So an unset daily cutoff READ as a midnight
  // deadline on screen, for all 1,124 menus that have none. The two are not the
  // same thing: "" is no cutoff at all, while "00:00" is a real cutoff that
  // closes same-day ordering from 00:01 onward (lib/scheduling/cutoffs.ts).
  //
  // Every other caller — menu windows, skipped days, report and order times —
  // requires a time, so an empty option there would offer a value their callers
  // cannot act on. They keep the old list untouched.
  const opts = allowNone ? [{ value: '', label: noneLabel ?? 'None' }, ...grid] : grid
  return (
    <select value={v} onChange={e => onChange(e.target.value)} style={style}>
      {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
