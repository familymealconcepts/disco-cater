'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import GlobalHeader from '../../components/GlobalHeader'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const BLUE = '#5B6FE8'
const DARK = '#1A1028'

interface Package {
  reference: string
  name: string
  description?: string
  price: number
  serves?: number
  image?: string
  minimumOrderAmount?: number
  advanceNoticeHours?: number
  orderTypes?: string[]
}

interface MenuItem {
  name: string
  description?: string
  price?: number
  image?: string
}

interface MenuCategory {
  name: string
  items?: MenuItem[]
  menuItems?: MenuItem[]
}

interface Restaurant {
  name: string
  address: string
  cuisine: string
  cuisines?: string[]
  description: string
  image?: any
  orderUrl: string
  isDisco: boolean
  location: string
  tags?: string[]
}

function fmtDateParts(d: string) {
  try {
    const obj = new Date(d + 'T12:00:00')
    return {
      wday: obj.toLocaleDateString('en-US', { weekday: 'short' }),
      mday: obj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    }
  } catch { return { wday: '', mday: d } }
}

function fmtTime(t: string) {
  try {
    const [h, m] = t.split(':').map(Number)
    const d = new Date(); d.setHours(h, m)
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  } catch { return t }
}

export default function RestaurantClient({
  restaurant,
  restaurantRef,
  slug,
}: {
  restaurant: Restaurant
  restaurantRef: string | null
  slug: string
}) {
  const router = useRouter()

  const [packages, setPackages] = useState<Package[]>([])
  const [categories, setCategories] = useState<MenuCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [imgError, setImgError] = useState(false)
  const [activeTab, setActiveTab] = useState('Catering Packages')
  const [banner, setBanner] = useState<{ advanceHours?: number; minAmount?: number; orderTypes?: string[] } | null>(null)

  // Modal state
  const [modalPkg, setModalPkg] = useState<Package | null>(null)
  const [orderType, setOrderType] = useState<'DELIVERY' | 'PICKUP'>('DELIVERY')
  const [dates, setDates] = useState<string[]>([])
  const [times, setTimes] = useState<string[]>([])
  const [selDate, setSelDate] = useState('')
  const [selTime, setSelTime] = useState('')
  const [datesLoading, setDatesLoading] = useState(false)
  const [timesLoading, setTimesLoading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startErr, setStartErr] = useState('')

  useEffect(() => {
    if (!restaurantRef) { setLoading(false); return }

    fetch(`/api/fm-packages?ref=${restaurantRef}`)
      .then(r => r.json())
      .then((data: any) => {
        const pkgs: Package[] = Array.isArray(data) ? data : []
        setPackages(pkgs)
        // Parse banner info from package metadata
        const allTypes = [...new Set(pkgs.flatMap((p: any) => p.orderTypes ?? []))] as string[]
        const first: any = pkgs[0] ?? {}
        const b: any = {}
        if (first.advanceNoticeHours) b.advanceHours = first.advanceNoticeHours
        if (first.minimumOrderAmount) b.minAmount = first.minimumOrderAmount
        if (allTypes.length) b.orderTypes = allTypes
        if (Object.keys(b).length) setBanner(b)
        setLoading(false)
      })
      .catch(() => setLoading(false))

    fetch(`/api/fm-menu?ref=${restaurantRef}`)
      .then(r => r.json())
      .then((data: any) => {
        let cats: MenuCategory[] = []
        if (Array.isArray(data?.categories)) cats = data.categories
        else if (Array.isArray(data?.menuCategories)) cats = data.menuCategories
        else if (Array.isArray(data)) cats = data
        // Normalize items field; exclude Catering Packages (we render those ourselves)
        cats = cats
          .map(c => ({ ...c, items: c.items ?? c.menuItems ?? [] }))
          .filter(c => !['Catering Packages', 'Catering Menu'].includes(c.name))
        setCategories(cats)
        // Also try to extract banner data from menu-level fields
        if (data?.minimumOrderAmount || data?.advanceNoticeHours) {
          setBanner(prev => ({
            ...prev,
            ...(data.advanceNoticeHours ? { advanceHours: data.advanceNoticeHours } : {}),
            ...(data.minimumOrderAmount ? { minAmount: data.minimumOrderAmount } : {}),
          }))
        }
      })
      .catch(() => {})
  }, [restaurantRef])

  // Fetch dates when modal opens with a package
  useEffect(() => {
    if (!modalPkg) return
    setDatesLoading(true); setDates([]); setSelDate(''); setTimes([]); setSelTime('')
    fetch(`/api/order/dates?packageRef=${modalPkg.reference}`)
      .then(r => r.json())
      .then((d: any) => {
        const arr: any[] = Array.isArray(d) ? d : d?.dates ?? d?.availableDates ?? []
        setDates(arr.map((x: any) => typeof x === 'string' ? x : x.date || x.localDate || '').filter(Boolean))
        setDatesLoading(false)
      })
      .catch(() => setDatesLoading(false))
  }, [modalPkg])

  // Fetch times when date is selected
  useEffect(() => {
    if (!modalPkg || !selDate) return
    setTimesLoading(true); setTimes([]); setSelTime('')
    fetch(`/api/order/times?packageRef=${modalPkg.reference}&date=${selDate}`)
      .then(r => r.json())
      .then((d: any) => {
        const arr: any[] = Array.isArray(d) ? d : d?.times ?? d?.availableTimes ?? d?.pickUpTimes ?? []
        setTimes(arr.map((x: any) => typeof x === 'string' ? x : x.time || x.localTime || '').filter(Boolean))
        setTimesLoading(false)
      })
      .catch(() => setTimesLoading(false))
  }, [modalPkg, selDate])

  async function handleStartOrder() {
    if (!modalPkg || !selDate || !selTime || !restaurantRef) return
    setStarting(true); setStartErr('')
    try {
      const res = await fetch('/api/order/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantRef,
          mealPackageReference: modalPkg.reference,
          localDate: selDate,
          localTime: selTime,
          persons: 10,
          orderType,
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        setStartErr(data.error || data.message || 'Failed to start order. Please try again.')
        setStarting(false); return
      }
      const orderRef = data.reference || data.orderReference || data.orderRef || data.id || data.ref || ''
      const params = new URLSearchParams({
        package: modalPkg.reference,
        date: selDate,
        time: selTime,
        orderType,
        ...(orderRef ? { orderRef } : {}),
      })
      router.push(`/restaurants/${slug}/order?${params}`)
    } catch {
      setStartErr('Something went wrong. Please try again.')
      setStarting(false)
    }
  }

  function openModal(pkg: Package) {
    setModalPkg(pkg); setStartErr(''); setSelDate(''); setSelTime('')
    setDates([]); setTimes([])
    if (banner?.orderTypes?.length) {
      setOrderType(banner.orderTypes.includes('DELIVERY') ? 'DELIVERY' : 'PICKUP')
    }
  }

  const imageUrl = restaurant.image?.asset?._ref
    ? `https://cdn.sanity.io/images/0j4eqnmw/production/${restaurant.image.asset._ref
        .replace(/^image-/, '')
        .replace(/-([a-z]+)$/, '.$1')}`
    : null

  const tags = restaurant.cuisines?.length ? restaurant.cuisines : restaurant.cuisine ? [restaurant.cuisine] : []

  const allTabs = ['Catering Packages', ...categories.map(c => c.name)]

  const bannerParts: string[] = []
  if (banner?.advanceHours) bannerParts.push(`${banner.advanceHours} hour notice`)
  if (banner?.minAmount) bannerParts.push(`$${Math.round(banner.minAmount / 100)} order minimum`)
  if (banner?.orderTypes?.length) {
    const labels = banner.orderTypes.map(t => t === 'PICKUP' ? 'Pickup' : t === 'DELIVERY' ? 'Delivery' : t)
    bannerParts.push(labels.join(' & ') + ' available')
  }

  const activeCatItems: MenuItem[] = activeTab !== 'Catering Packages'
    ? (categories.find(c => c.name === activeTab)?.items ?? [])
    : []

  return (
    <div style={{ minHeight: '100svh', background: '#f8f8fc', fontFamily: F }}>
      <GlobalHeader />

      {/* Dynamic info banner */}
      {bannerParts.length > 0 && (
        <div style={{ background: DARK, color: 'rgba(255,255,255,0.82)', fontSize: 12, fontWeight: 500, textAlign: 'center', padding: '8px 16px', letterSpacing: '0.02em' }}>
          {bannerParts.join('  ·  ')}
        </div>
      )}

      {/* Restaurant header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 24px 0' }}>
          <Link href="/fullmap" style={{ fontSize: 12, color: '#888', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 16 }}>
            ← Back to Catering Map
          </Link>

          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 20 }}>
            <div style={{ width: 80, height: 80, borderRadius: 14, overflow: 'hidden', flexShrink: 0, background: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>
              {imageUrl && !imgError
                ? <img src={imageUrl} alt={restaurant.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setImgError(true)} />
                : '🍽️'}
            </div>
            <div style={{ flex: 1 }}>
              {restaurant.isDisco && (
                <div style={{ display: 'inline-block', background: GRAD, color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 10px', borderRadius: 20, marginBottom: 6, letterSpacing: '0.05em' }}>
                  🪩 PREMIUM
                </div>
              )}
              <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, margin: '0 0 4px', letterSpacing: '-0.02em' }}>{restaurant.name}</h1>
              <div style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>📍 {restaurant.location || restaurant.address}</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {tags.map(t => (
                  <span key={t} style={{ background: '#f0f0f0', color: '#555', fontSize: 11, padding: '2px 9px', borderRadius: 20, fontWeight: 500 }}>{t}</span>
                ))}
                {restaurant.tags?.map(t => (
                  <span key={t} style={{ background: '#EEEDFE', color: '#3C3489', fontSize: 11, padding: '2px 9px', borderRadius: 20, fontWeight: 500 }}>{t}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Category tabs */}
          {!loading && allTabs.length > 0 && (
            <div style={{ display: 'flex', gap: 0, overflowX: 'auto', borderTop: '1px solid #f0f0f0', WebkitOverflowScrolling: 'touch' as any }}>
              {allTabs.map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  style={{
                    padding: '11px 18px', background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 13, fontWeight: activeTab === tab ? 700 : 500,
                    color: activeTab === tab ? BLUE : '#666',
                    borderBottom: `2px solid ${activeTab === tab ? BLUE : 'transparent'}`,
                    fontFamily: F, whiteSpace: 'nowrap', flexShrink: 0, transition: 'color 0.15s',
                  }}>
                  {tab}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Two-panel body */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 24px 100px', display: 'flex', gap: 28, alignItems: 'flex-start' }}>

        {/* Left panel — menu */}
        <div style={{ flex: 1, minWidth: 0 }}>

          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[1, 2, 3].map(i => (
                <div key={i} style={{ height: 120, background: '#fff', borderRadius: 14, border: '1.5px solid #f0f0f0', animation: 'pulse 1.5s infinite' }} />
              ))}
            </div>
          )}

          {/* Catering Packages tab */}
          {!loading && activeTab === 'Catering Packages' && (
            packages.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '56px 0' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🍽️</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: '#888', marginBottom: 8 }}>Menu details coming soon</div>
                <div style={{ fontSize: 14, color: '#aaa', marginBottom: 24 }}>Contact the restaurant directly to discuss catering options</div>
                {restaurant.orderUrl && (
                  <a href={restaurant.orderUrl} target="_blank" rel="noopener noreferrer"
                    style={{ background: BLUE, color: '#fff', padding: '12px 24px', borderRadius: 10, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
                    View on FamilyMeal →
                  </a>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {packages.map(pkg => (
                  <div key={pkg.reference}
                    style={{ background: '#fff', borderRadius: 14, border: '1.5px solid #f0f0f0', overflow: 'hidden', display: 'flex', transition: 'box-shadow 0.15s' }}
                    onMouseOver={e => (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.07)'}
                    onMouseOut={e => (e.currentTarget as HTMLElement).style.boxShadow = 'none'}
                  >
                    {pkg.image && (
                      <img src={pkg.image} alt={pkg.name} style={{ width: 130, height: 130, objectFit: 'cover', flexShrink: 0 }} />
                    )}
                    <div style={{ flex: 1, padding: '18px 20px', display: 'flex', gap: 16, alignItems: 'center' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 3 }}>{pkg.name}</div>
                        {pkg.serves && <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>Serves {pkg.serves}</div>}
                        {pkg.description && (
                          <p style={{ fontSize: 13, color: '#666', lineHeight: 1.5, margin: 0 }}>{pkg.description}</p>
                        )}
                      </div>
                      <div style={{ flexShrink: 0, textAlign: 'right' }}>
                        <div style={{ fontSize: 18, fontWeight: 800, color: DARK, marginBottom: 10 }}>
                          ${(pkg.price / 100).toFixed(2)}
                          <span style={{ fontSize: 11, fontWeight: 400, color: '#888' }}>/pp</span>
                        </div>
                        {restaurantRef && (
                          <button onClick={() => openModal(pkg)}
                            style={{ background: BLUE, color: '#fff', padding: '9px 18px', borderRadius: 10, fontSize: 13, fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: F, boxShadow: '0 2px 8px rgba(91,111,232,0.25)', whiteSpace: 'nowrap' }}>
                            Order →
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {/* Other category tabs (informational, no ordering) */}
          {!loading && activeTab !== 'Catering Packages' && (
            activeCatItems.length === 0 ? (
              <div style={{ color: '#888', fontSize: 14, padding: '40px 0', textAlign: 'center' }}>No items in this category.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activeCatItems.map((item, i) => (
                  <div key={i} style={{ background: '#fff', borderRadius: 14, border: '1.5px solid #f0f0f0', overflow: 'hidden', display: 'flex' }}>
                    {item.image && (
                      <img src={item.image} alt={item.name} style={{ width: 100, height: 100, objectFit: 'cover', flexShrink: 0 }} />
                    )}
                    <div style={{ flex: 1, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 3 }}>{item.name}</div>
                        {item.description && <p style={{ fontSize: 13, color: '#666', lineHeight: 1.5, margin: 0 }}>{item.description}</p>}
                      </div>
                      {item.price != null && (
                        <div style={{ fontSize: 15, fontWeight: 700, color: DARK, flexShrink: 0 }}>${(item.price / 100).toFixed(2)}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        {/* Right panel — sticky order summary (desktop only) */}
        {restaurantRef && (
          <div className="order-sidebar" style={{ width: 300, flexShrink: 0 }}>
            <div style={{ position: 'sticky', top: 80, background: '#fff', borderRadius: 16, border: '1.5px solid #f0f0f0', overflow: 'hidden', boxShadow: '0 4px 24px rgba(0,0,0,0.06)' }}>
              <div style={{ padding: '18px 20px', borderBottom: '1px solid #f0f0f0' }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: DARK, marginBottom: 2 }}>Order Summary</div>
                <div style={{ fontSize: 12, color: '#888' }}>{restaurant.name}</div>
              </div>
              <div style={{ padding: '20px' }}>
                {!loading && packages.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#aaa', fontSize: 13, padding: '8px 0' }}>
                    Contact the restaurant to order
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 13, color: '#888', textAlign: 'center', lineHeight: 1.5, marginBottom: 18 }}>
                      Select a package from the menu and click <strong style={{ color: DARK }}>Order</strong> to get started
                    </div>
                    <button
                      onClick={() => packages[0] && openModal(packages[0])}
                      disabled={packages.length === 0 || loading}
                      style={{
                        width: '100%', padding: '13px', background: BLUE, color: '#fff', border: 'none',
                        borderRadius: 12, fontSize: 14, fontWeight: 700,
                        cursor: packages.length > 0 && !loading ? 'pointer' : 'not-allowed',
                        fontFamily: F, opacity: packages.length > 0 && !loading ? 1 : 0.45,
                        boxShadow: '0 4px 14px rgba(91,111,232,0.25)',
                      }}>
                      Order Catering →
                    </button>
                  </>
                )}
              </div>
              {restaurant.description && (
                <div style={{ padding: '0 20px 20px', borderTop: '1px solid #f0f0f0' }}>
                  <p style={{ fontSize: 12, color: '#999', lineHeight: 1.6, margin: 0 }}>{restaurant.description}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mobile sticky order bar */}
      {restaurantRef && packages.length > 0 && (
        <div className="mobile-order-bar"
          style={{ display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0, padding: '12px 16px', background: '#fff', borderTop: '1px solid #f0f0f0', boxShadow: '0 -4px 16px rgba(0,0,0,0.06)', zIndex: 100 }}>
          <button onClick={() => openModal(packages[0])}
            style={{ width: '100%', padding: '15px', background: BLUE, color: '#fff', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: F, boxShadow: '0 4px 14px rgba(91,111,232,0.25)' }}>
            Order Catering →
          </button>
        </div>
      )}

      {/* Ordering Modal */}
      {modalPkg && (
        <div onClick={() => setModalPkg(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 20, padding: '28px 28px 24px', maxWidth: 460, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>

            {/* Modal header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22 }}>
              <div>
                <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Catering Menu</div>
                <h2 style={{ fontSize: 19, fontWeight: 800, color: DARK, margin: '0 0 4px' }}>{modalPkg.name}</h2>
                <div style={{ fontSize: 13, color: '#666' }}>
                  ${(modalPkg.price / 100).toFixed(2)}/pp
                  {modalPkg.serves ? ` · Serves up to ${modalPkg.serves}` : ''}
                </div>
              </div>
              <button onClick={() => setModalPkg(null)}
                style={{ background: '#f0f0f0', border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                ×
              </button>
            </div>

            {/* Pickup / Delivery toggle */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Order Type</div>
              <div style={{ display: 'flex', background: '#f4f4f4', borderRadius: 10, padding: 3, gap: 3 }}>
                {(['DELIVERY', 'PICKUP'] as const).map(type => (
                  <button key={type} onClick={() => setOrderType(type)}
                    style={{
                      flex: 1, padding: '9px', border: 'none', borderRadius: 8, cursor: 'pointer',
                      background: orderType === type ? '#fff' : 'transparent',
                      color: orderType === type ? DARK : '#888',
                      fontFamily: F, fontSize: 13, fontWeight: orderType === type ? 700 : 500,
                      boxShadow: orderType === type ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
                      transition: 'all 0.15s',
                    }}>
                    {type === 'DELIVERY' ? '🚚 Delivery' : '🏃 Pickup'}
                  </button>
                ))}
              </div>
            </div>

            {/* Date picker */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Select Date</div>
              {datesLoading ? (
                <div style={{ color: '#aaa', fontSize: 13 }}>Loading available dates…</div>
              ) : dates.length === 0 ? (
                <div style={{ color: '#aaa', fontSize: 13 }}>No upcoming dates available for this package.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                  {dates.map(d => {
                    const { wday, mday } = fmtDateParts(d)
                    const sel = d === selDate
                    return (
                      <button key={d} onClick={() => setSelDate(d)}
                        style={{
                          padding: '7px 12px', borderRadius: 10, border: `2px solid ${sel ? BLUE : '#e8e8e8'}`,
                          background: sel ? '#EEF0FD' : '#fff', cursor: 'pointer', fontFamily: F, textAlign: 'center', transition: 'all 0.1s',
                        }}>
                        <div style={{ fontSize: 10, color: sel ? '#6B6EF9' : '#bbb', marginBottom: 1 }}>{wday}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: sel ? BLUE : DARK }}>{mday}</div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Time picker */}
            {selDate && (
              <div style={{ marginBottom: 22 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Select Time</div>
                {timesLoading ? (
                  <div style={{ color: '#aaa', fontSize: 13 }}>Loading available times…</div>
                ) : times.length === 0 ? (
                  <div style={{ color: '#aaa', fontSize: 13 }}>No times available for this date.</div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                    {times.map(t => {
                      const sel = t === selTime
                      return (
                        <button key={t} onClick={() => setSelTime(t)}
                          style={{
                            padding: '9px 15px', borderRadius: 10, border: `2px solid ${sel ? BLUE : '#e8e8e8'}`,
                            background: sel ? '#EEF0FD' : '#fff', color: sel ? BLUE : DARK,
                            fontFamily: F, fontSize: 13, fontWeight: sel ? 700 : 500, cursor: 'pointer', transition: 'all 0.1s',
                          }}>
                          {fmtTime(t)}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {startErr && (
              <div style={{ background: '#FEF2F2', border: '1.5px solid #FCA5A5', borderRadius: 10, padding: '11px 14px', marginBottom: 14, color: '#991B1B', fontSize: 13 }}>
                {startErr}
              </div>
            )}

            <button onClick={handleStartOrder}
              disabled={!selDate || !selTime || starting}
              style={{
                width: '100%', padding: '14px', background: BLUE, color: '#fff', border: 'none',
                borderRadius: 12, fontSize: 15, fontWeight: 700,
                cursor: (!selDate || !selTime || starting) ? 'not-allowed' : 'pointer',
                fontFamily: F, opacity: (!selDate || !selTime || starting) ? 0.5 : 1,
                boxShadow: '0 4px 16px rgba(91,111,232,0.25)',
              }}>
              {starting ? 'Starting Order…' : 'Start Order →'}
            </button>

            {!selDate && !datesLoading && dates.length > 0 && (
              <div style={{ textAlign: 'center', fontSize: 12, color: '#bbb', marginTop: 10 }}>Select a date to continue</div>
            )}
            {selDate && !selTime && !timesLoading && times.length > 0 && (
              <div style={{ textAlign: 'center', fontSize: 12, color: '#bbb', marginTop: 10 }}>Select a time to continue</div>
            )}
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
        @media (max-width: 768px) {
          .order-sidebar { display: none !important; }
          .mobile-order-bar { display: block !important; }
        }
      `}</style>
    </div>
  )
}
