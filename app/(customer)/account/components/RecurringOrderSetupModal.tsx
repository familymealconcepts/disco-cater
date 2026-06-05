'use client'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const GOLD = '#EFB84A'
const LIGHT_PURPLE = '#F5F4FF'

// ── Source order (the past order being turned into a recurring one) ──────────
export interface RecurringSourceOrder {
  orderReference: string
  restaurantName: string
  restaurantSlug: string
  restaurantReference: string
  items: { name: string; quantity: number; price?: number }[]
  total: number
}

interface Props {
  isOpen: boolean
  onClose: () => void
  sourceOrder: RecurringSourceOrder
}

type FrequencyType = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'
type EndKind = 'NEVER' | 'COUNT' | 'DATE'
type CardStatus = 'checking' | 'has' | 'none' | 'unknown'

// ── Date helpers (all UTC to avoid local-timezone drift on DATE values) ─────
// NOTE: the occurrence-generation logic below is intentionally a faithful copy
// of lib/recurring.ts generateOccurrences(). That module imports next/headers
// (cookies), so it can't be pulled into a client component — replicating the
// pure date math keeps this preview byte-for-byte consistent with what the
// server actually persists on POST.

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
const DAY_INDEX: Record<string, number> = {
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
}

function parseUTC(d: string): Date {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day))
}
function fmtISO(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000)
}
function nthWeekdayOfMonth(year: number, month: number, weekday: number, ordinal: number): Date | null {
  const firstOfMonth = new Date(Date.UTC(year, month, 1))
  const offset = (weekday - firstOfMonth.getUTCDay() + 7) % 7
  const day = 1 + offset + (ordinal - 1) * 7
  const candidate = new Date(Date.UTC(year, month, day))
  if (candidate.getUTCMonth() !== month) return null
  return candidate
}

function generateOccurrences(
  frequencyType: FrequencyType,
  startDate: string,
  repeatEveryDay: string,
  endKind: EndKind,
  endCount: number | null,
  endDate: string | null,
): string[] {
  const weekday = DAY_INDEX[repeatEveryDay?.toUpperCase()]
  const start = parseUTC(startDate)

  let first = start
  if (weekday !== undefined) {
    const diff = (weekday - start.getUTCDay() + 7) % 7
    first = addDays(start, diff)
  }

  const cap = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 12, start.getUTCDate()))
  const hardEnd = endKind === 'DATE' && endDate ? parseUTC(endDate) : null
  const maxCount = endKind === 'COUNT' && endCount ? endCount : Infinity

  const out: string[] = []

  if (frequencyType === 'WEEKLY' || frequencyType === 'BIWEEKLY') {
    const step = frequencyType === 'WEEKLY' ? 7 : 14
    for (let cur = first; out.length < maxCount && cur <= cap; cur = addDays(cur, step)) {
      if (hardEnd && cur > hardEnd) break
      out.push(fmtISO(cur))
    }
  } else if (frequencyType === 'MONTHLY') {
    const wd = weekday ?? first.getUTCDay()
    const ordinal = Math.floor((first.getUTCDate() - 1) / 7) + 1
    let year = first.getUTCFullYear()
    let month = first.getUTCMonth()
    for (let i = 0; i < 13 && out.length < maxCount; i++) {
      const occ = nthWeekdayOfMonth(year, month, wd, ordinal)
      if (occ && occ >= first) {
        if (occ > cap) break
        if (hardEnd && occ > hardEnd) break
        out.push(fmtISO(occ))
      }
      month++
      if (month > 11) { month = 0; year++ }
    }
  }

  return out
}

// ── Display formatters ──────────────────────────────────────────────────────

function tomorrowISO(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}
function fmtMoney(n?: number) { return `$${(n || 0).toFixed(2)}` }
function titleCase(s: string) { return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s }

// Weekday derived from a YYYY-MM-DD start date (UTC-safe).
function dayOf(dateISO: string): string {
  if (!dateISO) return ''
  return DAY_NAMES[parseUTC(dateISO).getUTCDay()]
}
// "Wednesday" — long weekday for helper copy.
function weekdayLong(dateISO: string): string {
  if (!dateISO) return ''
  return parseUTC(dateISO).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
}
// "Jun 11, 2026"
function fmtLong(dateISO?: string): string {
  if (!dateISO) return ''
  return parseUTC(dateISO).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
// "Mon, Jun 11"
function fmtShort(dateISO: string): string {
  return parseUTC(dateISO).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}
function frequencyWord(f: FrequencyType): string {
  return f === 'WEEKLY' ? 'Weekly' : f === 'BIWEEKLY' ? 'Bi-weekly' : 'Monthly'
}
// "Weekly on Mondays"
function frequencyLabel(f: FrequencyType, repeatEveryDay: string): string {
  const day = titleCase(repeatEveryDay)
  return day ? `${frequencyWord(f)} on ${day}s` : frequencyWord(f)
}

// ── Component ────────────────────────────────────────────────────────────────

export default function RecurringOrderSetupModal({ isOpen, onClose, sourceOrder }: Props) {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [frequency, setFrequency] = useState<FrequencyType>('WEEKLY')
  const [startDate, setStartDate] = useState<string>(tomorrowISO())
  const [endKind, setEndKind] = useState<EndKind>('NEVER')
  const [endCount, setEndCount] = useState<number>(12)
  const [endDate, setEndDate] = useState<string>('')
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [cardStatus, setCardStatus] = useState<CardStatus>('checking')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [successDate, setSuccessDate] = useState<string | null>(null)

  // Fresh state every time the modal opens.
  useEffect(() => {
    if (!isOpen) return
    setStep(1)
    setFrequency('WEEKLY')
    setStartDate(tomorrowISO())
    setEndKind('NEVER')
    setEndCount(12)
    setEndDate('')
    setAdvancedOpen(false)
    setSubmitting(false)
    setError('')
    setSuccessDate(null)
  }, [isOpen])

  // Detect a saved card so we can warn (and block) when none is on file.
  // Treats fetch failures as "unknown" — we never block on a flaky check,
  // only on a definitive "no card".
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setCardStatus('checking')
    fetch('/api/fm-payment-source', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (!cancelled) setCardStatus(d ? 'has' : 'none') })
      .catch(() => { if (!cancelled) setCardStatus('unknown') })
    return () => { cancelled = true }
  }, [isOpen])

  const repeatEveryDay = useMemo(() => dayOf(startDate), [startDate])

  const occurrences = useMemo(
    () => generateOccurrences(
      frequency,
      startDate,
      repeatEveryDay,
      endKind,
      endKind === 'COUNT' ? endCount : null,
      endKind === 'DATE' ? endDate : null,
    ),
    [frequency, startDate, repeatEveryDay, endKind, endCount, endDate],
  )

  // ESC closes (unless mid-submit).
  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !submitting) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose, submitting])

  if (!isOpen) return null

  async function confirm() {
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/recurring-orders', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantReference: sourceOrder.restaurantReference,
          restaurantName: sourceOrder.restaurantName,
          restaurantSlug: sourceOrder.restaurantSlug,
          sourceOrderReference: sourceOrder.orderReference,
          frequencyType: frequency,
          repeatEveryDay,
          startDate,
          endKind,
          endCount: endKind === 'COUNT' ? endCount : null,
          endDate: endKind === 'DATE' ? endDate : null,
          cartSnapshot: sourceOrder.items,
          sourceOrderTotal: sourceOrder.total,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        throw new Error(d?.error || `Could not set up recurring order (HTTP ${res.status})`)
      }
      const data = await res.json()
      const firstOcc: string | undefined =
        data?.recurringOrder?.occurrences?.[0]?.scheduled_date || occurrences[0]
      setSuccessDate(firstOcc || startDate)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const success = successDate !== null

  return (
    <div onClick={() => !submitting && onClose()} style={backdrop}>
      <div onClick={e => e.stopPropagation()} className="rosm-modal" style={modal}>
        <style>{`
          @media (max-width: 560px) {
            .rosm-modal { max-width: 100% !important; width: 100% !important; height: 100% !important; max-height: 100% !important; border-radius: 0 !important; }
          }
        `}</style>

        {/* Header */}
        <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: DARK }}>
              {success ? 'All set!' : 'Set up recurring order'}
            </h2>
            {!success && (
              <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>
                Step {step} of 3 · <span style={{ color: DARK, fontWeight: 600 }}>{sourceOrder.restaurantName}</span>
              </div>
            )}
          </div>
          <button onClick={() => !submitting && onClose()} aria-label="Close" style={closeBtn}>×</button>
        </div>

        {/* Progress bar */}
        {!success && (
          <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0' }}>
            {[1, 2, 3].map(n => (
              <div key={n} style={{ flex: 1, height: 4, borderRadius: 2, background: n <= step ? BLUE : '#ececf2' }} />
            ))}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {success ? (
            <SuccessScreen date={successDate!} />
          ) : step === 1 ? (
            <Step1
              frequency={frequency} setFrequency={setFrequency}
              startDate={startDate} setStartDate={setStartDate}
              repeatEveryDay={repeatEveryDay}
              endKind={endKind} setEndKind={setEndKind}
              endCount={endCount} setEndCount={setEndCount}
              endDate={endDate} setEndDate={setEndDate}
              advancedOpen={advancedOpen} setAdvancedOpen={setAdvancedOpen}
            />
          ) : step === 2 ? (
            <Step2 occurrences={occurrences} startDate={startDate} frequency={frequency} />
          ) : (
            <Step3
              sourceOrder={sourceOrder}
              frequency={frequency}
              repeatEveryDay={repeatEveryDay}
              startDate={startDate}
              endKind={endKind} endCount={endCount} endDate={endDate}
              cardStatus={cardStatus}
              error={error}
            />
          )}
        </div>

        {/* Footer */}
        {success ? (
          <div style={{ padding: '16px 24px', borderTop: '1px solid #f0f0f0' }}>
            <button onClick={() => { onClose(); router.push('/account/subscriptions') }}
              style={{ ...pillBtn, width: '100%', background: BLUE, color: '#fff' }}>
              View recurring orders →
            </button>
          </div>
        ) : (
          <div style={{ padding: '14px 24px', borderTop: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => setStep(s => Math.max(1, s - 1))}
              disabled={step === 1 || submitting}
              style={{ ...secondaryBtn, opacity: step === 1 ? 0.4 : 1, cursor: step === 1 ? 'not-allowed' : 'pointer' }}>
              ← Back
            </button>
            {step < 3 ? (
              <button onClick={() => setStep(s => Math.min(3, s + 1))}
                disabled={step === 1 ? !startDate : false}
                style={{ ...pillBtn, background: BLUE, color: '#fff', opacity: (step === 1 && !startDate) ? 0.5 : 1 }}>
                {step === 1 ? 'Next →' : 'Looks good, continue →'}
              </button>
            ) : (
              <button onClick={confirm}
                disabled={submitting || cardStatus === 'none'}
                style={{ ...pillBtn, background: BLUE, color: '#fff', opacity: (submitting || cardStatus === 'none') ? 0.5 : 1, cursor: (submitting || cardStatus === 'none') ? 'not-allowed' : 'pointer' }}>
                {submitting ? 'Setting up your recurring order…' : 'Confirm recurring order'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Step 1: Frequency + start date + advanced end condition ─────────────────

function Step1({
  frequency, setFrequency, startDate, setStartDate, repeatEveryDay,
  endKind, setEndKind, endCount, setEndCount, endDate, setEndDate,
  advancedOpen, setAdvancedOpen,
}: {
  frequency: FrequencyType; setFrequency: (f: FrequencyType) => void
  startDate: string; setStartDate: (s: string) => void; repeatEveryDay: string
  endKind: EndKind; setEndKind: (e: EndKind) => void
  endCount: number; setEndCount: (n: number) => void
  endDate: string; setEndDate: (s: string) => void
  advancedOpen: boolean; setAdvancedOpen: (b: boolean) => void
}) {
  const opts: { v: FrequencyType; label: string; sub: string }[] = [
    { v: 'WEEKLY', label: 'Weekly', sub: 'Every week on the same day' },
    { v: 'BIWEEKLY', label: 'Bi-weekly', sub: 'Every two weeks on the same day' },
    { v: 'MONTHLY', label: 'Monthly', sub: 'Once a month on the same week and day' },
  ]
  return (
    <div>
      <h3 style={stepTitle}>How often would you like to repeat this order?</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {opts.map(o => {
          const active = frequency === o.v
          return (
            <button key={o.v} onClick={() => setFrequency(o.v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
                padding: '16px 16px', borderRadius: 12, cursor: 'pointer', fontFamily: F,
                border: active ? `2px solid ${BLUE}` : '2px solid #e8e8e8',
                background: active ? LIGHT_PURPLE : '#fff',
              }}>
              <span style={{
                width: 20, height: 20, borderRadius: '50%', border: `2px solid ${active ? BLUE : '#ccc'}`,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {active && <span style={{ width: 10, height: 10, borderRadius: '50%', background: BLUE }} />}
              </span>
              <span>
                <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: DARK }}>{o.label}</span>
                <span style={{ display: 'block', fontSize: 12, color: '#888', marginTop: 2 }}>{o.sub}</span>
              </span>
            </button>
          )
        })}
      </div>

      {/* Start date */}
      <div style={{ marginTop: 22 }}>
        <label style={fieldLabel}>First order date</label>
        <input type="date" value={startDate} min={tomorrowISO()} onChange={e => setStartDate(e.target.value)}
          style={dateInput} />
        {startDate && (
          <p style={{ fontSize: 12, color: '#888', margin: '8px 0 0', lineHeight: 1.5 }}>
            Your orders will repeat on <strong style={{ color: DARK }}>{weekdayLong(startDate)}s</strong> — e.g. if you pick {fmtShort(startDate)}, {frequency === 'MONTHLY' ? 'monthly' : frequency === 'BIWEEKLY' ? 'bi-weekly' : 'weekly'} orders will repeat every {weekdayLong(startDate)}.
          </p>
        )}
      </div>

      {/* Advanced options — end condition */}
      <div style={{ marginTop: 20, borderTop: '1px solid #f0f0f0', paddingTop: 14 }}>
        <button onClick={() => setAdvancedOpen(!advancedOpen)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: F, fontSize: 13, fontWeight: 600, color: BLUE, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ transform: advancedOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▸</span>
          Advanced options
        </button>
        {advancedOpen && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <EndRadio checked={endKind === 'NEVER'} onClick={() => setEndKind('NEVER')} label="Repeat indefinitely" />
            <EndRadio checked={endKind === 'COUNT'} onClick={() => setEndKind('COUNT')} label="End after">
              {endKind === 'COUNT' && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <input type="number" min={1} max={520} value={endCount || ''}
                    onChange={e => setEndCount(parseInt(e.target.value) || 0)}
                    onClick={e => e.stopPropagation()}
                    style={{ width: 64, padding: '6px 9px', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, fontFamily: F, color: DARK, outline: 'none' }} />
                  <span style={{ fontSize: 13, color: DARK }}>orders</span>
                </span>
              )}
            </EndRadio>
            <EndRadio checked={endKind === 'DATE'} onClick={() => setEndKind('DATE')} label="End by date">
              {endKind === 'DATE' && (
                <input type="date" value={endDate} min={startDate || tomorrowISO()}
                  onChange={e => setEndDate(e.target.value)} onClick={e => e.stopPropagation()}
                  style={{ padding: '6px 9px', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, fontFamily: F, color: DARK, outline: 'none' }} />
              )}
            </EndRadio>
          </div>
        )}
      </div>
    </div>
  )
}

function EndRadio({ checked, onClick, label, children }: { checked: boolean; onClick: () => void; label: string; children?: React.ReactNode }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flexWrap: 'wrap' }}>
      <span style={{
        width: 16, height: 16, borderRadius: '50%', border: `2px solid ${checked ? BLUE : '#ccc'}`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {checked && <span style={{ width: 8, height: 8, borderRadius: '50%', background: BLUE }} />}
      </span>
      <span style={{ fontSize: 13, color: DARK }}>{label}</span>
      {children}
    </div>
  )
}

// ── Step 2: 3-month calendar preview + first 6 dates ────────────────────────

function Step2({ occurrences, startDate, frequency }: { occurrences: string[]; startDate: string; frequency: FrequencyType }) {
  const occSet = useMemo(() => new Set(occurrences), [occurrences])
  // Anchor the 3-month window to the start date's month so the highlighted
  // dates are always visible (the first order may be in a future month).
  const anchor = parseUTC(startDate || tomorrowISO())
  const months = [0, 1, 2].map(i => ({
    year: anchor.getUTCFullYear() + Math.floor((anchor.getUTCMonth() + i) / 12),
    month: (anchor.getUTCMonth() + i) % 12,
  }))
  const freqWord = frequency === 'WEEKLY' ? 'Weekly' : frequency === 'BIWEEKLY' ? 'Bi-weekly' : 'Monthly'

  return (
    <div>
      <h3 style={stepTitle}>Here&apos;s your order schedule</h3>
      <p style={{ fontSize: 13, color: '#777', margin: '0 0 16px', lineHeight: 1.5 }}>
        Review your upcoming order dates before confirming.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {months.map(m => <MiniMonth key={`${m.year}-${m.month}`} year={m.year} month={m.month} occSet={occSet} />)}
      </div>

      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
          Upcoming orders
        </div>
        {occurrences.length === 0 ? (
          <div style={{ fontSize: 13, color: '#999' }}>No dates in range — try an earlier start date.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {occurrences.slice(0, 6).map(d => (
              <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: DARK }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: BLUE, flexShrink: 0 }} />
                <span style={{ fontWeight: 600 }}>{fmtShort(d)}</span>
                <span style={{ color: '#999' }}>· {freqWord}</span>
              </div>
            ))}
            {occurrences.length > 6 && (
              <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>+ {occurrences.length - 6} more scheduled</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function MiniMonth({ year, month, occSet }: { year: number; month: number; occSet: Set<string> }) {
  const monthName = new Date(Date.UTC(year, month, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay()
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const cells: (number | null)[] = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  return (
    <div style={{ border: '1px solid #f0f0f0', borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: DARK, marginBottom: 10 }}>{monthName}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
          <div key={`h-${i}`} style={{ fontSize: 10, fontWeight: 700, color: '#bbb', paddingBottom: 4 }}>{w}</div>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <div key={`e-${i}`} />
          const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
          const on = occSet.has(iso)
          return (
            <div key={`d-${i}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2px 0' }}>
              <span style={{
                width: 26, height: 26, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: on ? 700 : 500,
                background: on ? BLUE : 'transparent',
                color: on ? '#fff' : '#555',
              }}>{d}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Step 3: Review & confirm ────────────────────────────────────────────────

function Step3({
  sourceOrder, frequency, repeatEveryDay, startDate, endKind, endCount, endDate, cardStatus, error,
}: {
  sourceOrder: RecurringSourceOrder
  frequency: FrequencyType; repeatEveryDay: string; startDate: string
  endKind: EndKind; endCount: number; endDate: string
  cardStatus: CardStatus; error: string
}) {
  const endText = endKind === 'NEVER' ? 'Never' : endKind === 'COUNT' ? `After ${endCount} orders` : (endDate ? fmtLong(endDate) : '—')
  return (
    <div>
      <h3 style={stepTitle}>Confirm your recurring order</h3>

      {/* Summary card */}
      <div style={{ background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 12, padding: '16px 16px' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 12 }}>{sourceOrder.restaurantName}</div>
        <SummaryRow label="Frequency" value={frequencyLabel(frequency, repeatEveryDay)} />
        <SummaryRow label="Starting" value={fmtLong(startDate)} />
        <SummaryRow label="Ending" value={endText} />
        <SummaryRow label="Order total" value={`${fmtMoney(sourceOrder.total)} per occurrence`} />
        {sourceOrder.items.length > 0 && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #ececec' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Items</div>
            {sourceOrder.items.map((it, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: DARK, padding: '3px 0' }}>
                <span>{it.name}</span>
                <span style={{ color: '#888' }}>×{it.quantity}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Payment notice */}
      <div style={{ background: GOLD, color: DARK, borderRadius: 12, padding: 16, marginTop: 16, fontSize: 13, lineHeight: 1.55 }}>
        💳 Your saved card will be automatically charged 48 hours before each order date. You&apos;ll receive a reminder 5 days before each charge. You can pause or cancel anytime.
      </div>

      {/* No-card warning */}
      {cardStatus === 'none' && (
        <div style={{ background: '#FFF3F3', border: '1px solid #F3C9C9', color: '#B23636', borderRadius: 12, padding: 14, marginTop: 12, fontSize: 13, lineHeight: 1.5 }}>
          ⚠️ You&apos;ll need a saved payment card to use recurring orders. Add a card in Payment settings before confirming.
        </div>
      )}

      {/* Submit error */}
      {error && (
        <div style={{ background: '#fff3f3', color: '#c00', borderRadius: 8, padding: 12, marginTop: 12, fontSize: 13 }}>{error}</div>
      )}
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', fontSize: 13, gap: 12 }}>
      <span style={{ color: '#888' }}>{label}</span>
      <span style={{ color: DARK, fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  )
}

// ── Success ──────────────────────────────────────────────────────────────────

function SuccessScreen({ date }: { date: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '24px 8px' }}>
      <div style={{ fontSize: 56, lineHeight: 1, marginBottom: 16 }}>🎉</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 8 }}>Your recurring order is set up!</div>
      <div style={{ fontSize: 14, color: '#777', lineHeight: 1.55, maxWidth: 360, margin: '0 auto' }}>
        Your first order is scheduled for <strong style={{ color: DARK }}>{fmtLong(date)}</strong>.
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 800,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: F,
}
const modal: React.CSSProperties = {
  background: '#fff', borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: '92vh',
  display: 'flex', flexDirection: 'column', boxShadow: '0 12px 48px rgba(0,0,0,0.18)', overflow: 'hidden',
}
const closeBtn: React.CSSProperties = {
  background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: '50%',
  fontSize: 18, color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
}
const pillBtn: React.CSSProperties = {
  padding: '11px 20px', border: 'none', borderRadius: 999, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: F,
}
const secondaryBtn: React.CSSProperties = {
  padding: '10px 16px', background: '#fff', color: DARK, border: '1px solid #e0e0e0', borderRadius: 999,
  fontSize: 13, fontWeight: 600, fontFamily: F,
}
const stepTitle: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: DARK, margin: '0 0 16px', lineHeight: 1.35 }
const fieldLabel: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 8 }
const dateInput: React.CSSProperties = {
  width: '100%', maxWidth: 240, padding: '10px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8,
  fontSize: 14, fontFamily: F, color: DARK, outline: 'none', background: '#fff',
}
