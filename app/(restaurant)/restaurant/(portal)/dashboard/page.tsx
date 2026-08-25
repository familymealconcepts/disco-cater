'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import GenerateReportButton from '../_components/GenerateReportButton'
import { useSelectedRestaurant } from '../_components/SelectedRestaurantContext'
import { ScheduledReportsPanel } from '../manage/admin-manager-reports/page'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const ACCENT = '#5B6FE8'

// Status set used for the chart/marketplace order fetch — real orders only
// (excludes CANCELED / VOID / EXPIRED, which aren't revenue). The order list
// endpoint expects YYYY-MM-DD for fromDate/toDate (unlike sale-stats, which
// needs DD.MM.YYYY — handled in its proxy).
const CHART_STATUSES = ['DUE', 'UNPAID', 'PAID', 'COMPLETED', 'REOPEN', 'RESERVED', 'REFUND', 'PARTIAL_REFUND']
const MAX_PAGES = 10
const PAGE_SIZE = 200

interface SaleStats {
  // These 4 are computed directly from disco_orders (subtotal/total/count) and
  // are always reliable, for both FM-mirrored and native orders.
  subtotalOrdersAvg?: number
  subtotalOrdersSum?: number
  totalOrdersCount?: number
  totalOrdersSum?: number
  // Everything below needs per-order transaction detail (tax breakdown,
  // delivery-fee split, tips split, stripe fee) that only exists for native-
  // checkout orders today — the API returns `null` (not 0) for these until the
  // FM order-detail backfill lands, and the Card component shows "Not
  // available" rather than a fabricated $0.00.
  doordashDeliveryFeeSum?: number | null
  thirdPartyDeliveryFeeSum?: number | null
  doordashTipsOrdersSum?: number | null
  thirdPartyDeliveryTipsOrdersSum?: number | null
  ownDeliveryPriceSum?: number | null
  pickupTipsInPrice?: number | null
  stateSalesTaxInPriceSum?: number | null
  localSalesTaxInPriceSum?: number | null
  otherSalesTaxInPriceSum?: number | null
  owndeliveryTipsInPrice?: number | null
  stripeFeeSum?: number | null
  serviceChargesSum?: number | null
  leadgenonediscofee?: number | null
  leadgentwodiscofee?: number | null
}

interface DashStats {
  activeAddOnsCount?: number
  activeMealPackagesCount?: number
  availableAddOnsCount?: number
  availableMealPackagesCount?: number
  scheduleOrdersCount?: number
  todayOrdersCount?: number
}

interface Restaurant {
  reference?: string
  businessName?: string
  businessNameWithoutSpaces?: string
  slug?: string
  deliveryType?: string
  onlineOrderingAllowed?: boolean
  doorDashAllowed?: boolean
  deliveryAllowed?: boolean
  feeCategories?: { displayFeeCategoriesName: string }[]
  admin?: { phoneNumber?: string }
}

// Minimal order shape for the chart/marketplace aggregation.
interface ListOrder {
  orderDate?: string
  bucketDate?: string
  transactionsTotal?: number
  orderType?: string
  deliveryType?: string
  sourceoforder?: string
  deliveryStatus?: string
  // Recurring-order indicators (any truthy → recurring; key varies by FM deploy).
  orderSubscription?: unknown
  isRecurring?: boolean
  subscriptionReference?: string
  recurring?: boolean
}

// Any truthy recurring indicator marks the order as part of a recurring series.
function isRecurringOrder(o: ListOrder): boolean {
  return !!(o.orderSubscription || o.isRecurring || o.subscriptionReference || o.recurring)
}

type Preset = 'today' | 'last7' | 'last30' | 'month' | 'custom'
interface TrendPoint { full: string; date: string; revenue: number }

function fmt(n: number | undefined | null) {
  if (n === undefined || n === null) return '$0.00'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}
// Y-axis tick formatter: compact "$1.2K" for >= 1000, otherwise a precise
// 2-decimal amount ("$2.00", "$0.50") so small daily totals aren't rounded
// into identical "$2"/"$1" labels.
function fmtAxisUSD(n: number) {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

// Local-tz YYYY-MM-DD (avoids the UTC off-by-one that toISOString causes).
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function computeRange(p: Preset): { from: string; to: string } | null {
  const now = new Date()
  const to = ymd(now)
  if (p === 'today') return { from: to, to }
  if (p === 'last7') { const d = new Date(); d.setDate(d.getDate() - 6); return { from: ymd(d), to } }
  if (p === 'last30') { const d = new Date(); d.setDate(d.getDate() - 29); return { from: ymd(d), to } }
  if (p === 'month') { const d = new Date(now.getFullYear(), now.getMonth(), 1); return { from: ymd(d), to } }
  return null // custom
}
// Short label "Jun 1" — parse as local date so the day doesn't shift.
function dayLabel(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
// Inclusive list of YYYY-MM-DD between from..to (capped for safety).
function enumerateDays(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  if (!fy || !ty) return []
  const start = new Date(fy, fm - 1, fd)
  const end = new Date(ty, tm - 1, td)
  const out: string[] = []
  const cur = new Date(start)
  let guard = 0
  while (cur <= end && guard < 400) { out.push(ymd(cur)); cur.setDate(cur.getDate() + 1); guard++ }
  return out
}

// `value == null` (null from the API, meaning "genuinely not computable yet" —
// see sale-stats route's `unavailable` fields) renders "Not available" instead
// of a fabricated $0.00. A real zero (the API returning 0) still renders as
// $0.00 — only null/undefined means unavailable.
function Card({ title, value, isCurrency = true, gray = false, tooltip, unavailableReason }: {
  title: string; value: number | null | undefined; isCurrency?: boolean; gray?: boolean; tooltip?: string
  unavailableReason?: string
}) {
  const unavailable = value == null
  const effectiveTooltip = unavailable ? (unavailableReason || tooltip) : tooltip
  const [showTip, setShowTip] = useState(false)
  return (
    <div style={{
      background: gray ? '#F0F0F4' : '#fff',
      borderRadius: 12, padding: '18px 20px',
      border: '1px solid #eee', position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: '#888', fontWeight: 500 }}>{title}</div>
        {effectiveTooltip && (
          <div style={{ position: 'relative' }}>
            <span
              onMouseEnter={() => setShowTip(true)}
              onMouseLeave={() => setShowTip(false)}
              style={{ cursor: 'pointer', color: '#bbb', fontSize: 13, lineHeight: 1 }}>ⓘ</span>
            {showTip && (
              <div style={{
                position: 'absolute', bottom: '100%', left: 0, background: DARK, color: '#fff',
                borderRadius: 8, padding: '8px 10px', fontSize: 11, whiteSpace: 'pre', zIndex: 10,
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)', marginBottom: 4, minWidth: 180,
              }}>
                {effectiveTooltip}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: unavailable ? '#bbb' : DARK }}>
        {unavailable ? 'Not available' : (isCurrency ? fmt(value) : (value ?? 0).toLocaleString())}
      </div>
    </div>
  )
}

// Marketplace stat card — takes a pre-formatted string value (handles %/count/$).
function MktCard({ title, value, loading }: { title: string; value: string; loading?: boolean }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '18px 20px', border: '1px solid #e8e8e8' }}>
      <div style={{ fontSize: 12, color: '#888', fontWeight: 500, marginBottom: 8 }}>{title}</div>
      {loading
        ? <div className="rep-skel" style={{ height: 26, width: '60%', borderRadius: 6 }} />
        : <div style={{ fontSize: 22, fontWeight: 700, color: DARK }}>{value}</div>}
    </div>
  )
}

function TrendTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value?: number }>; label?: string }) {
  if (!active || !payload || !payload.length) return null
  return (
    <div style={{ background: DARK, color: '#fff', borderRadius: 8, padding: '8px 10px', fontSize: 12, fontFamily: F }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{label}</div>
      <div>{fmt(payload[0].value ?? 0)}</div>
    </div>
  )
}

interface LocationOption {
  reference: string
  businessName: string
}

export default function DashboardPage() {
  const initRange = computeRange('last30')!
  const [preset, setPreset] = useState<Preset>('last30')
  const [fromDate, setFromDate] = useState(initRange.from)
  const [toDate, setToDate] = useState(initRange.to)
  const [dateType, setDateType] = useState<'orderDate' | 'createdDate'>('orderDate')
  const [saleStats, setSaleStats] = useState<SaleStats>({})
  const [dashStats, setDashStats] = useState<DashStats>({})
  const [restaurant, setRestaurant] = useState<Restaurant>({})
  const [loading, setLoading] = useState(true)
  const [saleLoading, setSaleLoading] = useState(false)
  // Tracks the date range/type that produced the currently-shown numbers,
  // so the Custom "Update" button greys out until From/To/dateType change.
  const [lastFetched, setLastFetched] = useState({ fromDate: '', toDate: '', dateType: '' })

  // Chart / marketplace state (separate fetch from sale-stats).
  const [chartLoading, setChartLoading] = useState(true)
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [mkt, setMkt] = useState({ orders: 0, revenue: 0, total: 0 })
  const [recurring, setRecurring] = useState({ count: 0, revenue: 0, total: 0 })
  const [truncated, setTruncated] = useState(false)

  // Keep refs to current dates so the role/refresh effects can read them
  // without re-subscribing on every date-input keystroke.
  const fromRef = useRef(fromDate)
  const toRef = useRef(toDate)
  useEffect(() => { fromRef.current = fromDate }, [fromDate])
  useEffect(() => { toRef.current = toDate }, [toDate])

  // SYSTEM_ADMIN multi-restaurant filter — selection state comes from
  // the shared SelectedRestaurantContext so the sidebar header and this
  // dropdown can't drift out of sync.
  const { ref: ctxRef, setRestaurant: pickRestaurant, clearRestaurant } = useSelectedRestaurant()
  const [isSystemAdmin, setIsSystemAdmin] = useState(false)
  const [locations, setLocations] = useState<LocationOption[]>([])
  const [switching, setSwitching] = useState(false)
  const selectedRef = ctxRef || ''   // '' = All restaurants in dropdown

  useEffect(() => {
    try {
      const raw = localStorage.getItem('restaurant_user')
      if (raw) {
        const u = JSON.parse(raw)
        if (u.role === 'SYSTEM_ADMIN' || u.role === 'SUPER_ADMIN') {
          setIsSystemAdmin(true)
        }
      }
    } catch {}
  }, [])

  // Load location list once we know user is SYSTEM_ADMIN
  useEffect(() => {
    if (!isSystemAdmin) return
    fetch('/api/restaurant/locations?size=1000')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.content) {
          setLocations(d.content.map((l: { reference: string; businessName: string }) => ({
            reference: l.reference, businessName: l.businessName,
          })))
        }
      })
      .catch(() => {})
  }, [isSystemAdmin])

  useEffect(() => {
    Promise.all([
      fetch('/api/restaurant/profile').then(r => r.ok ? r.json() : {}),
      fetch('/api/restaurant/dashboard/stats').then(r => r.ok ? r.json() : {}),
    ]).then(([rest, stats]) => {
      setRestaurant(rest || {})
      setDashStats(stats || {})
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [selectedRef])

  // ── Financial cards data (sale-stats) ──────────────────────────────────────
  const loadSaleStats = useCallback(async (from: string, to: string) => {
    if (!from || !to) return
    setSaleLoading(true)
    setLastFetched({ fromDate: from, toDate: to, dateType })
    const params = new URLSearchParams({ fromDate: from, toDate: to, dateType })
    if (selectedRef) params.set('restaurantReference', selectedRef)
    try {
      const res = await fetch(`/api/restaurant/dashboard/sale-stats?${params}`)
      setSaleStats(res.ok ? await res.json() : {})
    } finally {
      setSaleLoading(false)
    }
  }, [dateType, selectedRef])

  // ── Chart + marketplace data (order list) ──────────────────────────────────
  const loadChartData = useCallback(async (from: string, to: string) => {
    if (!from || !to) return
    setChartLoading(true)
    // /api/restaurant/orders is Disco's own Neon-backed proxy (disco_orders),
    // not a passthrough to FM's raw API — it casts fromDate/toDate straight to
    // a Postgres ::date, so it needs YYYY-MM-DD, not FM's DD.MM.YYYY. Sending
    // DD.MM.YYYY here 500'd the request (invalid date syntax), which
    // loadChartData silently swallowed as an empty trend — this was the "sales
    // graph doesn't work" bug. Scoping to the selected restaurant is handled
    // server-side by the fm_selected_restaurant cookie (set by the dropdown),
    // matching the sale-stats scope.
    try {
      const all: ListOrder[] = []
      let page = 0
      let totalPages = 1
      let hitCap = false
      do {
        const p = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE), fromDate: from, toDate: to, dateType })
        CHART_STATUSES.forEach(s => p.append('orderStatuses', s))
        // Scope to the selected restaurant when one is picked (mirrors the
        // sale-stats fetch). Empty selectedRef = "All restaurants" → aggregate.
        if (selectedRef) p.set('restaurantReference', selectedRef)
        const res = await fetch(`/api/restaurant/orders?${p}`)
        if (!res.ok) break
        const d = await res.json()
        const content: ListOrder[] = Array.isArray(d.content) ? d.content : []
        all.push(...content)
        totalPages = typeof d.totalPages === 'number'
          ? d.totalPages
          : Math.ceil((d.totalElements || content.length) / PAGE_SIZE)
        page++
        if (page >= MAX_PAGES && page < totalPages) { hitCap = true; break }
      } while (page < totalPages)
      setTruncated(hitCap)

      // Daily revenue trend (fill $0 days). Buckets by bucketDate — order_date
      // or the restaurant-local created_at date, matching whichever dateType
      // mode is selected (previously always order_date, silently ignoring the
      // toggle even though the fromDate/toDate range filter above now honors it).
      const byDay: Record<string, number> = {}
      for (const o of all) {
        const day = o.bucketDate || o.orderDate
        if (!day) continue
        byDay[day] = (byDay[day] || 0) + (o.transactionsTotal || 0)
      }
      setTrend(enumerateDays(from, to).map(d => ({ full: d, date: dayLabel(d), revenue: byDay[d] || 0 })))

      // Marketplace (Disco) + recurring breakdowns.
      let disco = 0, discoRev = 0
      let recCount = 0, recRev = 0
      for (const o of all) {
        if (o.sourceoforder === 'DISCO') { disco++; discoRev += o.transactionsTotal || 0 }
        if (isRecurringOrder(o)) { recCount++; recRev += o.transactionsTotal || 0 }
      }
      setMkt({ orders: disco, revenue: discoRev, total: all.length })
      setRecurring({ count: recCount, revenue: recRev, total: all.length })
    } catch {
      setTrend([]); setMkt({ orders: 0, revenue: 0, total: 0 })
      setRecurring({ count: 0, revenue: 0, total: 0 })
    } finally {
      setChartLoading(false)
    }
  }, [selectedRef, dateType])

  const runReport = useCallback((from: string, to: string) => {
    loadSaleStats(from, to)
    loadChartData(from, to)
  }, [loadSaleStats, loadChartData])

  // Fetch on mount and whenever the report identity changes — i.e. the
  // SYSTEM_ADMIN restaurant context or the Order/Created date-type. Plain
  // From/To input changes do NOT auto-fetch (Custom mode waits for Update);
  // preset clicks fetch immediately via applyPreset.
  useEffect(() => { runReport(fromRef.current, toRef.current) }, [runReport])

  function applyPreset(p: Preset) {
    setPreset(p)
    if (p === 'custom') return // reveal inputs; wait for explicit Update
    const r = computeRange(p)
    if (!r) return
    setFromDate(r.from); setToDate(r.to)
    fromRef.current = r.from; toRef.current = r.to
    runReport(r.from, r.to)
  }

  async function changeRestaurant(ref: string) {
    setSwitching(true)
    try {
      if (ref) {
        const loc = locations.find(l => l.reference === ref)
        await pickRestaurant(ref, loc?.businessName)
      } else {
        await clearRestaurant()
      }
    } finally {
      setSwitching(false)
    }
  }

  // null unless at least one tax component has come back populated (post-
  // backfill) — never a fabricated $0.00 while all three are still null.
  const taxAvailable = saleStats.stateSalesTaxInPriceSum != null
    || saleStats.localSalesTaxInPriceSum != null || saleStats.otherSalesTaxInPriceSum != null
  const tax = taxAvailable
    ? (saleStats.stateSalesTaxInPriceSum || 0) + (saleStats.localSalesTaxInPriceSum || 0) + (saleStats.otherSalesTaxInPriceSum || 0)
    : null

  const taxTooltip = [
    `State: ${fmt(saleStats.stateSalesTaxInPriceSum ?? undefined)}`,
    `Local: ${fmt(saleStats.localSalesTaxInPriceSum ?? undefined)}`,
    `Other: ${fmt(saleStats.otherSalesTaxInPriceSum ?? undefined)}`,
  ].join('\n')
  const NOT_AVAILABLE_REASON = 'Needs per-order transaction detail not yet available for FM-mirrored orders.'

  const isDoorDash = (saleStats.doordashDeliveryFeeSum || 0) > 0
  const deliveryFeeTitle = isDoorDash ? 'DoorDash Delivery' : 'Third-Party Delivery'
  // Previously hardcoded to 0 regardless of data — now reads the real field
  // (still null/"Not available" until the backfill populates it).
  const deliveryFee = isDoorDash ? saleStats.doordashDeliveryFeeSum : saleStats.thirdPartyDeliveryFeeSum
  const deliveryTips = isDoorDash
    ? saleStats.doordashTipsOrdersSum
    : saleStats.thirdPartyDeliveryTipsOrdersSum
  const deliveryTipsTitle = isDoorDash ? 'DoorDash Tips' : 'Third-Party Tips'
  const hasServiceCharge = restaurant.feeCategories && restaurant.feeCategories.length > 0
  const serviceChargeTitle = hasServiceCharge
    ? restaurant.feeCategories![0].displayFeeCategoriesName
    : 'Service Charge'

  const datesChanged =
    fromDate !== lastFetched.fromDate ||
    toDate !== lastFetched.toDate ||
    dateType !== lastFetched.dateType

  const leadGenFees = (saleStats.leadgenonediscofee || 0) + (saleStats.leadgentwodiscofee || 0)
  const mktShare = mkt.total > 0 ? (mkt.orders / mkt.total) * 100 : 0
  const slug = restaurant.slug || restaurant.businessNameWithoutSpaces || ''

  const PRESETS: { key: Preset; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'last7', label: 'Last 7 Days' },
    { key: 'last30', label: 'Last 30 Days' },
    { key: 'month', label: 'This Month' },
    { key: 'custom', label: 'Custom' },
  ]

  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <style>{`
        @keyframes rep-shimmer { 0% { background-position: 100% 0 } 100% { background-position: -100% 0 } }
        .rep-skel { background: linear-gradient(90deg, #f0f0f0 25%, #e6e6e6 50%, #f0f0f0 75%); background-size: 200% 100%; animation: rep-shimmer 1.4s ease infinite; }
        @media (max-width: 768px) {
          .rep-trend-wrap { display: none !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, gap: 16, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>
          Reporting
          {!isSystemAdmin && restaurant.businessName && (
            <span style={{ fontWeight: 400, color: '#888', fontSize: 16, marginLeft: 8 }}>
              ({restaurant.businessName})
            </span>
          )}
        </h1>
        {isSystemAdmin && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>Restaurant</label>
            <select
              value={selectedRef}
              disabled={switching}
              onChange={e => changeRestaurant(e.target.value)}
              style={{
                border: '1.5px solid #e0e0e0', borderRadius: 8,
                padding: '7px 28px 7px 10px', fontSize: 13, fontFamily: F,
                color: DARK, background: '#fff', outline: 'none',
                minWidth: 220, cursor: switching ? 'not-allowed' : 'pointer',
              }}
            >
              <option value="">All restaurants</option>
              {locations.map(l => (
                <option key={l.reference} value={l.reference}>{l.businessName}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* #19: top summary bubbles (Active Menus, Available Menus, order counts,
          Add-Ons) removed per request. */}

      {/* Date presets + Order/Created toggle */}
      <div style={{ background: '#fff', borderRadius: 12, padding: '16px 20px', border: '1px solid #eee', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'inline-flex', background: '#F2F3F8', borderRadius: 10, padding: 3, gap: 2, flexWrap: 'wrap' }}>
            {PRESETS.map(p => (
              <button
                key={p.key}
                onClick={() => applyPreset(p.key)}
                disabled={saleLoading || chartLoading}
                style={{
                  border: 'none', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontFamily: F,
                  fontWeight: preset === p.key ? 700 : 500,
                  background: preset === p.key ? '#fff' : 'transparent',
                  color: preset === p.key ? DARK : '#777',
                  boxShadow: preset === p.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  cursor: (saleLoading || chartLoading) ? 'wait' : 'pointer',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>From</label>
                <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} disabled={saleLoading}
                  style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', opacity: saleLoading ? 0.6 : 1 }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>To</label>
                <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} disabled={saleLoading}
                  style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', opacity: saleLoading ? 0.6 : 1 }} />
              </div>
              <GenerateReportButton onClick={() => runReport(fromDate, toDate)} loading={saleLoading || chartLoading} disabled={!datesChanged} label="Update" loadingLabel="Updating…" />
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginLeft: 'auto' }}>
            {(['orderDate', 'createdDate'] as const).map(v => (
              <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: saleLoading ? 'not-allowed' : 'pointer', color: '#555', opacity: saleLoading ? 0.6 : 1 }}>
                <input type="radio" name="dateType" value={v} checked={dateType === v} onChange={() => setDateType(v)} disabled={saleLoading} />
                {v === 'orderDate' ? 'Order Date' : 'Created Date'}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Revenue trend (hidden on mobile) */}
      <div className="rep-trend-wrap" style={{ background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: '16px 18px', marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: DARK }}>Daily Revenue</div>
          {truncated && <div style={{ fontSize: 11, color: '#bbb' }}>showing first {MAX_PAGES * PAGE_SIZE} orders</div>}
        </div>
        {chartLoading ? (
          <div className="rep-skel" style={{ height: 200, borderRadius: 10 }} />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={trend} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f2f2f2" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#999' }} tickLine={false} axisLine={{ stroke: '#eee' }} minTickGap={24} />
              <YAxis tickFormatter={(value) => fmtAxisUSD(Number(value))} tick={{ fontSize: 11, fill: '#999' }} tickLine={false} axisLine={false} width={64} />
              <Tooltip content={<TrendTooltip />} />
              <Line type="monotone" dataKey="revenue" stroke={ACCENT} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* #21: "Disco Cater Marketplace Performance" section removed per request. */}

      {/* Recurring orders summary — computed from the loaded orders dataset
          (no extra fetch). Hidden when there are no recurring orders. */}
      {!chartLoading && recurring.count > 0 && (
        <div style={{ background: '#EEF0FF', color: '#5B6FE8', borderRadius: 8, padding: '12px 16px', fontSize: 14, fontWeight: 600, marginBottom: 16 }}>
          🔄 Recurring Orders: {recurring.count.toLocaleString()} orders · {fmt(recurring.revenue)} revenue · {(recurring.total > 0 ? (recurring.count / recurring.total) * 100 : 0).toFixed(1)}% of total orders
        </div>
      )}

      {/* Existing financial cards (unchanged). For SA/SUPER_ADMIN with no
          restaurant selected this shows the all-restaurants aggregate; a
          dropdown selection scopes to one location. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
        <Card title="Net Sales" value={saleStats.subtotalOrdersSum} />
        <Card title="Tax Amount" value={tax} tooltip={taxAvailable ? taxTooltip : undefined} unavailableReason={NOT_AVAILABLE_REASON} />
        <Card title="# of Orders" value={saleStats.totalOrdersCount} isCurrency={false} />
        <Card title="Avg. Check (Net)" value={saleStats.subtotalOrdersAvg} />
        <Card title="Lead Gen 1" value={saleStats.leadgenonediscofee} unavailableReason={NOT_AVAILABLE_REASON} />
        <Card title="Lead Gen 2" value={saleStats.leadgentwodiscofee} unavailableReason={NOT_AVAILABLE_REASON} />
        <Card title="Pickup Tips" value={saleStats.pickupTipsInPrice} unavailableReason={NOT_AVAILABLE_REASON} />
        <Card title="Self-Delivery" value={saleStats.ownDeliveryPriceSum} unavailableReason={NOT_AVAILABLE_REASON} />
        <Card title="Self-Delivery Tips" value={saleStats.owndeliveryTipsInPrice} unavailableReason={NOT_AVAILABLE_REASON} />
        <Card title={deliveryFeeTitle} value={deliveryFee} unavailableReason={NOT_AVAILABLE_REASON} />
        <Card title={deliveryTipsTitle} value={deliveryTips} unavailableReason={NOT_AVAILABLE_REASON} />
        {hasServiceCharge && <Card title={serviceChargeTitle} value={saleStats.serviceChargesSum} unavailableReason={NOT_AVAILABLE_REASON} />}
        <Card title="Stripe Fees" value={saleStats.stripeFeeSum} gray unavailableReason={NOT_AVAILABLE_REASON} />
        <Card title="Total Amount" value={saleStats.totalOrdersSum} />
      </div>

      {/* #20: export orders for a date range (order or created date) as CSV/Excel/PDF.
          Moved below the summary cards per request. */}
      <div style={{ marginTop: 20 }}>
        <ExportPanel />
      </div>

      {/* Scheduled Reports — moved here from the standalone Reports page. */}
      <div style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: '0 0 14px' }}>Scheduled Reports</h2>
        <ScheduledReportsPanel />
      </div>
    </div>
  )
}

// #20: on-demand orders export. Picks a date range, the date field to filter on
// (order date vs created date), and a format (CSV / Excel / PDF). Each button hits
// the restaurant-scoped /api/restaurant/reports/export route and downloads the file.
function ExportPanel() {
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10))
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [dateField, setDateField] = useState<'order' | 'created'>('order')
  const download = (format: 'csv' | 'xls' | 'pdf') => {
    if (!from || !to) return
    const qs = new URLSearchParams({ from, to, dateField, format })
    const a = document.createElement('a')
    a.href = `/api/restaurant/reports/export?${qs.toString()}`
    a.rel = 'noopener'
    document.body.appendChild(a); a.click(); a.remove()
  }
  const inp: React.CSSProperties = { padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8, fontSize: 13, fontFamily: F, marginTop: 4 }
  const fmtBtn = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F })
  return (
    <div style={{ marginBottom: 28, background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: '18px 20px' }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: DARK, margin: '0 0 4px' }}>Export report</h2>
      <p style={{ fontSize: 12.5, color: '#888', margin: '0 0 14px' }}>Download your orders for a date range as CSV, Excel, or PDF.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        <label style={{ fontSize: 12, color: '#555', fontWeight: 600, display: 'flex', flexDirection: 'column' }}>From<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} style={inp} /></label>
        <label style={{ fontSize: 12, color: '#555', fontWeight: 600, display: 'flex', flexDirection: 'column' }}>To<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} style={inp} /></label>
        <label style={{ fontSize: 12, color: '#555', fontWeight: 600, display: 'flex', flexDirection: 'column' }}>Filter by
          <select value={dateField} onChange={e => setDateField(e.target.value as 'order' | 'created')} style={inp}>
            <option value="order">Order date</option>
            <option value="created">Created date</option>
          </select>
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => download('csv')} style={fmtBtn('#16A34A')}>CSV</button>
          <button onClick={() => download('xls')} style={fmtBtn('#1D6F42')}>Excel</button>
          <button onClick={() => download('pdf')} style={fmtBtn('#B91C1C')}>PDF</button>
        </div>
      </div>
    </div>
  )
}
