'use client'
import { useState, useEffect, useCallback } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'
const PAGE_BG = '#F7F8FC'

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
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [loading, setLoading] = useState(true)
  const [showRestaurantPicker, setShowRestaurantPicker] = useState(false)

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

  function clearFilters() {
    setFromDate('')
    setToDate('')
    setRestaurantRef('')
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

  const hasFilters = !!(fromDate || toDate || restaurantRef)
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
        setSyncMsg(`✓ ${d.synced} synced (${d.new} new, ${d.updated} updated) · ${d.deactivated} deactivated · ${d.skipped} skipped${errs ? ` · ${errs} errors` : ''}`)
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

        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={inputSt} />
        <span style={{ color: '#888' }}>→</span>
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={inputSt} />

        {hasFilters && (
          <button onClick={clearFilters} style={clearBtn}>Clear</button>
        )}
        {loading && <span style={{ fontSize: 12, color: '#aaa', marginLeft: 'auto' }}>Loading…</span>}
      </div>

      {/* Sale stats — top block (matches FM template 2-87) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginTop: 18 }}>
        <SaleCard title="Platform Fees" value={saleRaw.feeSum} />
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
const clearBtn: React.CSSProperties = { background: 'transparent', border: '1px solid #ddd', borderRadius: 7, padding: '6px 12px', fontSize: 12, cursor: 'pointer', fontFamily: F, color: DARK }
const pickerItem = (active: boolean): React.CSSProperties => ({
  display: 'block', width: '100%', textAlign: 'left',
  background: active ? 'rgba(239,184,74,0.15)' : 'transparent',
  border: 'none', padding: '7px 12px', fontSize: 13, fontFamily: F, color: DARK,
  cursor: 'pointer', borderRadius: 6, marginBottom: 1,
  fontWeight: active ? 600 : 400,
})
