'use client'
import { useState, useEffect, useCallback } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '22px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: DARK, marginTop: 0, marginBottom: 18 }}>{title}</h2>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{ width: 44, height: 24, borderRadius: 12, background: checked ? INDIGO : '#d1d5db', border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.15s', flexShrink: 0 }}
    >
      <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: checked ? 23 : 3, transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
    </button>
  )
}

function SaveButton({ onClick, loading, label = 'Save Changes' }: { onClick: () => void; loading: boolean; label?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{ padding: '10px 22px', background: loading ? '#ccc' : INDIGO, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: F }}
    >
      {loading ? 'Saving…' : label}
    </button>
  )
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

function buildCalendarDays(year: number, month: number) {
  const first = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const offset = (first === 0 ? 6 : first - 1) // Monday-first
  return { offset, daysInMonth }
}

export default function AvailabilityPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  // Lead time
  const [leadHours, setLeadHours] = useState(36)
  // Cutoff time
  const [cutoffTime, setCutoffTime] = useState('17:00')
  // Operating hours
  const [opDays, setOpDays] = useState<boolean[]>(Array(7).fill(true))
  const [opOpen, setOpOpen] = useState<string[]>(Array(7).fill('09:00'))
  const [opClose, setOpClose] = useState<string[]>(Array(7).fill('17:00'))
  // Blackout dates
  const [blackoutDates, setBlackoutDates] = useState<Set<string>>(new Set())
  const [calYear, setCalYear] = useState(new Date().getFullYear())
  const [calMonth, setCalMonth] = useState(new Date().getMonth())
  // Order minimum
  const [orderMinimum, setOrderMinimum] = useState('0.00')

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/availability', { credentials: 'include' })
      if (res.ok) {
        const d = await res.json()
        if (d.leadTimeHours != null) setLeadHours(d.leadTimeHours)
        if (d.cutoffTime) setCutoffTime(d.cutoffTime)
        if (d.operatingHours) {
          setOpDays(DAYS.map((_, i) => d.operatingHours[i]?.enabled ?? true))
          setOpOpen(DAYS.map((_, i) => d.operatingHours[i]?.open || '09:00'))
          setOpClose(DAYS.map((_, i) => d.operatingHours[i]?.close || '17:00'))
        }
        if (d.blackoutDates) setBlackoutDates(new Set(d.blackoutDates))
        if (d.orderMinimum != null) setOrderMinimum(String(d.orderMinimum))
      } else {
        const err = await res.json()
        setError(err.error || `FM API returned ${res.status}`)
      }
    } catch {
      setError('Unable to load availability settings.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function save(section: string, payload: object) {
    setSaving(section)
    try {
      const res = await fetch('/api/restaurant/availability', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        setLastSaved(new Date())
        showToast('Saved successfully', true)
      } else {
        const d = await res.json()
        showToast(d.error || 'Failed to save', false)
      }
    } catch {
      showToast('Failed to save', false)
    } finally {
      setSaving(null)
    }
  }

  function toggleDate(dateStr: string) {
    setBlackoutDates(prev => {
      const next = new Set(prev)
      if (next.has(dateStr)) next.delete(dateStr)
      else next.add(dateStr)
      return next
    })
  }

  const { offset, daysInMonth } = buildCalendarDays(calYear, calMonth)
  const calCells = Array(offset).fill(null).concat(Array.from({ length: daysInMonth }, (_, i) => i + 1))

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .avail-input { padding: 9px 13px; border: 1.5px solid #e0e0e0; border-radius: 9px; font-size: 13px; font-family: ${F}; color: ${DARK}; outline: none; }
        .avail-input:focus { border-color: ${INDIGO}; }
        .cal-day { width: 38px; height: 38px; border-radius: 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 13px; font-weight: 500; transition: background 0.1s; }
        .cal-day:hover:not(.blocked) { background: #f0f0ff; }
        .cal-day.blocked { background: #FEE2E2; color: #DC2626; font-weight: 700; }
        .cal-day.past { opacity: 0.35; cursor: default; }
      `}</style>

      <div style={{ fontFamily: F, maxWidth: 760 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, margin: 0 }}>Availability</h1>
          {lastSaved && <div style={{ fontSize: 12, color: '#aaa' }}>Last saved {lastSaved.toLocaleTimeString()}</div>}
        </div>

        {error && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#DC2626' }}>
            <strong>API Error:</strong> {error}
            <div style={{ fontSize: 11, marginTop: 4, color: '#9CA3AF' }}>
              The FM endpoint at <code>/api/restaurant/availability</code> may need configuration.
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#aaa', fontSize: 14 }}>Loading availability settings…</div>
        ) : (
          <>
            {/* Lead Time */}
            <SectionCard title="Lead Time">
              <p style={{ fontSize: 13, color: '#666', marginTop: 0, marginBottom: 14 }}>
                Minimum hours of advance notice required before an order can be placed.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <input
                  type="number"
                  className="avail-input"
                  value={leadHours}
                  onChange={e => setLeadHours(Number(e.target.value))}
                  min={0}
                  style={{ width: 100 }}
                />
                <span style={{ fontSize: 13, color: '#666' }}>hours</span>
              </div>
              <div style={{ marginTop: 18 }}>
                <SaveButton onClick={() => save('lead', { leadTimeHours: leadHours })} loading={saving === 'lead'} />
              </div>
            </SectionCard>

            {/* Order Cutoff */}
            <SectionCard title="Order Cutoff Time">
              <p style={{ fontSize: 13, color: '#666', marginTop: 0, marginBottom: 14 }}>
                The latest time customers can place orders for a given date.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <input
                  type="time"
                  className="avail-input"
                  value={cutoffTime}
                  onChange={e => setCutoffTime(e.target.value)}
                />
                <span style={{ fontSize: 13, color: '#666' }}>local time</span>
              </div>
              <div style={{ marginTop: 18 }}>
                <SaveButton onClick={() => save('cutoff', { cutoffTime })} loading={saving === 'cutoff'} />
              </div>
            </SectionCard>

            {/* Operating Hours */}
            <SectionCard title="Operating Hours">
              <p style={{ fontSize: 13, color: '#666', marginTop: 0, marginBottom: 16 }}>
                Set which days and hours you accept orders.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {DAYS.map((day, i) => (
                  <div key={day} style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ width: 100, fontWeight: 600, fontSize: 13, color: DARK }}>{day}</div>
                    <Toggle checked={opDays[i]} onChange={v => setOpDays(d => { const n = [...d]; n[i] = v; return n })} />
                    {opDays[i] ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="time" className="avail-input" value={opOpen[i]} onChange={e => setOpOpen(d => { const n = [...d]; n[i] = e.target.value; return n })} />
                        <span style={{ color: '#aaa', fontSize: 13 }}>to</span>
                        <input type="time" className="avail-input" value={opClose[i]} onChange={e => setOpClose(d => { const n = [...d]; n[i] = e.target.value; return n })} />
                      </div>
                    ) : (
                      <span style={{ fontSize: 12, color: '#aaa', fontStyle: 'italic' }}>Closed</span>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 20 }}>
                <SaveButton
                  onClick={() => save('hours', { operatingHours: DAYS.map((_, i) => ({ enabled: opDays[i], open: opOpen[i], close: opClose[i] })) })}
                  loading={saving === 'hours'}
                />
              </div>
            </SectionCard>

            {/* Blackout Dates */}
            <SectionCard title="Blackout Dates">
              <p style={{ fontSize: 13, color: '#666', marginTop: 0, marginBottom: 16 }}>
                Click dates to block them. Blocked dates are shown in red — customers cannot order on these days.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <button onClick={() => { if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1) } else setCalMonth(m => m - 1) }} style={{ background: '#f4f4f8', border: 'none', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontFamily: F, fontWeight: 700, color: '#555' }}>‹</button>
                <span style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{MONTH_NAMES[calMonth]} {calYear}</span>
                <button onClick={() => { if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1) } else setCalMonth(m => m + 1) }} style={{ background: '#f4f4f8', border: 'none', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontFamily: F, fontWeight: 700, color: '#555' }}>›</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 38px)', gap: 4, justifyContent: 'start' }}>
                {DAY_SHORT.map(d => <div key={d} style={{ width: 38, textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#aaa', paddingBottom: 6 }}>{d}</div>)}
                {calCells.map((day, i) => {
                  if (!day) return <div key={`e-${i}`} />
                  const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                  const blocked = blackoutDates.has(dateStr)
                  const isPast = new Date(dateStr) < new Date(new Date().toDateString())
                  return (
                    <div
                      key={dateStr}
                      className={`cal-day${blocked ? ' blocked' : ''}${isPast ? ' past' : ''}`}
                      onClick={() => !isPast && toggleDate(dateStr)}
                      title={blocked ? 'Blocked — click to unblock' : 'Available — click to block'}
                    >
                      {day}
                    </div>
                  )
                })}
              </div>
              <div style={{ marginTop: 18, display: 'flex', gap: 14, alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#888' }}>
                  <div style={{ width: 14, height: 14, borderRadius: 4, background: '#FEE2E2', border: '1px solid #FECACA' }} />
                  Blocked
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#888' }}>
                  <div style={{ width: 14, height: 14, borderRadius: 4, background: '#fff', border: '1px solid #e0e0e0' }} />
                  Available
                </div>
                <div style={{ marginLeft: 'auto' }}>
                  <SaveButton
                    onClick={() => save('blackout', { blackoutDates: Array.from(blackoutDates) })}
                    loading={saving === 'blackout'}
                    label="Update Blackout Dates"
                  />
                </div>
              </div>
            </SectionCard>

            {/* Order Minimum */}
            <SectionCard title="Order Minimum">
              <p style={{ fontSize: 13, color: '#666', marginTop: 0, marginBottom: 14 }}>
                Minimum dollar amount required per order.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: '#aaa' }}>$</span>
                <input
                  type="number"
                  className="avail-input"
                  value={orderMinimum}
                  onChange={e => setOrderMinimum(e.target.value)}
                  step="0.01"
                  min="0"
                  style={{ width: 120 }}
                />
              </div>
              <div style={{ marginTop: 18 }}>
                <SaveButton onClick={() => save('minimum', { orderMinimum: parseFloat(orderMinimum) || 0 })} loading={saving === 'minimum'} />
              </div>
            </SectionCard>
          </>
        )}
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.ok ? '#1D9E75' : '#E24B4A', color: '#fff', padding: '11px 22px', borderRadius: 10, fontSize: 13, fontWeight: 600, zIndex: 900, boxShadow: '0 6px 20px rgba(0,0,0,0.15)', whiteSpace: 'nowrap', fontFamily: F }}>
          {toast.msg}
        </div>
      )}
    </>
  )
}
