'use client'
import { useState } from 'react'
import { TimeSelect, normalizeTime } from './TimeSelect'
import { formatTime12, formatTimeRange12 } from '../../../../../lib/utils/time'

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
  // normalizeTime is the WIRE normalizer ("HH:mm"), not a display format —
  // using it here is what rendered "15:30–17:00" to restaurants.
  return ivs.map(iv => formatTimeRange12(iv.fromTime, iv.toTime)).join(', ')
}

// A blackout being composed — by the Add panel or by an inline row edit. One
// shape, one validator, one form body, so the two cannot drift.
interface Draft { name: string; from: string; to: string; custom: boolean; fromTime: string; toTime: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
function dateOk(d: string): boolean {
  if (!ISO_DATE.test(d)) return false
  const [y, m, day] = d.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, day))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day
}

/**
 * The first problem with a draft, or null when it is saveable.
 *
 * Validated BEFORE save on purpose: importFmMenuFaithfully skips any blackout
 * row with no name or no parseable date and counts nothing, so a malformed row
 * saved here would not fail loudly — it would simply be absent after the next
 * import, which is far harder to notice than a refused save.
 */
function draftProblem(d: Draft, requireName: boolean): string | null {
  if (requireName && !d.name.trim()) return 'Give the blackout a name.'
  if (!d.from || !d.to) return 'Pick both dates.'
  if (!dateOk(d.from) || !dateOk(d.to)) return 'That date is not a real calendar date.'
  if (d.to < d.from) return 'The end date must be on or after the start date.'
  if (d.custom && !(d.fromTime < d.toTime)) return 'The end time must be after the start time.'
  return null
}

function draftToDay(d: Draft): SkippedDay {
  return {
    ...(d.name.trim() ? { name: d.name.trim() } : {}),
    fromDate: d.from,
    toDate: d.to || d.from,
    // Only attach intervals for custom hours. An empty array and an absent field
    // mean the same thing, and omitting it keeps whole-day entries byte-identical
    // to what the importer and every pre-existing row look like.
    ...(d.custom ? { intervals: [{ fromTime: d.fromTime, toTime: d.toTime }] } : {}),
  }
}

function dayToDraft(d: SkippedDay): Draft {
  const iv = (d.intervals ?? [])[0]
  return {
    name: d.name ?? '',
    from: d.fromDate,
    to: d.toDate || d.fromDate,
    custom: !!iv,
    // Seeded from the existing interval when there is one, so toggling
    // all-day → range → all-day never loses the hours the row already had.
    fromTime: normalizeTime(iv?.fromTime) || '09:00',
    toTime: normalizeTime(iv?.toTime) || '17:00',
  }
}

// The add panel and the row editor render THIS — same fields, same order, same
// validation message, so an edited blackout cannot end up shaped differently
// from an added one.
function BlackoutFields({ draft, set, requireName, inputStyle, labelStyle }: {
  draft: Draft; set: (d: Draft) => void; requireName: boolean
  inputStyle: React.CSSProperties; labelStyle: React.CSSProperties
}) {
  const problem = draftProblem(draft, requireName)
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Name{requireName ? '' : ' (optional)'}</label>
        <input style={inputStyle} value={draft.name} onChange={e => set({ ...draft, name: e.target.value })} placeholder="e.g. Thanksgiving" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div><label style={labelStyle}>From date</label><input type="date" style={inputStyle} value={draft.from} onChange={e => set({ ...draft, from: e.target.value })} /></div>
        <div><label style={labelStyle}>To date</label><input type="date" style={inputStyle} value={draft.to} onChange={e => set({ ...draft, to: e.target.value })} /></div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: draft.custom ? 12 : 0 }}>
        {/* Toggling either way keeps name and dates — only `custom` changes. */}
        <ModeBtn active={!draft.custom} onClick={() => set({ ...draft, custom: false })}>Closed all day</ModeBtn>
        <ModeBtn active={draft.custom} onClick={() => set({ ...draft, custom: true })}>Custom hours</ModeBtn>
      </div>
      {draft.custom && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {/* TimeSelect, never <input type="time"> — the native picker renders
              24-hour on many systems. These options are labelled 12-hour. */}
          <div><label style={labelStyle}>From</label><TimeSelect style={inputStyle} value={draft.fromTime} onChange={v => set({ ...draft, fromTime: v })} /></div>
          <div><label style={labelStyle}>To</label><TimeSelect style={inputStyle} value={draft.toTime} onChange={v => set({ ...draft, toTime: v })} /></div>
        </div>
      )}
      <div style={{ fontSize: 12, color: problem ? '#E24B4A' : '#888', marginTop: 8 }}>
        {problem ?? (draft.custom
          ? `Orders between ${formatTime12(draft.fromTime)} and ${formatTime12(draft.toTime)} are blocked, including both times. The rest of the day stays open.`
          : 'The whole day is blocked.')}
      </div>
    </>
  )
}

const EMPTY_DRAFT: Draft = { name: '', from: '', to: '', custom: false, fromTime: '09:00', toTime: '17:00' }

export function SkippedDaysEditor({ value, onChange, inputStyle, labelStyle, requireName = true, editable = false }: {
  value: SkippedDay[]
  onChange: (v: SkippedDay[]) => void
  inputStyle: React.CSSProperties
  labelStyle: React.CSSProperties
  /** manage-v2 requires a name (FM does); the native form treats it as optional. */
  requireName?: boolean
  /**
   * Allow clicking a row to edit it. OFF by default, and deliberately so.
   *
   * This component is shared by two screens that save to DIFFERENT systems:
   * menu-manager/_MenuForm PUTs /api/restaurant/disco-menus/{ref}, which writes
   * disco_menus.skipped_days in NEON; manage-v2/menus/MenuSettingsDialog PUTs
   * /api/restaurant/menus/{ref}, which proxies FamilyMeal. Editing is enabled
   * only by the native form, so this feature can never become a new way to
   * write a blackout into FM. The FM-backed screen keeps today's read-only rows.
   */
  editable?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  // Index of the row being edited, and its own draft — separate from the add
  // draft so opening one never disturbs the other.
  const [editIdx, setEditIdx] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT)

  const addProblem = draftProblem(draft, requireName)
  const editProblem = draftProblem(editDraft, requireName)

  function reset() { setDraft(EMPTY_DRAFT); setAdding(false) }
  function add() {
    if (addProblem) return
    onChange([...value, draftToDay(draft)])
    reset()
  }
  function openEdit(i: number) {
    setAdding(false)
    setEditIdx(i)
    setEditDraft(dayToDraft(value[i]))
  }
  function cancelEdit() { setEditIdx(null); setEditDraft(EMPTY_DRAFT) }
  function saveEdit() {
    if (editIdx === null || editProblem) return
    onChange(value.map((d, j) => (j === editIdx ? draftToDay(editDraft) : d)))
    cancelEdit()
  }

  return (
    <div>
      {value.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {value.map((d, i) => (
            editIdx === i ? (
              <div key={i} style={{ border: '1px solid ' + INDIGO, borderRadius: 10, padding: 14, marginBottom: 6, background: '#fff' }}>
                <BlackoutFields draft={editDraft} set={setEditDraft} requireName={requireName} inputStyle={inputStyle} labelStyle={labelStyle} />
                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  <button type="button" onClick={saveEdit} disabled={!!editProblem}
                    style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: editProblem ? 'default' : 'pointer', fontFamily: F, opacity: editProblem ? 0.5 : 1 }}>Save</button>
                  <button type="button" onClick={cancelEdit}
                    style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: '#555' }}>Cancel</button>
                </div>
              </div>
            ) : (
            <div key={i}
              onClick={editable ? () => openEdit(i) : undefined}
              role={editable ? 'button' : undefined}
              tabIndex={editable ? 0 : undefined}
              onKeyDown={editable ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(i) } }) : undefined}
              title={editable ? 'Edit this blackout' : undefined}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', border: '1px solid #eee', borderRadius: 8, marginBottom: 6, background: '#fafafe', cursor: editable ? 'pointer' : 'default', transition: 'border-color 0.12s ease, background 0.12s ease' }}
              onMouseOver={editable ? (e => { const t = e.currentTarget as HTMLElement; t.style.borderColor = INDIGO; t.style.background = '#f6f5ff' }) : undefined}
              onMouseOut={editable ? (e => { const t = e.currentTarget as HTMLElement; t.style.borderColor = '#eee'; t.style.background = '#fafafe' }) : undefined}
            >
              <div style={{ fontSize: 13, color: DARK }}>
                {d.name && <span style={{ fontWeight: 600, textDecoration: editable ? 'underline' : 'none', textDecorationColor: '#d5d3ea', textUnderlineOffset: 3 }}>{d.name}</span>}
                <span style={{ color: '#888' }}>{d.name ? ' · ' : ''}{d.fromDate}{d.toDate !== d.fromDate ? ` → ${d.toDate}` : ''} · {describeSkippedDay(d)}</span>
              </div>
              {/* stopPropagation so the X deletes without ALSO opening the editor. */}
              <button type="button" onClick={e => { e.stopPropagation(); if (editIdx === i) cancelEdit(); onChange(value.filter((_, j) => j !== i)) }} aria-label="Remove blackout"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#E24B4A', fontSize: 18, lineHeight: 1, flexShrink: 0, marginLeft: 10 }}>×</button>
            </div>
            )
          ))}
        </div>
      )}

      {adding ? (
        <div style={{ border: '1px dashed #d8d8e4', borderRadius: 10, padding: 14 }}>
          <BlackoutFields draft={draft} set={setDraft} requireName={requireName} inputStyle={inputStyle} labelStyle={labelStyle} />
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button type="button" onClick={add} disabled={!!addProblem}
              style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: addProblem ? 'default' : 'pointer', fontFamily: F, opacity: addProblem ? 0.5 : 1 }}>Add</button>
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
