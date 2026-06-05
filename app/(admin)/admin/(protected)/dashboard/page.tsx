'use client'
import { useState, useEffect, useCallback } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'
const BLUE = '#5B6FE8'
const PAGE_BG = '#F7F8FC'

// ── Date range presets ────────────────────────────────────────────────────────
type Preset = 'this_month' | 'last_month' | 'ytd' | 'last_7' | 'last_30' | 'custom'

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'ytd', label: 'YTD' },
  { key: 'last_7', label: 'Last 7 Days' },
  { key: 'last_30', label: 'Last 30 Days' },
  { key: 'custom', label: 'Custom Range' },
]

// FM's dashboard sale/stats + orders endpoints filter by DD.MM.YYYY.
function fmtFm(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}
// DD.MM.YYYY → YYYY-MM-DD (for <input type="date">), and back.
function fmToIso(fm: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(fm)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : ''
}
function isoToFm(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ''
}

// Returns { from, to } as DD.MM.YYYY for a preset, or null for 'custom'.
function computeRange(preset: Preset): { from: string; to: string } | null {
  const now = new Date()
  const today = fmtFm(now)
  if (preset === 'this_month') return { from: fmtFm(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
  if (preset === 'last_month') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const last = new Date(now.getFullYear(), now.getMonth(), 0) // day 0 = last day of prev month
    return { from: fmtFm(first), to: fmtFm(last) }
  }
  if (preset === 'ytd') return { from: fmtFm(new Date(now.getFullYear(), 0, 1)), to: today }
  if (preset === 'last_7') { const d = new Date(); d.setDate(d.getDate() - 6); return { from: fmtFm(d), to: today } }
  if (preset === 'last_30') { const d = new Date(); d.setDate(d.getDate() - 29); return { from: fmtFm(d), to: today } }
  return null // custom
}

// Inclusive list of YYYY-MM-DD between two ISO dates (capped for safety).
function enumerateDays(fromIso: string, toIso: string): string[] {
  const [fy, fm, fd] = fromIso.split('-').map(Number)
  const [ty, tm, td] = toIso.split('-').map(Number)
  if (!fy || !ty) return []
  const cur = new Date(fy, fm - 1, fd)
  const end = new Date(ty, tm - 1, td)
  const out: string[] = []
  let guard = 0
  while (cur <= end && guard < 400) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`)
    cur.setDate(cur.getDate() + 1); guard++
  }
  return out
}
// "Jun 1" — parse as local date so the day doesn't shift.
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// FM /api/admin/dashboard/statistics fields used in template
interface AdminStats {
  totalRestaurantsCount?: number
  totalOrdersCount?: number
  totalVisitors?: number
  avgOrdersPerDayCount?: number
}

// FM /api/admin/dashboard/sale/statistics raw response — we map below
interface AdminSaleStatsRaw {
  totalCustomersCount?: number
  totalOrdersAvgSum?: number
  totalOrdersCount?: number
  totalOrdersSum?: number
  feeSum?: number
  stripeFeeSum?: number
  subtotalOrdersSum?: number
  localSalesTaxInPriceSum?: number
  otherSalesTaxInPriceSum?: number
  stateSalesTaxInPriceSum?: number
  tipsInPrice?: number
  ownDeliveryPriceSum?: number
  doordashTipsOrdersSum?: number
  thirdPartyTipsOrdersSum?: number
  doordashDeliveryFeeSum?: number
  thirdPartyDeliveryFeeSum?: number
  refundSum?: number
  serviceChargesSum?: number
  leadgenonediscofee?: number
  leadgentwodiscofee?: number
  // Platform-fee candidates — FM's exact key is unconfirmed; read defensively.
  // (Inspect the [Dashboard] FM analytics raw response server log to pin it.)
  platformFeesSum?: number
  platformFeeSum?: number
  platformFees?: number
  platformFee?: number
  discoFeeSum?: number
  discoFee?: number
  serviceFee?: number
  [key: string]: number | undefined
}

interface LocationOption { reference: string; businessName: string }

function fmtCurrency(n?: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0)
}
function fmtNumber(n?: number) {
  return new Intl.NumberFormat('en-US').format(n || 0)
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats>({})
  const [saleRaw, setSaleRaw] = useState<AdminSaleStatsRaw>({})
  const [restaurants, setRestaurants] = useState<LocationOption[]>([])
  const [restaurantRef, setRestaurantRef] = useState<string>('')  // '' = All restaurants
  // Date range driven by presets; default to the current month. fromDate/toDate
  // are DD.MM.YYYY (what FM's sale/stats + orders endpoints expect).
  const initRange = computeRange('this_month')!
  const [preset, setPreset] = useState<Preset>('this_month')
  const [fromDate, setFromDate] = useState(initRange.from)
  const [toDate, setToDate] = useState(initRange.to)
  const [loading, setLoading] = useState(true)
  const [showRestaurantPicker, setShowRestaurantPicker] = useState(false)

  // Order-volume chart
  const [volume, setVolume] = useState<{ date: string; orders: number }[]>([])
  const [volumeLoading, setVolumeLoading] = useState(true)
  const [volumeTruncated, setVolumeTruncated] = useState(false)

  // Initial stats (no filters) + restaurant list
  useEffect(() => {
    Promise.all([
      fetch('/api/admin/dashboard/stats').then(r => r.ok ? r.json() : null),
      fetch('/api/admin/restaurants-list').then(r => r.ok ? r.json() : null),
    ]).then(([statsRes, listRes]) => {
      if (statsRes) setStats(statsRes)
      if (Array.isArray(listRes)) {
        setRestaurants(listRes.map((r: { reference: string; businessName: string }) => ({
          reference: r.reference, businessName: r.businessName,
        })))
      } else if (listRes?.content) {
        setRestaurants(listRes.content)
      }
    }).catch(() => {})
  }, [])

  // Sale stats — fire on mount and whenever filters change
  const loadSaleStats = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    // FM only fires loadSaleStats when (fromDate && toDate) or restaurantRef alone
    // We always call to get the unfiltered baseline on mount.
    if (fromDate) params.set('fromDate', fromDate)
    if (toDate) params.set('toDate', toDate)
    if (restaurantRef) params.set('restaurantReference', restaurantRef)
    const res = await fetch(`/api/admin/dashboard/sale-stats?${params}`)
    if (res.ok) setSaleRaw(await res.json())
    setLoading(false)
  }, [fromDate, toDate, restaurantRef])

  useEffect(() => { loadSaleStats() }, [loadSaleStats])

  // Order-volume chart — aggregate daily order counts over the selected range.
  // /api/admin/orders forwards fromDate/toDate (DD.MM.YYYY passes through). We
  // page up to a cap to avoid a slow full crawl; if hit, the chart is marked
  // partial. (The orders proxy isn't restaurant-scoped, so this is platform-wide.)
  const loadOrderVolume = useCallback(async () => {
    if (!fromDate || !toDate) return
    setVolumeLoading(true)
    setVolumeTruncated(false)
    const SIZE = 200
    const MAX_PAGES = 10 // cap → up to 2000 orders in range
    try {
      const all: { orderDate?: string }[] = []
      let page = 0
      let totalPages = 1
      let truncated = false
      do {
        const p = new URLSearchParams({ page: String(page), size: String(SIZE), fromDate, toDate })
        const res = await fetch(`/api/admin/orders?${p}`)
        if (!res.ok) break
        const d = await res.json()
        const content: { orderDate?: string }[] = Array.isArray(d?.content) ? d.content : (Array.isArray(d) ? d : [])
        all.push(...content)
        totalPages = typeof d?.totalPages === 'number' ? d.totalPages : Math.ceil((d?.totalElements || content.length) / SIZE)
        page++
        if (page >= MAX_PAGES && page < totalPages) { truncated = true; break }
      } while (page < totalPages)

      const byDay: Record<string, number> = {}
      for (const o of all) {
        const iso = (o.orderDate || '').slice(0, 10)
        if (iso) byDay[iso] = (byDay[iso] || 0) + 1
      }
      setVolume(enumerateDays(fmToIso(fromDate), fmToIso(toDate)).map(iso => ({ date: dayLabel(iso), orders: byDay[iso] || 0 })))
      setVolumeTruncated(truncated)
    } catch {
      setVolume([])
    } finally {
      setVolumeLoading(false)
    }
  }, [fromDate, toDate])

  useEffect(() => { loadOrderVolume() }, [loadOrderVolume])

  // Apply a preset: compute its range (re-fetches via the effects above). For
  // 'custom', leave the dates as-is and reveal the pickers.
  function selectPreset(p: Preset) {
    setPreset(p)
    if (p === 'custom') return
    const r = computeRange(p)
    if (r) { setFromDate(r.from); setToDate(r.to) }
  }

  // Derived sale-stats fields (mirror FM's loadSaleStats mapping in
  // admin-dashboard.component.ts lines 95-117)
  const taxAmount =
    (saleRaw.localSalesTaxInPriceSum || 0) +
    (saleRaw.otherSalesTaxInPriceSum || 0) +
    (saleRaw.stateSalesTaxInPriceSum || 0)

  // FM template uses (thirdPartyTips || doordashTips) — same for delivery
  const dpTips = saleRaw.thirdPartyTipsOrdersSum ?? saleRaw.doordashTipsOrdersSum
  const dpDelivery = saleRaw.thirdPartyDeliveryFeeSum ?? saleRaw.doordashDeliveryFeeSum
  // Title flips based on which one is set (matches FM convention)
  const dpKind = (saleRaw.thirdPartyDeliveryFeeSum ?? 0) > 0
    ? 'Third-Party'
    : (saleRaw.doordashDeliveryFeeSum ?? 0) > 0 ? 'DoorDash' : 'Third-Party'

  const hasServiceCharges = (saleRaw.serviceChargesSum ?? 0) > 0
  const hasLeadGen1 = (saleRaw.leadgenonediscofee ?? 0) > 0
  const hasLeadGen2 = (saleRaw.leadgentwodiscofee ?? 0) > 0

  // Platform fees — FM's exact key is unconfirmed (the previous `feeSum` mapping
  // read as 0/empty). Read across the likely field names; the server-side
  // [Dashboard] raw-response log lets us pin the real one and trim this list.
  const platformFees =
    saleRaw.feeSum ?? saleRaw.platformFeesSum ?? saleRaw.platformFeeSum ??
    saleRaw.platformFees ?? saleRaw.platformFee ?? saleRaw.discoFeeSum ??
    saleRaw.discoFee ?? saleRaw.serviceFee ?? saleRaw.fee

  const selectedRestaurantName = restaurants.find(r => r.reference === restaurantRef)?.businessName

  // Manual on-demand regeneration of the AI assistant's restaurant data. POSTs
  // to the cron route, authorized by the admin session cookie (credentials:
  // 'include') — CRON_SECRET is never exposed to the browser.
  const [regenLoading, setRegenLoading] = useState(false)
  const [regenMsg, setRegenMsg] = useState('')
  async function regenerateAiData() {
    setRegenLoading(true); setRegenMsg('')
    try {
      const res = await fetch('/api/cron/regenerate-compact', { method: 'POST', credentials: 'include' })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.success) {
        setRegenMsg(`✓ ${d.count} restaurants${typeof d.skipped === 'number' ? `, ${d.skipped} skipped` : ''}`)
      } else {
        setRegenMsg(`✕ ${d.error || `Failed (HTTP ${res.status})`}`)
      }
    } catch {
      setRegenMsg('✕ Network error')
    } finally {
      setRegenLoading(false)
    }
  }

  // Manual on-demand FM→Sanity restaurant sync. Same auth model as the AI-data
  // regeneration above (admin session cookie; CRON_SECRET never hits the browser).
  const [syncLoading, setSyncLoading] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  async function syncRestaurants() {
    setSyncLoading(true); setSyncMsg('')
    try {
      const res = await fetch('/api/cron/sync-restaurants', { method: 'POST', credentials: 'include' })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.success) {
        const errs = Array.isArray(d.errors) ? d.errors.length : 0
        const skipped = (d.skipped_no_address || 0) + (d.skipped_no_coords || 0)
        setSyncMsg(`✓ ${d.synced} synced (${d.new} new, ${d.updated} updated) · ${d.deactivated} deactivated · ${skipped} skipped${d.capped_at_500 ? ' · capped at 500' : ''}${errs ? ` · ${errs} errors` : ''}`)
      } else {
        setSyncMsg(`✕ ${d.error || `Failed (HTTP ${res.status})`}`)
      }
    } catch {
      setSyncMsg('✕ Network error')
    } finally {
      setSyncLoading(false)
    }
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <style>{`@keyframes dash-shimmer { 0% { background-position: 100% 0 } 100% { background-position: -100% 0 } }`}</style>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 4px' }}>Dashboard</h1>
          <p style={{ fontSize: 13, color: '#888', margin: 0 }}>Platform overview.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {syncMsg && <span style={{ fontSize: 12, fontWeight: 600, color: syncMsg.startsWith('✓') ? '#2E7D32' : '#C0392B' }}>{syncMsg}</span>}
          <button
            type="button"
            onClick={syncRestaurants}
            disabled={syncLoading}
            title="Pull active marketplace restaurants from FamilyMeal into Sanity (address, location, coordinates, order URL)"
            style={{ background: '#fff', color: DARK, border: `1.5px solid ${GOLD}`, borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: syncLoading ? 'default' : 'pointer', fontFamily: F, opacity: syncLoading ? 0.7 : 1, whiteSpace: 'nowrap' }}
          >
            {syncLoading ? 'Syncing…' : 'Sync Restaurants from FM'}
          </button>
          {regenMsg && <span style={{ fontSize: 12, fontWeight: 600, color: regenMsg.startsWith('✓') ? '#2E7D32' : '#C0392B' }}>{regenMsg}</span>}
          <button
            type="button"
            onClick={regenerateAiData}
            disabled={regenLoading}
            title="Rebuild the AI assistant's restaurant pricing/package data from Sanity + FM"
            style={{ background: GOLD, color: DARK, border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: regenLoading ? 'default' : 'pointer', fontFamily: F, opacity: regenLoading ? 0.7 : 1, whiteSpace: 'nowrap' }}
          >
            {regenLoading ? 'Regenerating…' : 'Regenerate AI Data'}
          </button>
        </div>
      </div>

      {/* Count metrics — always unfiltered (FM behavior) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginTop: 22 }}>
        <CountCard title="Total Restaurants" value={stats.totalRestaurantsCount} />
        <CountCard title="Total Orders" value={stats.totalOrdersCount} />
        <CountCard title="Total Visitors" value={stats.totalVisitors} />
        <CountCard title="Avg Orders / Day" value={stats.avgOrdersPerDayCount} decimal />
      </div>

      {/* Filters */}
      <div style={{ background: '#fff', borderRadius: 12, padding: '16px 20px', border: '1px solid #eee', marginTop: 24, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, position: 'relative' }}>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setShowRestaurantPicker(s => !s)}
            style={{ ...selectBtn, minWidth: 240, textAlign: 'left' }}
          >
            {selectedRestaurantName || 'All restaurants'}
            <span style={{ float: 'right', color: '#aaa', marginLeft: 8 }}>▾</span>
          </button>
          {showRestaurantPicker && (
            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, background: '#fff', border: '1px solid #e6e6e6', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.08)', padding: 6, maxHeight: 320, overflow: 'auto', minWidth: 280, zIndex: 50 }}>
              <button
                onClick={() => { setRestaurantRef(''); setShowRestaurantPicker(false) }}
                style={pickerItem(!restaurantRef)}
              >All restaurants</button>
              {restaurants.map(r => (
                <button
                  key={r.reference}
                  onClick={() => { setRestaurantRef(r.reference); setShowRestaurantPicker(false) }}
                  style={pickerItem(restaurantRef === r.reference)}
                >{r.businessName}</button>
              ))}
            </div>
          )}
        </div>

        {/* Date range presets */}
        <div style={{ display: 'inline-flex', background: '#F2F3F8', borderRadius: 10, padding: 3, gap: 2, flexWrap: 'wrap' }}>
          {PRESETS.map(p => (
            <button
              key={p.key}
              type="button"
              onClick={() => selectPreset(p.key)}
              style={{
                border: 'none', borderRadius: 8, padding: '7px 12px', fontSize: 13, fontFamily: F,
                fontWeight: preset === p.key ? 700 : 500,
                background: preset === p.key ? '#fff' : 'transparent',
                color: preset === p.key ? DARK : '#777',
                boxShadow: preset === p.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                cursor: 'pointer',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Custom date pickers — only shown for the Custom Range preset */}
        {preset === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="date" value={fmToIso(fromDate)} onChange={e => setFromDate(isoToFm(e.target.value))} style={inputSt} />
            <span style={{ color: '#888' }}>→</span>
            <input type="date" value={fmToIso(toDate)} onChange={e => setToDate(isoToFm(e.target.value))} style={inputSt} />
          </div>
        )}

        {loading && <span style={{ fontSize: 12, color: '#aaa', marginLeft: 'auto' }}>Loading…</span>}
      </div>

      {/* Sale stats — top block (matches FM template 2-87) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginTop: 18 }}>
        <SaleCard title="Platform Fees" value={platformFees} />
        <SaleCard title="Processing Fees" value={saleRaw.stripeFeeSum} />
        <SaleCard title="Net Sales" value={saleRaw.subtotalOrdersSum} />
        <SaleCard title="Tax Amount" value={taxAmount} />
        <SaleCard title="Own Tips" value={saleRaw.tipsInPrice} />
        <SaleCard title="Own Delivery" value={saleRaw.ownDeliveryPriceSum} />
        <SaleCard title={`${dpKind} Tips`} value={dpTips} />
        <SaleCard title={`${dpKind} Delivery`} value={dpDelivery} />
        <SaleCard title="Stripe Fees" value={saleRaw.stripeFeeSum} />
        <SaleCard title="Refunds" value={saleRaw.refundSum} />
        {hasServiceCharges && <SaleCard title="Service Charges" value={saleRaw.serviceChargesSum} />}
        {hasLeadGen1 && <SaleCard title="Lead Gen 1" value={saleRaw.leadgenonediscofee} />}
        {hasLeadGen2 && <SaleCard title="Lead Gen 2" value={saleRaw.leadgentwodiscofee} />}
      </div>

      {/* Order volume — daily order count over the selected range */}
      <h2 style={{ fontSize: 13, fontWeight: 700, color: '#666', margin: '28px 0 12px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Order Volume
        {volumeTruncated && <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: '#aaa', marginLeft: 8 }}>(showing first 2,000 orders in range)</span>}
      </h2>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '16px 18px' }}>
        {volumeLoading ? (
          <div style={{ height: 240, borderRadius: 10, background: 'linear-gradient(90deg,#f0f0f0 25%,#e6e6e6 50%,#f0f0f0 75%)', backgroundSize: '200% 100%', animation: 'dash-shimmer 1.4s ease infinite' }} />
        ) : volume.length === 0 ? (
          <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bbb', fontSize: 13 }}>
            No orders in this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={volume} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f2f2f2" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#999' }} tickLine={false} axisLine={{ stroke: '#eee' }} minTickGap={20} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#999' }} tickLine={false} axisLine={false} width={32} />
              <Tooltip cursor={{ fill: 'rgba(91,111,232,0.06)' }} />
              <Bar dataKey="orders" fill={BLUE} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* GMV / Customer metrics — bottom block (matches FM template 110-127) */}
      <h2 style={{ fontSize: 13, fontWeight: 700, color: '#666', margin: '28px 0 12px', textTransform: 'uppercase', letterSpacing: 0.5 }}>GMV & Customers</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        <SaleCard title="Gross Sales (GMV)" value={saleRaw.totalOrdersSum} highlight />
        <CountCard title="# of Orders" value={saleRaw.totalOrdersCount} />
        <SaleCard title="Avg Check" value={saleRaw.totalOrdersAvgSum} />
        <CountCard title="Total Customers" value={saleRaw.totalCustomersCount} />
      </div>
    </div>
  )
}

function CountCard({ title, value, decimal }: { title: string; value?: number; decimal?: boolean }) {
  return (
    <div style={cardSt}>
      <div style={cardTitle}>{title}</div>
      <div style={cardValue}>{decimal ? (value || 0).toFixed(1) : fmtNumber(value)}</div>
    </div>
  )
}

function SaleCard({ title, value, highlight }: { title: string; value?: number; highlight?: boolean }) {
  return (
    <div style={{ ...cardSt, borderLeft: highlight ? `3px solid ${GOLD}` : '1px solid #eee' }}>
      <div style={cardTitle}>{title}</div>
      <div style={cardValue}>{fmtCurrency(value)}</div>
    </div>
  )
}

const cardSt: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: '16px 18px', border: '1px solid #eee' }
const cardTitle: React.CSSProperties = { fontSize: 11, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }
const cardValue: React.CSSProperties = { fontSize: 22, fontWeight: 700, color: DARK }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const selectBtn: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 12px', fontSize: 13, fontFamily: F, color: DARK, background: '#fff', cursor: 'pointer' }
const pickerItem = (active: boolean): React.CSSProperties => ({
  display: 'block', width: '100%', textAlign: 'left',
  background: active ? 'rgba(239,184,74,0.15)' : 'transparent',
  border: 'none', padding: '7px 12px', fontSize: 13, fontFamily: F, color: DARK,
  cursor: 'pointer', borderRadius: 6, marginBottom: 1,
  fontWeight: active ? 600 : 400,
})
