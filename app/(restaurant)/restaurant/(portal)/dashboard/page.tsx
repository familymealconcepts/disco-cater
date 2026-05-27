'use client'
import { useState, useEffect, useCallback } from 'react'
import GenerateReportButton from '../_components/GenerateReportButton'
import { useSelectedRestaurant } from '../_components/SelectedRestaurantContext'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'

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
  deliveryType?: string
  onlineOrderingAllowed?: boolean
  doorDashAllowed?: boolean
  deliveryAllowed?: boolean
  feeCategories?: { displayFeeCategoriesName: string }[]
  admin?: { phoneNumber?: string }
}

function fmt(n: number | undefined) {
  if (n === undefined || n === null) return '$0.00'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
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

interface LocationOption {
  reference: string
  businessName: string
}

export default function DashboardPage() {
  const today = new Date().toISOString().split('T')[0]
  const firstOfMonth = (() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0]
  })()
  const [fromDate, setFromDate] = useState(firstOfMonth)
  const [toDate, setToDate] = useState(today)
  const [dateType, setDateType] = useState<'orderDate' | 'createdDate'>('orderDate')
  const [saleStats, setSaleStats] = useState<SaleStats>({})
  const [dashStats, setDashStats] = useState<DashStats>({})
  const [restaurant, setRestaurant] = useState<Restaurant>({})
  const [loading, setLoading] = useState(true)
  const [saleLoading, setSaleLoading] = useState(false)

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

  const loadSaleStats = useCallback(async () => {
    if (!fromDate || !toDate) return
    // SA / SUPER_ADMIN must pick a restaurant first — the proxy's
    // aggregate path was returning 400 on the deployed FM, so we no
    // longer fire the no-ref call. ADMIN role always has a restaurant
    // (their JWT carries it) so the fetch always proceeds for them.
    if (isSystemAdmin && !selectedRef) {
      setSaleStats({})
      return
    }
    setSaleLoading(true)
    const params = new URLSearchParams({ fromDate, toDate, dateType })
    if (selectedRef) params.set('restaurantReference', selectedRef)
    try {
      const res = await fetch(`/api/restaurant/dashboard/sale-stats?${params}`)
      if (res.ok) setSaleStats(await res.json())
    } finally {
      setSaleLoading(false)
    }
  }, [fromDate, toDate, dateType, selectedRef, isSystemAdmin])

  // Fetch on mount and whenever the SYSTEM_ADMIN restaurant context
  // changes — but NOT on every date / dateType input change. Those
  // wait for an explicit Generate Report click.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadSaleStats() }, [selectedRef])

  async function changeRestaurant(ref: string) {
    setSwitching(true)
    try {
      if (ref) {
        const loc = locations.find(l => l.reference === ref)
        await pickRestaurant(ref, loc?.businessName)
      } else {
        await clearRestaurant()
      }
      // Sidebar + any other consumer updates automatically via context.
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

  function clearDates() {
    setFromDate(firstOfMonth)
    setToDate(today)
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 28 }}>
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

      {/* Date Filter */}
      <div style={{ background: '#fff', borderRadius: 12, padding: '20px 24px', border: '1px solid #eee', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>From</label>
            <input
              type="date" value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              disabled={saleLoading}
              style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', opacity: saleLoading ? 0.6 : 1 }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>To</label>
            <input
              type="date" value={toDate}
              onChange={e => setToDate(e.target.value)}
              disabled={saleLoading}
              style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', opacity: saleLoading ? 0.6 : 1 }}
            />
          </div>
          <GenerateReportButton onClick={loadSaleStats} loading={saleLoading} disabled={isSystemAdmin && !selectedRef} />
          {(fromDate !== firstOfMonth || toDate !== today) && !saleLoading && (
            <button onClick={clearDates} style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 7, padding: '7px 12px', fontSize: 12, cursor: 'pointer', fontFamily: F }}>
              Clear
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginLeft: 8 }}>
            {(['orderDate', 'createdDate'] as const).map(v => (
              <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: saleLoading ? 'not-allowed' : 'pointer', color: '#555', opacity: saleLoading ? 0.6 : 1 }}>
                <input type="radio" name="dateType" value={v} checked={dateType === v} onChange={() => setDateType(v)} disabled={saleLoading} />
                {v === 'orderDate' ? 'Order Date' : 'Created Date'}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Restaurant gate: SA / SUPER_ADMIN must pick a restaurant from
          the top-right dropdown before the metrics make sense. The
          per-restaurant FM endpoint 400s on a no-ref call. */}
      {isSystemAdmin && !selectedRef && (
        <div style={{ background: '#fff', border: '1px dashed #d8d8e4', borderRadius: 12, padding: '32px 24px', textAlign: 'center', color: '#555', fontSize: 13, lineHeight: 1.55 }}>
          <div style={{ fontSize: 26, marginBottom: 8 }}>📊</div>
          <div style={{ fontWeight: 700, color: DARK, marginBottom: 4 }}>Select a restaurant to generate a report</div>
          <div style={{ fontSize: 12, color: '#777' }}>Use the Restaurant dropdown above — once a location is picked, Generate Report will populate the metrics.</div>
        </div>
      )}

      {/* Metric Cards — hidden while gated */}
      {(!isSystemAdmin || selectedRef) && (
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
      )}
    </div>
  )
}
