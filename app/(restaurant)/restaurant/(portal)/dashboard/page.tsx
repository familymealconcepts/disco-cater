'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend, ResponsiveContainer, Label,
} from 'recharts'
import GenerateReportButton from '../_components/GenerateReportButton'
import { useSelectedRestaurant } from '../_components/SelectedRestaurantContext'

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
  doordashDeliveryFeeSum?: number
  thirdPartyDeliveryFeeSum?: number
  doordashTipsOrdersSum?: number
  thirdPartyDeliveryTipsOrdersSum?: number
  ownDeliveryPriceSum?: number
  pickupTipsInPrice?: number
  subtotalOrdersAvg?: number
  subtotalOrdersSum?: number
  stateSalesTaxInPriceSum?: number
  localSalesTaxInPriceSum?: number
  otherSalesTaxInPriceSum?: number
  owndeliveryTipsInPrice?: number
  totalOrdersCount?: number
  totalOrdersSum?: number
  stripeFeeSum?: number
  serviceChargesSum?: number
  leadgenonediscofee?: number
  leadgentwodiscofee?: number
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
  transactionsTotal?: number
  orderType?: string
  deliveryType?: string
  sourceoforder?: string
  nashDeliveryStatus?: string
  nashDeliveryPickupEta?: string
  nashDeliveryDropoffEta?: string
  nashDeliveryPublicTrackingUrl?: string
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
interface Slice { name: string; value: number; color: string }

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
// FM's orders API parses date filters as DD.MM.YYYY (same as the sale-stats and
// orders/saleStats proxies). The chart works in YYYY-MM-DD everywhere else
// (grouping keys, axis labels) — only the query params sent to FM need this.
// Sending YYYY-MM-DD silently matches nothing → the "no chart data" bug.
function toFmDate(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
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

function fulfillmentOf(o: ListOrder): 'pickup' | 'self' | '3p' {
  const dt = (o.deliveryType || '').toUpperCase()
  const has3P = !!(o.nashDeliveryStatus || o.nashDeliveryPickupEta || o.nashDeliveryDropoffEta || o.nashDeliveryPublicTrackingUrl)
  if (has3P || dt === 'NASH_DELIVERY' || dt === 'DOOR_DASH_DELIVERY' || dt === 'DLIVRD_DELIVERY' || dt.includes('THIRD') || dt.includes('DOORDASH')) return '3p'
  if (dt === 'OWN_DELIVERY' || dt.includes('SELF') || (o.orderType || '').toUpperCase() === 'DELIVERY') return 'self'
  return 'pickup'
}

function Card({ title, value, isCurrency = true, gray = false, tooltip }: {
  title: string; value: number | undefined; isCurrency?: boolean; gray?: boolean; tooltip?: string
}) {
  const [showTip, setShowTip] = useState(false)
  return (
    <div style={{
      background: gray ? '#F0F0F4' : '#fff',
      borderRadius: 12, padding: '18px 20px',
      border: '1px solid #eee', position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: '#888', fontWeight: 500 }}>{title}</div>
        {tooltip && (
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
                {tooltip}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: DARK }}>
        {isCurrency ? fmt(value) : (value ?? 0).toLocaleString()}
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

// Custom donut center label (recharts <Label content>).
function DonutCenter({ viewBox, total }: { viewBox?: { cx?: number; cy?: number }; total: number }) {
  const cx = viewBox?.cx ?? 0
  const cy = viewBox?.cy ?? 0
  return (
    <g>
      <text x={cx} y={cy - 3} textAnchor="middle" fontSize={22} fontWeight={700} fill={DARK}>{total.toLocaleString()}</text>
      <text x={cx} y={cy + 15} textAnchor="middle" fontSize={10} fill="#999">orders</text>
    </g>
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

function Donut({ title, data, loading }: { title: string; data: Slice[]; loading?: boolean }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <div style={{ flex: 1, minWidth: 0, background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: '16px 18px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 8 }}>{title}</div>
      {loading ? (
        <div className="rep-skel" style={{ height: 200, borderRadius: 10 }} />
      ) : total === 0 ? (
        <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#bbb', fontSize: 13 }}>
          No orders in this period
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
              {data.map((d, i) => <Cell key={i} fill={d.color} stroke="#fff" strokeWidth={2} />)}
              <Label content={(props) => <DonutCenter viewBox={(props as { viewBox?: { cx?: number; cy?: number } }).viewBox} total={total} />} />
            </Pie>
            <Tooltip />
            <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: 12, fontFamily: F }} />
          </PieChart>
        </ResponsiveContainer>
      )}
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
  const [fulfillment, setFulfillment] = useState<Slice[]>([])
  const [source, setSource] = useState<Slice[]>([])
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
    // FM's orders endpoint needs DD.MM.YYYY for the date filter (YYYY-MM-DD
    // silently returns nothing). Convert only the query params — `from`/`to`
    // stay YYYY-MM-DD for grouping and axis labels below. Scoping to the
    // selected restaurant is handled server-side by the fm_selected_restaurant
    // cookie (set by the dropdown), matching the sale-stats scope.
    const fmFrom = toFmDate(from)
    const fmTo = toFmDate(to)
    try {
      const all: ListOrder[] = []
      let page = 0
      let totalPages = 1
      let hitCap = false
      do {
        const p = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE), fromDate: fmFrom, toDate: fmTo })
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

      // Daily revenue trend (fill $0 days).
      const byDay: Record<string, number> = {}
      for (const o of all) {
        if (!o.orderDate) continue
        byDay[o.orderDate] = (byDay[o.orderDate] || 0) + (o.transactionsTotal || 0)
      }
      setTrend(enumerateDays(from, to).map(d => ({ full: d, date: dayLabel(d), revenue: byDay[d] || 0 })))

      // Fulfillment breakdown.
      let pickup = 0, self = 0, tp = 0
      // Source breakdown + marketplace stats.
      let disco = 0, direct = 0, discoRev = 0
      // Recurring breakdown (independent of source).
      let recCount = 0, recRev = 0
      for (const o of all) {
        const f = fulfillmentOf(o)
        if (f === 'pickup') pickup++; else if (f === 'self') self++; else tp++
        if (o.sourceoforder === 'DISCO') { disco++; discoRev += o.transactionsTotal || 0 }
        else direct++
        if (isRecurringOrder(o)) { recCount++; recRev += o.transactionsTotal || 0 }
      }
      setFulfillment([
        { name: 'Pickup', value: pickup, color: '#5B6FE8' },
        { name: 'Self-Delivery', value: self, color: '#C044C8' },
        { name: '3rd Party Delivery', value: tp, color: '#F0468A' },
      ])
      setSource([
        { name: 'Disco Cater Marketplace', value: disco, color: '#6B6EF9' },
        { name: 'Direct / 1st Party', value: direct, color: '#999999' },
      ])
      setMkt({ orders: disco, revenue: discoRev, total: all.length })
      setRecurring({ count: recCount, revenue: recRev, total: all.length })
    } catch {
      setTrend([]); setFulfillment([]); setSource([]); setMkt({ orders: 0, revenue: 0, total: 0 })
      setRecurring({ count: 0, revenue: 0, total: 0 })
    } finally {
      setChartLoading(false)
    }
  }, [selectedRef])

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

  const tax = (saleStats.stateSalesTaxInPriceSum || 0) +
    (saleStats.localSalesTaxInPriceSum || 0) +
    (saleStats.otherSalesTaxInPriceSum || 0)

  const taxTooltip = [
    `State: ${fmt(saleStats.stateSalesTaxInPriceSum)}`,
    `Local: ${fmt(saleStats.localSalesTaxInPriceSum)}`,
    `Other: ${fmt(saleStats.otherSalesTaxInPriceSum)}`,
  ].join('\n')

  const isDoorDash = (saleStats.doordashDeliveryFeeSum || 0) > 0
  const deliveryFeeTitle = isDoorDash ? 'DoorDash Delivery' : 'Third-Party Delivery'
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
          .rep-donuts { flex-direction: column !important; }
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

      {/* Count Stats */}
      {!loading && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '14px 16px', border: '1px solid #eee' }}>
            <div style={{ fontSize: 11, color: '#aaa', fontWeight: 500, marginBottom: 4 }}>Active Menus</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: BLUE }}>{dashStats.activeMealPackagesCount ?? 0}</div>
          </div>
          <div style={{ background: '#fff', borderRadius: 12, padding: '14px 16px', border: '1px solid #eee' }}>
            <div style={{ fontSize: 11, color: '#aaa', fontWeight: 500, marginBottom: 4 }}>Available Menus</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: BLUE }}>{dashStats.availableMealPackagesCount ?? 0}</div>
          </div>
          <div style={{ background: '#fff', borderRadius: 12, padding: '14px 16px', border: '1px solid #eee' }}>
            <div style={{ fontSize: 11, color: '#aaa', fontWeight: 500, marginBottom: 4 }}>Today&apos;s Orders</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: BLUE }}>{dashStats.todayOrdersCount ?? 0}</div>
          </div>
          <div style={{ background: '#fff', borderRadius: 12, padding: '14px 16px', border: '1px solid #eee' }}>
            <div style={{ fontSize: 11, color: '#aaa', fontWeight: 500, marginBottom: 4 }}>Scheduled Orders</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: BLUE }}>{dashStats.scheduleOrdersCount ?? 0}</div>
          </div>
          <div style={{ background: '#fff', borderRadius: 12, padding: '14px 16px', border: '1px solid #eee' }}>
            <div style={{ fontSize: 11, color: '#aaa', fontWeight: 500, marginBottom: 4 }}>Active Add-Ons</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: BLUE }}>{dashStats.activeAddOnsCount ?? 0}</div>
          </div>
        </div>
      )}

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

      {/* Order breakdown donuts */}
      <div className="rep-donuts" style={{ display: 'flex', gap: 20, marginBottom: 28 }}>
        <Donut title="Fulfillment Type" data={fulfillment} loading={chartLoading} />
        <Donut title="Order Source" data={source} loading={chartLoading} />
      </div>

      {/* Disco Cater Marketplace Performance */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: '0 0 2px' }}>🪩 Disco Cater Marketplace Performance</h2>
        <p style={{ fontSize: 13, color: '#888', margin: '0 0 14px' }}>
          Orders and revenue attributed to the Disco Cater marketplace (sourceoforder: DISCO)
        </p>
        {!chartLoading && mkt.orders === 0 ? (
          <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 12, padding: '18px 20px', fontSize: 14, color: '#555', lineHeight: 1.6 }}>
            No marketplace orders in this period.{' '}
            {slug
              ? <>Your restaurant appears at <a href={`https://discocater.com/restaurants/${slug}`} target="_blank" rel="noopener noreferrer" style={{ color: ACCENT }}>discocater.com/restaurants/{slug}</a></>
              : <>Your restaurant appears at <a href="https://discocater.com/restaurants" target="_blank" rel="noopener noreferrer" style={{ color: ACCENT }}>discocater.com/restaurants</a></>}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
            <MktCard title="Marketplace Orders" value={mkt.orders.toLocaleString()} loading={chartLoading} />
            <MktCard title="Marketplace Revenue" value={fmt(mkt.revenue)} loading={chartLoading} />
            <MktCard title="Lead Gen Fees" value={fmt(leadGenFees)} loading={saleLoading} />
            <MktCard title="Marketplace Share" value={`${mktShare.toFixed(1)}%`} loading={chartLoading} />
          </div>
        )}
      </div>

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
        <Card title="Tax Amount" value={tax} tooltip={taxTooltip} />
        <Card title="# of Orders" value={saleStats.totalOrdersCount} isCurrency={false} />
        <Card title="Avg. Check (Net)" value={saleStats.subtotalOrdersAvg} />
        <Card title="Lead Gen 1" value={saleStats.leadgenonediscofee} />
        <Card title="Lead Gen 2" value={saleStats.leadgentwodiscofee} />
        <Card title="Pickup Tips" value={saleStats.pickupTipsInPrice} />
        <Card title="Self-Delivery" value={saleStats.ownDeliveryPriceSum} />
        <Card title="Self-Delivery Tips" value={saleStats.owndeliveryTipsInPrice} />
        <Card title={deliveryFeeTitle} value={0} />
        <Card title={deliveryTipsTitle} value={deliveryTips} />
        {hasServiceCharge && <Card title={serviceChargeTitle} value={saleStats.serviceChargesSum} />}
        <Card title="Stripe Fees" value={saleStats.stripeFeeSum} gray />
        <Card title="Total Amount" value={saleStats.totalOrdersSum} />
      </div>
    </div>
  )
}
