'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import SubscriptionSetupModal from '../components/SubscriptionSetupModal'
import RecurringOrderSetupModal, { type RecurringSourceOrder } from '../components/RecurringOrderSetupModal'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const GREEN = '#1D9E75'
const AMBER = '#BA7517'
const RED = '#E24B4A'
const FM_IMG_BASE = 'https://api.familymeal.com/public-api/images'

// FM /api/userOrderSubscription returns paginated subscription records.
// Each record represents ONE recurring order — the meal package the diner
// subscribed to (e.g. "Team Lunch Box every Monday"). Shape mirrors what
// pages/private/user/subscriptions/subscriptions.component.html binds to,
// with extra optional fields some FM deployments enrich onto the response.
interface SubAddOn { name?: string; count?: number; price?: number }
interface SubImage { reference?: string }

interface UserSubscription {
  orderSubscriptionReference: string
  reference?: string                          // some FM responses use `reference`
  restaurantReference: string
  restaurant?: {                              // enriched on some FM deployments
    businessName?: string
    businessNameWithoutSpaces?: string
    address?: { city?: string; state?: string }
  }
  restaurantName?: string
  restaurantCity?: string
  name?: string                               // meal package name — the subscribed item
  description?: string
  image?: SubImage
  price?: number                              // per occurrence
  totalAmount?: number                        // some FM responses include this
  serves?: string                             // "Serves 30-40" string
  orderSubscriptionStatus?: 'ACTIVE' | 'PAUSED' | 'CANCELED' | string
  nextOrderDate?: string                      // present on some FM deployments
  nextOrderTime?: string
  addOnsReferences?: SubAddOn[]               // template add-ons (names)
  orderAddOns?: SubAddOn[]                    // some responses use this name
  userOrderSubscriptionSchedule?: {
    userOrderFrequency?: {
      frequencyType?: string                  // WEEKLY | BIWEEKLY | MONTHLY | CUSTOM
      everyTime?: number                      // 1..4 → 1st / 2nd / 3rd / 4th
      repeatEveryDay?: string                 // MONDAY | TUESDAY | ...
    }
    skippedScheduleDays?: { available?: boolean; eventName?: string }[]
  }
  delivery?: boolean
  pickup?: boolean
}

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtMoney(n?: number) { return `$${(n || 0).toFixed(2)}` }
function fmtDate(s?: string) {
  if (!s) return ''
  try { return new Date(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) }
  catch { return s }
}
function fmtTime(t?: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  if (isNaN(h)) return t
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m || 0).padStart(2, '0')} ${ampm}`
}
function titleCase(s?: string) {
  return (s || '').toLowerCase().replace(/(^|[\s_])\w/g, c => c.toUpperCase()).replace(/_/g, ' ')
}

// Mirrors FM's initFrequencyText() in subscriptions.component.ts:
// WEEKLY  → "Weekly, every Monday"
// BIWEEKLY → "Bi-weekly, every Monday"
// MONTHLY (everyTime=2) → "Monthly, every 2nd Monday"
function frequencyLabel(s: UserSubscription): string {
  const f = s.userOrderSubscriptionSchedule?.userOrderFrequency
  if (!f?.frequencyType) return ''
  const t = f.frequencyType.toUpperCase()
  const day = f.repeatEveryDay ? titleCase(f.repeatEveryDay) : ''
  const ordinals: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' }
  if (t === 'WEEKLY')   return day ? `Weekly, every ${day}` : 'Weekly'
  if (t === 'BIWEEKLY') return day ? `Bi-weekly, every ${day}` : 'Bi-weekly'
  if (t === 'MONTHLY') {
    const ord = f.everyTime ? ordinals[f.everyTime] : ''
    return day ? `Monthly, every ${ord ? ord + ' ' : ''}${day}` : 'Monthly'
  }
  if (t === 'CUSTOM' && f.everyTime) return `Every ${f.everyTime} weeks${day ? `, ${day}` : ''}`
  return titleCase(t) + (day ? `, every ${day}` : '')
}

function statusStyle(status?: string) {
  const s = (status || '').toUpperCase()
  if (s === 'ACTIVE') return { bg: '#E1F5EE', fg: '#085041', label: 'Active', accent: INDIGO }
  if (s === 'PAUSED') return { bg: '#FAEEDA', fg: '#633806', label: 'Paused', accent: AMBER }
  if (s === 'CANCELED' || s === 'CANCELLED') return { bg: '#FFF0F0', fg: '#C62828', label: 'Canceled', accent: RED }
  return { bg: '#F3F4F6', fg: '#555', label: titleCase(s) || '—', accent: '#888' }
}

function deliveryText(s: UserSubscription): string | null {
  if (s.delivery && s.pickup) return 'Delivery · Pickup'
  if (s.delivery) return 'Delivery'
  if (s.pickup) return 'Pickup'
  return null
}

function subRef(s: UserSubscription): string {
  return s.orderSubscriptionReference || s.reference || ''
}

function imageUrl(s: UserSubscription): string | null {
  const ref = s.image?.reference
  return ref ? `${FM_IMG_BASE}/${ref}/download?size=150` : null
}

// ── Order history (Section 2 — recurring-order upsell) ──────────────────────

// Loose shape mirroring /api/fm-order-history rows — fields vary across FM
// deployments, so we read with fallbacks.
interface HistoryOrder {
  reference?: string
  id?: string
  restaurantName?: string
  restaurant?: { name?: string; businessName?: string }
  orderDate?: string
  createdAt?: string
  date?: string
  total?: number
  totalAmount?: number
  status?: string
  orderHeadcount?: number
  headcount?: number
  // FM order list sometimes embeds the line-items summary; fall back to a
  // short "N items" label when nothing's available.
  mealPackages?: { name?: string; quantity?: number; count?: number }[]
  orderMealPackages?: { name?: string; quantity?: number; count?: number }[]
  note?: string
}

function historyRef(o: HistoryOrder): string { return (o.reference || o.id || '') }
function historyRestName(o: HistoryOrder): string {
  return o.restaurantName || o.restaurant?.businessName || o.restaurant?.name || 'Order'
}
function historyDate(o: HistoryOrder): string {
  const raw = o.orderDate || o.createdAt || o.date
  if (!raw) return ''
  try { return new Date(raw).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
  catch { return raw }
}
function historyTotal(o: HistoryOrder): number {
  return typeof o.total === 'number' ? o.total : (o.totalAmount ?? 0)
}
function historyItemsSummary(o: HistoryOrder): string {
  const list = o.mealPackages || o.orderMealPackages || []
  if (list.length === 0) return ''
  // Show up to two names with a "+N more" tail.
  const names = list.map(p => p.name).filter(Boolean) as string[]
  if (names.length === 0) return `${list.length} item${list.length === 1 ? '' : 's'}`
  if (names.length <= 2) return names.join(' · ')
  return `${names.slice(0, 2).join(' · ')} +${names.length - 2} more`
}
function historyHeadcount(o: HistoryOrder): number | null {
  if (typeof o.orderHeadcount === 'number') return o.orderHeadcount
  if (typeof o.headcount === 'number') return o.headcount
  // Fall back to parsing "Headcount: N" we stamp into the note on checkout.
  const m = (o.note || '').match(/headcount[:\s]+(\d+)/i)
  return m ? parseInt(m[1], 10) : null
}

// ── Disco-managed recurring orders (GET /api/recurring-orders) ──────────────
// Rows come back snake_cased straight from Postgres, each with its generated
// occurrences attached.

interface DiscoOccurrence {
  id: string
  scheduled_date: string
  status: string
  cart_snapshot?: { name?: string; quantity?: number }[] | null
}
interface DiscoRecurringOrder {
  id: string
  restaurant_name: string
  restaurant_slug: string | null
  restaurant_reference: string
  frequency_type: string
  repeat_every_day: string
  start_date: string
  status: string
  occurrences?: DiscoOccurrence[]
}

function discoFreqLabel(o: DiscoRecurringOrder): string {
  const day = titleCase(o.repeat_every_day)
  const t = (o.frequency_type || '').toUpperCase()
  const word = t === 'WEEKLY' ? 'Weekly' : t === 'BIWEEKLY' ? 'Bi-weekly' : t === 'MONTHLY' ? 'Monthly' : titleCase(t)
  return day ? `${word} on ${day}s` : word
}

function discoNextDate(o: DiscoRecurringOrder): string | null {
  const today = new Date().toISOString().slice(0, 10)
  const occ = o.occurrences || []
  const upcoming = occ.find(x => x.status === 'SCHEDULED' && x.scheduled_date >= today)
    || occ.find(x => x.scheduled_date >= today)
    || occ[0]
  return upcoming?.scheduled_date || null
}

function discoItemsSummary(o: DiscoRecurringOrder): string {
  const snap = o.occurrences?.[0]?.cart_snapshot || []
  const names = snap.map(i => i.name).filter(Boolean) as string[]
  if (names.length === 0) return ''
  if (names.length <= 2) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

function discoFmtDate(s?: string | null): string {
  if (!s) return '—'
  try { return new Date(`${s}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) }
  catch { return s }
}

// ── Page ────────────────────────────────────────────────────────────────────

interface RepeatSeed {
  restaurantName: string
  sourceOrderRef: string
}

export default function SubscriptionsPage() {
  const router = useRouter()
  const [subs, setSubs] = useState<UserSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  // Section 2: recent order history for the recurring-order upsell.
  const [history, setHistory] = useState<HistoryOrder[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [repeatSeed, setRepeatSeed] = useState<RepeatSeed | null>(null)

  // Disco-managed recurring orders (top section).
  const [discoOrders, setDiscoOrders] = useState<DiscoRecurringOrder[]>([])
  const [discoLoading, setDiscoLoading] = useState(true)
  const [discoBusy, setDiscoBusy] = useState<string | null>(null)

  // "From order history" picker → Disco setup modal.
  const [showHistoryPicker, setShowHistoryPicker] = useState(false)
  const [discoSeed, setDiscoSeed] = useState<RecurringSourceOrder | null>(null)
  const [seedLoading, setSeedLoading] = useState<string | null>(null)

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

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await fetch('/api/fm-order-history?page=0&size=10', { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      const list: HistoryOrder[] = d.content || d.orders || d.data || (Array.isArray(d) ? d : [])
      setHistory(list.slice(0, 10))
    } catch {
      setHistory([])
    }
    setHistoryLoading(false)
  }, [])

  const loadDisco = useCallback(async () => {
    setDiscoLoading(true)
    try {
      const res = await fetch('/api/recurring-orders', { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setDiscoOrders(d.recurringOrders || [])
    } catch {
      setDiscoOrders([])
    }
    setDiscoLoading(false)
  }, [])

  useEffect(() => { load(); loadHistory(); loadDisco() }, [load, loadHistory, loadDisco])

  async function changeDiscoStatus(o: DiscoRecurringOrder, next: 'ACTIVE' | 'PAUSED' | 'CANCELED') {
    setDiscoBusy(o.id)
    try {
      const res = await fetch(`/api/recurring-orders/${o.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setDiscoOrders(prev => prev.map(x => x.id === o.id ? { ...x, status: next } : x))
    } catch {
      alert('Could not update recurring order. Please try again.')
    }
    setDiscoBusy(null)
  }

  // Open the Disco setup modal seeded from a past order. Pulls the full order
  // detail so we have the restaurant reference, items, and total the API needs.
  async function repeatFromHistory(o: HistoryOrder) {
    const ref = historyRef(o)
    if (!ref) return
    setSeedLoading(ref)
    try {
      const res = await fetch(`/api/fm-order-detail/${ref}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      const slug = d.restaurant?.businessNameWithoutSpaces || ''
      setDiscoSeed({
        orderReference: ref,
        restaurantName: d.restaurant?.businessName || historyRestName(o),
        restaurantSlug: slug,
        restaurantReference: slug,
        items: (d.orderMealPackages || []).map((p: { name?: string; count?: number; price?: number }) => ({
          name: p.name || 'Item',
          quantity: p.count || 1,
          price: p.price,
        })),
        total: typeof d.total === 'number' ? d.total : historyTotal(o),
      })
    } catch {
      alert('Could not load that order. Please try again.')
    }
    setSeedLoading(null)
  }

  async function changeStatus(sub: UserSubscription, next: 'ACTIVE' | 'PAUSED' | 'CANCELED') {
    const ref = subRef(sub)
    setBusy(ref)
    const url = `/api/fm-subscriptions/${ref}/status?status=${next}&restaurantReference=${sub.restaurantReference}`
    const res = await fetch(url, { method: 'PUT', credentials: 'include' })
    setBusy(null)
    if (res.ok) {
      setSubs(prev => prev.map(s => subRef(s) === ref ? { ...s, orderSubscriptionStatus: next } : s))
    } else {
      alert('Could not update subscription. Please try again.')
    }
  }

  async function archive(sub: UserSubscription) {
    if (!confirm('Remove this subscription from your list? You can still see past orders in History.')) return
    const ref = subRef(sub)
    setBusy(ref)
    const res = await fetch(`/api/fm-subscriptions/${ref}/hidden`, { method: 'PUT', credentials: 'include' })
    setBusy(null)
    if (res.ok) {
      setSubs(prev => prev.filter(s => subRef(s) !== ref))
    }
  }

  return (
    <div style={{ fontFamily: F }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: 0 }}>Subscriptions</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setShowHistoryPicker(v => !v)}
            style={{ background: '#fff', color: BLUE, border: `1.5px solid ${BLUE}`, borderRadius: 999, padding: '8px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
            📋 From order history
          </button>
          <button onClick={() => router.push('/fullmap')}
            style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 999, padding: '8px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
            + New subscription
          </button>
        </div>
      </div>

      {/* "From order history" picker — opens the Disco-managed setup modal */}
      {showHistoryPicker && (
        <div style={{ border: `1.5px solid ${BLUE}`, borderRadius: 12, background: 'rgba(91,111,232,0.04)', padding: 14, marginBottom: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: DARK, marginBottom: 4 }}>Repeat a past order with Disco Cater</div>
          <div style={{ fontSize: 12, color: '#777', marginBottom: 12 }}>Pick one of your recent orders to set up as a Disco-managed recurring order.</div>
          {historyLoading ? (
            <div style={{ color: '#aaa', fontSize: 13 }}>Loading recent orders…</div>
          ) : history.length === 0 ? (
            <div style={{ fontSize: 13, color: '#888' }}>No past orders yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {history.slice(0, 5).map((o, i) => {
                const ref = historyRef(o)
                return (
                  <div key={ref || i} style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: '1px solid #ebebeb', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: DARK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{historyRestName(o)}</div>
                      <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{historyDate(o)} · {fmtMoney(historyTotal(o))}</div>
                    </div>
                    <button onClick={() => repeatFromHistory(o)} disabled={!ref || seedLoading === ref}
                      style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 999, padding: '8px 14px', fontSize: 12, fontWeight: 700, cursor: ref ? 'pointer' : 'not-allowed', fontFamily: F, whiteSpace: 'nowrap', flexShrink: 0, opacity: (!ref || seedLoading === ref) ? 0.6 : 1 }}>
                      {seedLoading === ref ? 'Loading…' : 'Repeat this →'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {/* SECTION 0 — Disco Cater Recurring Orders */}
      <section style={{ marginBottom: 36 }}>
        <SectionHeader title="🪩 Disco Cater Recurring Orders" subtitle="Managed by Disco Cater — auto-charged before each order. Pause, resume, or cancel anytime." />

        {discoLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[0, 1].map(i => (
              <div key={i} style={{ border: '1px solid #ebebeb', borderRadius: 12, background: '#fff', padding: 16, height: 96 }}>
                <div style={{ width: '40%', height: 14, borderRadius: 6, background: '#f0f0f0', marginBottom: 10 }} />
                <div style={{ width: '60%', height: 11, borderRadius: 6, background: '#f4f4f4', marginBottom: 8 }} />
                <div style={{ width: '30%', height: 11, borderRadius: 6, background: '#f4f4f4' }} />
              </div>
            ))}
          </div>
        ) : discoOrders.length === 0 ? (
          <div style={{ border: '1px dashed #d8d8e4', borderRadius: 12, padding: '40px 24px', textAlign: 'center', background: 'rgba(107,110,249,0.03)' }}>
            <div style={{ fontSize: 14, color: '#888', lineHeight: 1.5 }}>
              No Disco Cater recurring orders yet. Set one up from your order history.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {discoOrders.map(o => (
              <DiscoRecurringCard
                key={o.id}
                order={o}
                busy={discoBusy === o.id}
                onPause={() => changeDiscoStatus(o, 'PAUSED')}
                onResume={() => changeDiscoStatus(o, 'ACTIVE')}
                onCancel={() => { if (confirm('Cancel this recurring order? All upcoming orders will be canceled.')) changeDiscoStatus(o, 'CANCELED') }}
              />
            ))}
          </div>
        )}
      </section>

      {/* SECTION 1 — Your Recurring Orders */}
      <section style={{ marginBottom: 36 }}>
        <SectionHeader title="Your Recurring Orders" subtitle="Pause, resume, or cancel anytime." />

        {loading ? (
          <div style={{ color: '#aaa', fontSize: 13 }}>Loading subscriptions…</div>
        ) : subs.length === 0 ? (
          <div style={{ border: '1px dashed #d8d8e4', borderRadius: 12, padding: '64px 24px', textAlign: 'center', background: 'rgba(107,110,249,0.03)' }}>
            <div style={{ fontSize: 48, marginBottom: 16, lineHeight: 1 }}>🔄</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: DARK, marginBottom: 8 }}>No active subscriptions</div>
            <div style={{ fontSize: 14, color: '#888', lineHeight: 1.5, maxWidth: 340, margin: '0 auto 22px' }}>
              Set up a recurring catering order and manage it here.
            </div>
            <button onClick={() => router.push('/fullmap')}
              style={{ display: 'inline-block', padding: '11px 24px', background: BLUE, color: '#fff', border: 'none', borderRadius: 999, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
              Browse restaurants
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {subs.map(sub => (
              <SubscriptionCard
                key={subRef(sub)}
                sub={sub}
                busy={busy === subRef(sub)}
                onPause={() => changeStatus(sub, 'PAUSED')}
                onResume={() => changeStatus(sub, 'ACTIVE')}
                onCancel={() => changeStatus(sub, 'CANCELED')}
                onArchive={() => archive(sub)}
              />
            ))}
          </div>
        )}
      </section>

      {/* SECTION 2 — Order History (recurring-order upsell) */}
      <section>
        <SectionHeader
          title="Order History — Make it recurring"
          subtitle="Turn a past order into a recurring delivery. Set it once, skip or cancel anytime."
        />

        {historyLoading ? (
          <div style={{ color: '#aaa', fontSize: 13 }}>Loading recent orders…</div>
        ) : history.length === 0 ? (
          <div style={{ border: '1px solid #ebebeb', borderRadius: 12, padding: '28px 24px', textAlign: 'center', background: '#fff' }}>
            <div style={{ fontSize: 13, color: '#888' }}>No past orders to repeat yet — once you order, you can make any of them recurring from here.</div>
          </div>
        ) : (
          <div style={{ border: '1px solid #ebebeb', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
            {history.map((o, i) => {
              const ref = historyRef(o)
              const restName = historyRestName(o)
              const items = historyItemsSummary(o)
              const head = historyHeadcount(o)
              return (
                <div key={ref || i}
                  style={{ display: 'flex', alignItems: 'center', padding: '14px 16px', gap: 14,
                    borderBottom: i < history.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: DARK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {restName}
                    </div>
                    {items && (
                      <div style={{ fontSize: 12, color: '#555', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {items}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: '#888', marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <span>{historyDate(o)}</span>
                      <span>·</span>
                      <span>{fmtMoney(historyTotal(o))}</span>
                      {head != null && <><span>·</span><span>Headcount {head}</span></>}
                    </div>
                  </div>
                  <button
                    onClick={() => ref && setRepeatSeed({ restaurantName: restName, sourceOrderRef: ref })}
                    disabled={!ref}
                    style={{
                      background: INDIGO, color: '#fff', border: 'none', borderRadius: 8,
                      padding: '8px 14px', fontSize: 12, fontWeight: 700, cursor: ref ? 'pointer' : 'not-allowed',
                      fontFamily: F, whiteSpace: 'nowrap', flexShrink: 0,
                      opacity: ref ? 1 : 0.5,
                    }}
                  >
                    🔄 Repeat this order
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Subscription setup wizard — pre-seeded from the picked history row. */}
      {repeatSeed && (
        <SubscriptionSetupModal
          restaurantName={repeatSeed.restaurantName}
          sourceOrderRef={repeatSeed.sourceOrderRef}
          onClose={() => setRepeatSeed(null)}
        />
      )}

      {/* Disco-managed recurring order setup (from the "From order history" picker) */}
      {discoSeed && (
        <RecurringOrderSetupModal
          isOpen
          sourceOrder={discoSeed}
          onClose={() => { setDiscoSeed(null); setShowHistoryPicker(false); loadDisco() }}
        />
      )}
    </div>
  )
}

// ── Disco recurring-order card ──────────────────────────────────────────────

function DiscoRecurringCard({ order, busy, onPause, onResume, onCancel }: {
  order: DiscoRecurringOrder
  busy: boolean
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}) {
  const st = statusStyle(order.status)
  const status = (order.status || '').toUpperCase()
  const isPaused = status === 'PAUSED'
  const isCanceled = status.startsWith('CANCEL')
  const items = discoItemsSummary(order)
  const next = discoNextDate(order)

  return (
    <div style={{ border: '1px solid #ebebeb', borderLeft: `3px solid ${st.accent}`, borderRadius: 12, background: '#fff', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{order.restaurant_name}</span>
            <span style={{ background: st.bg, color: st.fg, padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>{st.label}</span>
          </div>
          <div style={{ fontSize: 11, color: st.accent, fontWeight: 600, marginTop: 4 }}>{discoFreqLabel(order)}</div>
          {!isCanceled && next && (
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
              Next order: <strong style={{ color: DARK }}>{discoFmtDate(next)}</strong>
            </div>
          )}
          {items && <div style={{ fontSize: 12, color: '#444', marginTop: 4 }}>{items}</div>}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
        {!isCanceled && (
          <>
            {isPaused ? (
              <button onClick={onResume} disabled={busy} style={miniBtn(GREEN, '#fff')}>Resume</button>
            ) : (
              <button onClick={onPause} disabled={busy} style={miniBtn('#fff', DARK, '#e0e0e0')}>Pause</button>
            )}
            <button onClick={onCancel} disabled={busy} style={miniBtn('#fff', RED, '#F0BFBE')}>Cancel</button>
          </>
        )}
        {isCanceled && <span style={{ fontSize: 11, color: '#999' }}>This recurring order has been canceled.</span>}
      </div>
    </div>
  )
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h2 style={{ fontSize: 14, fontWeight: 700, color: DARK, margin: 0, letterSpacing: '-0.005em' }}>{title}</h2>
      <p style={{ fontSize: 12, color: '#777', margin: '4px 0 0', lineHeight: 1.5 }}>{subtitle}</p>
    </div>
  )
}

// ── Card ────────────────────────────────────────────────────────────────────

function SubscriptionCard({ sub, busy, onPause, onResume, onCancel, onArchive }: {
  sub: UserSubscription
  busy: boolean
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onArchive: () => void
}) {
  const st = statusStyle(sub.orderSubscriptionStatus)
  const isPaused = (sub.orderSubscriptionStatus || '').toUpperCase() === 'PAUSED'
  const isCanceled = (sub.orderSubscriptionStatus || '').toUpperCase().startsWith('CANCEL')
  const restName = sub.restaurant?.businessName || sub.restaurantName
  const restLoc = sub.restaurant?.address?.city || sub.restaurantCity
  const itemName = sub.name || 'Recurring order'
  const addOns: SubAddOn[] = sub.addOnsReferences || sub.orderAddOns || []
  const itemsLine = [itemName, ...addOns.map(a => a.name).filter(Boolean)].filter(Boolean).join(' · ')
  const freq = frequencyLabel(sub)
  const total = typeof sub.totalAmount === 'number' ? sub.totalAmount : sub.price
  const delivery = deliveryText(sub)
  const skippedDates = (sub.userOrderSubscriptionSchedule?.skippedScheduleDays || [])
    .filter(d => d.available)
    .map(d => d.eventName)
    .filter(Boolean) as string[]
  const img = imageUrl(sub)

  return (
    <div style={{
      border: '1px solid #ebebeb', borderLeft: `3px solid ${st.accent}`,
      borderRadius: 12, background: '#fff', padding: 14, display: 'flex',
      gap: 14, alignItems: 'flex-start',
    }}>
      {/* Thumbnail */}
      <div style={{
        width: 56, height: 56, borderRadius: 10, flexShrink: 0,
        background: img ? `center/cover no-repeat url(${img})` : '#1A1028',
        color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22, fontWeight: 700, fontFamily: "'DM Sans', sans-serif",
      }}>
        {!img && (restName?.[0] || '·').toUpperCase()}
      </div>

      {/* Main */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: DARK }}>
            {restName ? `${restName}${restLoc ? ` — ${restLoc}` : ''}` : itemName}
          </span>
          <span style={{ background: st.bg, color: st.fg, padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>
            {st.label}
          </span>
        </div>

        {/* Items line */}
        {restName && (
          <div style={{ fontSize: 12, color: '#444', marginTop: 2 }}>{itemsLine}</div>
        )}

        {/* Meta line: serves + delivery type */}
        {(sub.serves || delivery) && (
          <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
            {sub.serves || ''}
            {sub.serves && delivery ? ' · ' : ''}
            {delivery || ''}
          </div>
        )}

        {/* Frequency */}
        {freq && (
          <div style={{ fontSize: 11, color: st.accent, fontWeight: 600, marginTop: 4 }}>{freq}</div>
        )}

        {/* Next order date */}
        {sub.nextOrderDate && (
          <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
            Next order: <strong style={{ color: DARK }}>{fmtDate(sub.nextOrderDate)}</strong>
            {sub.nextOrderTime ? ` at ${fmtTime(sub.nextOrderTime)}` : ''}
          </div>
        )}

        {/* Skipped dates */}
        {skippedDates.length > 0 && (
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
            Skipping: {skippedDates.join(', ')}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
          {!isCanceled && (
            <>
              {isPaused ? (
                <button onClick={onResume} disabled={busy} style={miniBtn(GREEN, '#fff')}>Resume</button>
              ) : (
                <button onClick={onPause} disabled={busy} style={miniBtn('#fff', DARK, '#e0e0e0')}>Pause</button>
              )}
              <button onClick={onCancel} disabled={busy} style={miniBtn('#fff', RED, '#F0BFBE')}>Cancel</button>
            </>
          )}
          {isCanceled && (
            <button onClick={onArchive} disabled={busy} style={miniBtn('#fff', '#555', '#e0e0e0')}>
              Remove from list
            </button>
          )}
        </div>
      </div>

      {/* Right rail — price */}
      <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 6 }}>
        {total !== undefined && (
          <>
            <div style={{ fontSize: 16, fontWeight: 700, color: DARK }}>{fmtMoney(total)}</div>
            <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>per occurrence</div>
          </>
        )}
      </div>
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
