'use client'
import { useState, useEffect, useCallback } from 'react'

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

export default function DashboardPage() {
  const today = new Date().toISOString().split('T')[0]
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [dateType, setDateType] = useState<'orderDate' | 'createdDate'>('orderDate')
  const [saleStats, setSaleStats] = useState<SaleStats>({})
  const [dashStats, setDashStats] = useState<DashStats>({})
  const [restaurant, setRestaurant] = useState<Restaurant>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/restaurant/profile').then(r => r.ok ? r.json() : {}),
      fetch('/api/restaurant/dashboard/stats').then(r => r.ok ? r.json() : {}),
    ]).then(([rest, stats]) => {
      setRestaurant(rest || {})
      setDashStats(stats || {})
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const loadSaleStats = useCallback(async () => {
    if (!fromDate || !toDate) return
    const params = new URLSearchParams({ fromDate, toDate, dateType })
    const res = await fetch(`/api/restaurant/dashboard/sale-stats?${params}`)
    if (res.ok) setSaleStats(await res.json())
  }, [fromDate, toDate, dateType])

  useEffect(() => { loadSaleStats() }, [loadSaleStats])

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
    setFromDate(today)
    setToDate(today)
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>
          Reporting
          {restaurant.businessName && (
            <span style={{ fontWeight: 400, color: '#888', fontSize: 16, marginLeft: 8 }}>
              ({restaurant.businessName})
            </span>
          )}
        </h1>
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
              style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>To</label>
            <input
              type="date" value={toDate}
              onChange={e => setToDate(e.target.value)}
              style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none' }}
            />
          </div>
          {(fromDate !== today || toDate !== today) && (
            <button onClick={clearDates} style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 7, padding: '7px 12px', fontSize: 12, cursor: 'pointer', fontFamily: F }}>
              Clear
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginLeft: 8 }}>
            {(['orderDate', 'createdDate'] as const).map(v => (
              <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#555' }}>
                <input type="radio" name="dateType" value={v} checked={dateType === v} onChange={() => setDateType(v)} />
                {v === 'orderDate' ? 'Order Date' : 'Created Date'}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Metric Cards */}
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
