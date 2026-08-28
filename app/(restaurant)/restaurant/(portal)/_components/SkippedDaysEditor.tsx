'use client'
import { useState } from 'react'
import { TimeSelect, normalizeTime } from './TimeSelect'

// Lifted verbatim (behaviour-wise) out of manage-v2/menus/MenuSettingsDialog, which
// has had a fully interval-capable blackout editor since it proxies FM. The
// Disco-NATIVE menu form had a date-only version, which is why FM's partial-day
// blackouts had nowhere to land even once the importer could carry them. One
// component now serves both, so the two screens can't drift again.
const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'

// `intervals` optional here, unlike manage-v2's local type which required it.
// Absent and [] both mean the same thing — the whole day is blocked — and the
// native form stores the field only when non-empty (see parseSkippedDays), so the
// editor must read both.
export interface SkippedInterval { fromTime: string; toTime: string }
export interface SkippedDay {
  name?: string
  fromDate: string
  toDate: string
  intervals?: SkippedInterval[]
}

function ModeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
        border: '1.5px solid ' + (active ? INDIGO : '#e0e0e0'),
        background: active ? INDIGO : '#fff',
        color: active ? '#fff' : '#555', cursor: 'pointer', fontFamily: F,
      }}>{children}</button>
  )
}

/** "Closed all day" vs the hours actually blocked, for the summary row. */
export function describeSkippedDay(d: SkippedDay): string {
  const ivs = d.intervals ?? []
  if (!ivs.length) return 'Closed all day'
  return ivs.map(iv => `${normalizeTime(iv.fromTime)}–${normalizeTime(iv.toTime)}`).join(', ')
}

export function SkippedDaysEditor({ value, onChange, inputStyle, labelStyle, requireName = true }: {
  value: SkippedDay[]
  onChange: (v: SkippedDay[]) => void
  inputStyle: React.CSSProperties
  labelStyle: React.CSSProperties
  /** manage-v2 requires a name (FM does); the native form treats it as optional. */
  requireName?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [custom, setCustom] = useState(false)
  const [fromTime, setFromTime] = useState('09:00')
  const [toTime, setToTime] = useState('17:00')

  const timesValid = !custom || fromTime < toTime
  const canAdd = (!requireName || !!name.trim()) && !!from && !!to && timesValid

  function reset() { setName(''); setFrom(''); setTo(''); setCustom(false); setFromTime('09:00'); setToTime('17:00'); setAdding(false) }
  function add() {
    if (!canAdd) return
    onChange([...value, {
      ...(name.trim() ? { name: name.trim() } : {}),
      fromDate: from,
      toDate: to || from,
      // Only attach intervals when custom hours were chosen. An empty array and an
      // absent field mean the same thing, and omitting it keeps whole-day entries
      // byte-identical to what the importer and every pre-existing row look like.
      ...(custom ? { intervals: [{ fromTime, toTime }] } : {}),
    }])
    reset()
  }

  return (
    <div>
      {value.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {value.map((d, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', border: '1px solid #eee', borderRadius: 8, marginBottom: 6, background: '#fafafe' }}>
              <div style={{ fontSize: 13, color: DARK }}>
                {d.name && <span style={{ fontWeight: 600 }}>{d.name}</span>}
                <span style={{ color: '#888' }}>{d.name ? ' · ' : ''}{d.fromDate}{d.toDate !== d.fromDate ? ` → ${d.toDate}` : ''} · {describeSkippedDay(d)}</span>
              </div>
              <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove blackout"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#E24B4A', fontSize: 18, lineHeight: 1 }}>×</button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div style={{ border: '1px dashed #d8d8e4', borderRadius: 10, padding: 14 }}>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Name{requireName ? '' : ' (optional)'}</label>
            <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Thanksgiving" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div><label style={labelStyle}>From date</label><input type="date" style={inputStyle} value={from} onChange={e => setFrom(e.target.value)} /></div>
            <div><label style={labelStyle}>To date</label><input type="date" style={inputStyle} value={to} onChange={e => setTo(e.target.value)} /></div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: custom ? 12 : 0 }}>
            <ModeBtn active={!custom} onClick={() => setCustom(false)}>Closed all day</ModeBtn>
            <ModeBtn active={custom} onClick={() => setCustom(true)}>Custom hours</ModeBtn>
          </div>
          {custom && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div><label style={labelStyle}>From</label><TimeSelect style={inputStyle} value={fromTime} onChange={setFromTime} /></div>
                <div><label style={labelStyle}>To</label><TimeSelect style={inputStyle} value={toTime} onChange={setToTime} /></div>
              </div>
              <div style={{ fontSize: 12, color: timesValid ? '#888' : '#E24B4A', marginTop: 8 }}>
                {timesValid
                  ? `Orders between ${normalizeTime(fromTime)} and ${normalizeTime(toTime)} are blocked, including both times. The rest of the day stays open.`
                  : 'The end time must be after the start time.'}
              </div>
            </>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button type="button" onClick={add} disabled={!canAdd}
              style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: canAdd ? 'pointer' : 'default', fontFamily: F, opacity: canAdd ? 1 : 0.5 }}>Add</button>
            <button type="button" onClick={reset}
              style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: '#555' }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)}
          style={{ background: 'transparent', border: '1.5px solid ' + INDIGO, borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: INDIGO }}>+ Add blackout</button>
      )}
    </div>
  )
}
