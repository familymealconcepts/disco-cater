'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import SubscriptionSetupModal from '../components/SubscriptionSetupModal'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const GREEN = '#1D9E75'
const AMBER = '#BA7517'
const RED = '#E24B4A'

// FM /api/userOrderSubscription returns these fields per
// user-subscriptions.service.ts. Shape verified against FM source.
interface UserSubscription {
  orderSubscriptionReference: string
  restaurantReference: string
  restaurantName?: string
  name?: string
  description?: string
  price?: number
  serves?: string
  orderSubscriptionStatus?: 'ACTIVE' | 'PAUSED' | 'CANCELED' | string
  userOrderSubscriptionSchedule?: {
    userOrderFrequency?: {
      frequencyType?: string  // WEEKLY | BIWEEKLY | MONTHLY | CUSTOM
      everyTime?: number
      repeatEveryDay?: string // MONDAY | TUESDAY | ...
    }
    skippedScheduleDays?: { available?: boolean; eventName?: string }[]
  }
  nextOrderDate?: string
  delivery?: boolean
  pickup?: boolean
}

function fmtMoney(n?: number) { return `$${(n || 0).toFixed(2)}` }
function fmtDate(s?: string) {
  if (!s) return ''
  try { return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
  catch { return s }
}
function titleCase(s?: string) { return (s || '').toLowerCase().replace(/(^|[\s_])\w/g, c => c.toUpperCase()).replace(/_/g, ' ') }

function frequencyLabel(s: UserSubscription): string {
  const f = s.userOrderSubscriptionSchedule?.userOrderFrequency
  if (!f) return ''
  const day = f.repeatEveryDay ? `, every ${titleCase(f.repeatEveryDay)}` : ''
  const t = (f.frequencyType || '').toUpperCase()
  if (t === 'WEEKLY') return `Weekly${day}`
  if (t === 'BIWEEKLY') return `Bi-weekly${day}`
  if (t === 'MONTHLY') return `Monthly${day}`
  if (t === 'CUSTOM' && f.everyTime) return `Every ${f.everyTime} weeks${day}`
  return titleCase(t) + day
}

function statusStyle(status?: string) {
  const s = (status || '').toUpperCase()
  if (s === 'ACTIVE') return { bg: '#E1F5EE', fg: '#085041', label: 'Active' }
  if (s === 'PAUSED') return { bg: '#FAEEDA', fg: '#633806', label: 'Paused' }
  if (s === 'CANCELED' || s === 'CANCELLED') return { bg: '#FFF0F0', fg: '#C62828', label: 'Canceled' }
  return { bg: '#F3F4F6', fg: '#555', label: titleCase(s) || '—' }
}

export default function SubscriptionsPage() {
  const [subs, setSubs] = useState<UserSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/fm-subscriptions?page=0&size=50', { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      const list: UserSubscription[] = d.content || d.data || (Array.isArray(d) ? d : [])
      setSubs(list)
    } catch {
      setError('Could not load subscriptions')
      setSubs([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function changeStatus(sub: UserSubscription, next: 'ACTIVE' | 'PAUSED' | 'CANCELED') {
    setBusy(sub.orderSubscriptionReference)
    const url = `/api/fm-subscriptions/${sub.orderSubscriptionReference}/status`
      + `?status=${next}&restaurantReference=${sub.restaurantReference}`
    const res = await fetch(url, { method: 'PUT', credentials: 'include' })
    setBusy(null)
    if (res.ok) {
      setSubs(prev => prev.map(s => s.orderSubscriptionReference === sub.orderSubscriptionReference
        ? { ...s, orderSubscriptionStatus: next } : s))
    } else {
      alert('Could not update subscription. Please try again.')
    }
  }

  async function archive(sub: UserSubscription) {
    if (!confirm('Remove this subscription from your list? You can still see past orders in History.')) return
    setBusy(sub.orderSubscriptionReference)
    const res = await fetch(`/api/fm-subscriptions/${sub.orderSubscriptionReference}/hidden`, {
      method: 'PUT', credentials: 'include',
    })
    setBusy(null)
    if (res.ok) {
      setSubs(prev => prev.filter(s => s.orderSubscriptionReference !== sub.orderSubscriptionReference))
    }
  }

  const visibleSubs = subs

  return (
    <div style={{ fontFamily: F }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: 0 }}>Subscriptions</h1>
        <button onClick={() => setSetupOpen(true)} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
          + New subscription
        </button>
      </div>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {loading ? (
        <div style={{ color: '#aaa', fontSize: 13 }}>Loading subscriptions…</div>
      ) : visibleSubs.length === 0 ? (
        <div style={{ border: '1px solid #ebebeb', borderRadius: 12, padding: '40px 24px', textAlign: 'center', background: '#fff' }}>
          <div style={{ fontSize: 36, marginBottom: 14 }}>🔄</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 6 }}>No active subscriptions</div>
          <div style={{ fontSize: 13, color: '#aaa', marginBottom: 18 }}>Set up a recurring order to make catering effortless.</div>
          <button onClick={() => setSetupOpen(true)} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 22px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
            + Start a subscription
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {visibleSubs.map(sub => {
            const st = statusStyle(sub.orderSubscriptionStatus)
            const accent = st.label === 'Paused' ? AMBER : st.label === 'Canceled' ? RED : INDIGO
            const freq = frequencyLabel(sub)
            const isPaused = (sub.orderSubscriptionStatus || '').toUpperCase() === 'PAUSED'
            const isCanceled = (sub.orderSubscriptionStatus || '').toUpperCase().startsWith('CANCEL')
            return (
              <div key={sub.orderSubscriptionReference}
                style={{ border: '1px solid #ebebeb', borderLeft: `3px solid ${accent}`, borderRadius: 12, padding: 16, background: '#fff', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ width: 38, height: 38, borderRadius: 8, background: '#EEEDFE', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>🍽️</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{sub.restaurantName || sub.name || 'Subscription'}</span>
                    <span style={{ background: st.bg, color: st.fg, padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700 }}>{st.label}</span>
                  </div>
                  {sub.name && sub.restaurantName && (
                    <div style={{ fontSize: 12, color: '#666' }}>{sub.name}</div>
                  )}
                  {freq && <div style={{ fontSize: 11, color: accent, fontWeight: 600, marginTop: 3 }}>{freq}</div>}
                  {sub.nextOrderDate && (
                    <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                      Next order: <strong style={{ color: DARK }}>{fmtDate(sub.nextOrderDate)}</strong>
                    </div>
                  )}
                  {sub.userOrderSubscriptionSchedule?.skippedScheduleDays?.some(d => d.available) && (
                    <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                      Skipping: {sub.userOrderSubscriptionSchedule.skippedScheduleDays.filter(d => d.available).map(d => d.eventName).filter(Boolean).join(', ')}
                    </div>
                  )}

                  {/* Actions */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                    {!isCanceled && (
                      <>
                        {isPaused ? (
                          <button onClick={() => changeStatus(sub, 'ACTIVE')} disabled={busy === sub.orderSubscriptionReference}
                            style={miniBtn(GREEN, '#fff')}>Resume</button>
                        ) : (
                          <button onClick={() => changeStatus(sub, 'PAUSED')} disabled={busy === sub.orderSubscriptionReference}
                            style={miniBtn('#fff', DARK, '#e0e0e0')}>Pause</button>
                        )}
                        <button onClick={() => changeStatus(sub, 'CANCELED')} disabled={busy === sub.orderSubscriptionReference}
                          style={miniBtn('#fff', RED, '#F0BFBE')}>Cancel</button>
                      </>
                    )}
                    {isCanceled && (
                      <button onClick={() => archive(sub)} disabled={busy === sub.orderSubscriptionReference}
                        style={miniBtn('#fff', '#555', '#e0e0e0')}>Remove from list</button>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  {sub.price !== undefined && (
                    <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{fmtMoney(sub.price)}</div>
                  )}
                  {sub.serves && (
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{sub.serves}</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!loading && visibleSubs.length > 0 && (
        <div style={{ marginTop: 18, fontSize: 12, color: '#888', textAlign: 'center' }}>
          Add another subscription with <Link href="/fullmap" style={{ color: BLUE, fontWeight: 600 }}>+ Browse restaurants</Link>.
        </div>
      )}

      {setupOpen && <SubscriptionSetupModal onClose={() => setSetupOpen(false)} />}
    </div>
  )
}

function miniBtn(bg: string, fg: string, border?: string): React.CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600,
    background: bg, color: fg, border: border ? `1px solid ${border}` : 'none',
    cursor: 'pointer', fontFamily: F,
  }
}
