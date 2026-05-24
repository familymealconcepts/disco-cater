'use client'
import { useState } from 'react'
import Link from 'next/link'
import GlobalHeader from '../../components/GlobalHeader'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const DARK = '#1A1028'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FmSchedule {
  prepTime: number
  cutOff?: string
  startDate?: string
  endDate?: string
}

interface FmSettings {
  pickupOrderMinimum?: number
  deliveryOrderMinimum?: number
  menuAvailability?: string[]
}

interface FmMenu {
  reference: string
  name: string
  scheduleOption?: FmSchedule
  settings?: FmSettings
}

interface FmPackage {
  reference: string
  name: string
  description?: string | null
  price: number      // dollars
  serves?: string | number | null
  image?: { name: string; availableResolutions?: number[] } | null
  available?: boolean
  allowedSpecialInstructions?: boolean
  extraItemsGroups?: any[]
}

interface FmCategory {
  reference: string
  name: string
  mealPackages: FmPackage[]
}

interface MenuSection {
  menu: FmMenu
  categories: FmCategory[]
}

interface Restaurant {
  name: string
  address?: string
  cuisine?: string
  cuisines?: string[]
  description?: string
  image?: any
  orderUrl?: string
  isDisco?: boolean
  location?: string
  tags?: string[]
}

interface CartItem {
  pkg: FmPackage
  menuName: string
  quantity: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RestaurantClient({
  restaurant,
  fmSlug,
  fmRef,
  menuData,
  slug,
}: {
  restaurant: Restaurant
  fmSlug: string | null
  fmRef: string | null
  menuData: MenuSection[]
  slug: string
}) {
  const [activeMenuIdx, setActiveMenuIdx] = useState(0)
  const [cart, setCart] = useState<CartItem[]>([])
  const [imgError, setImgError] = useState(false)
  const [mobileCartOpen, setMobileCartOpen] = useState(false)

  const activeSection = menuData[activeMenuIdx]
  const firstMenu = menuData[0]?.menu

  // ── Announcement bar data ──────────────────────────────────────────────────
  const announcements: string[] = []
  if (firstMenu?.scheduleOption?.prepTime) {
    announcements.push(`${firstMenu.scheduleOption.prepTime}hr advance notice`)
  }
  const minAmount = firstMenu?.settings?.pickupOrderMinimum ?? firstMenu?.settings?.deliveryOrderMinimum
  if (minAmount) announcements.push(`${fmt$(minAmount)} minimum`)
  const avail = firstMenu?.settings?.menuAvailability ?? []
  if (avail.length) {
    const labels = avail.map(t => t === 'PICKUP' ? 'Pickup' : t === 'DELIVERY' ? 'Delivery' : t)
    announcements.push(labels.join(' & '))
  }

  // ── Cart helpers ───────────────────────────────────────────────────────────
  const cartTotal = cart.reduce((sum, i) => sum + i.pkg.price * i.quantity, 0)
  const cartCount = cart.reduce((sum, i) => sum + i.quantity, 0)

  function addToCart(pkg: FmPackage, menuName: string) {
    setCart(prev => {
      const idx = prev.findIndex(i => i.pkg.reference === pkg.reference)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 }
        return next
      }
      return [...prev, { pkg, menuName, quantity: 1 }]
    })
  }

  function updateQty(ref: string, delta: number) {
    setCart(prev =>
      prev
        .map(i => i.pkg.reference === ref ? { ...i, quantity: i.quantity + delta } : i)
        .filter(i => i.quantity > 0)
    )
  }

  const cartInPkg = (ref: string) => cart.find(i => i.pkg.reference === ref)?.quantity ?? 0

  // ── Sanity image ───────────────────────────────────────────────────────────
  const sanityImageUrl = restaurant.image?.asset?._ref
    ? `https://cdn.sanity.io/images/0j4eqnmw/production/${
        restaurant.image.asset._ref.replace(/^image-/, '').replace(/-([a-z]+)$/, '.$1')
      }`
    : null

  const tags = restaurant.cuisines?.length
    ? restaurant.cuisines
    : restaurant.cuisine ? [restaurant.cuisine] : []

  // ── Cart sidebar (reused in desktop + mobile overlay) ─────────────────────
  const cartSidebar = (
    <div style={{ padding: '0 0 20px' }}>
      {cart.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 20px', color: '#bbb', fontSize: 13, lineHeight: 1.7 }}>
          Browse the menu and click<br /><strong style={{ color: '#aaa' }}>Add to Order</strong> to get started
        </div>
      ) : (
        <div style={{ padding: '0 16px' }}>
          {cart.map(item => (
            <div key={item.pkg.reference}
              style={{ padding: '12px 0', borderBottom: '1px solid #f4f4f4', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: DARK, lineHeight: 1.3, marginBottom: 3 }}>{item.pkg.name}</div>
                <div style={{ fontSize: 12, color: '#888' }}>{fmt$(item.pkg.price)}/pp</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <button onClick={() => updateQty(item.pkg.reference, -1)}
                  style={{ width: 24, height: 24, borderRadius: 6, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 16, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>
                <span style={{ fontSize: 13, fontWeight: 700, color: DARK, minWidth: 20, textAlign: 'center' }}>{item.quantity}</span>
                <button onClick={() => updateQty(item.pkg.reference, 1)}
                  style={{ width: 24, height: 24, borderRadius: 6, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 16, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: DARK, flexShrink: 0, minWidth: 48, textAlign: 'right' }}>
                {fmt$(item.pkg.price * item.quantity)}
              </div>
            </div>
          ))}

          <div style={{ padding: '14px 0 4px', display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 800, color: DARK }}>
            <span>Subtotal</span>
            <span>{fmt$(cartTotal)}</span>
          </div>
          <div style={{ fontSize: 11, color: '#bbb', marginBottom: 16, textAlign: 'right' }}>
            Before tax, delivery & tip
          </div>
        </div>
      )}

      <div style={{ padding: '0 16px' }}>
        {fmSlug ? (
          // TODO: replace with native Stripe checkout flow once dates/times API format is resolved
          <a href={`https://www.familymeal.com/disco/${fmSlug}`} target="_blank" rel="noopener noreferrer"
            style={{
              display: 'block', textAlign: 'center', padding: '13px',
              background: cart.length > 0 ? BLUE : '#e8e8e8',
              color: cart.length > 0 ? '#fff' : '#bbb',
              borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none',
              boxShadow: cart.length > 0 ? '0 4px 14px rgba(91,111,232,0.25)' : 'none',
              fontFamily: F, transition: 'all 0.15s',
            }}>
            Place Order →
          </a>
        ) : (
          <div style={{ textAlign: 'center', fontSize: 13, color: '#bbb', padding: '12px 0' }}>
            Contact restaurant to order
          </div>
        )}
      </div>
    </div>
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100svh', background: '#f8f8fc', fontFamily: F }}>
      <GlobalHeader />

      {/* Announcement bar */}
      {announcements.length > 0 && (
        <div style={{ background: DARK, color: 'rgba(255,255,255,0.78)', fontSize: 12, fontWeight: 500, textAlign: 'center', padding: '8px 16px', letterSpacing: '0.03em' }}>
          {announcements.join('  ·  ')}
        </div>
      )}

      {/* Restaurant header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 24px 0' }}>
          <Link href="/fullmap" style={{ fontSize: 12, color: '#888', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 16 }}>
            ← Back to Catering Map
          </Link>

          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 18 }}>
            <div style={{ width: 80, height: 80, borderRadius: 14, overflow: 'hidden', flexShrink: 0, background: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {sanityImageUrl && !imgError
                ? <img src={sanityImageUrl} alt={restaurant.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setImgError(true)} />
                : <span style={{ fontSize: 32 }}>🍽️</span>}
            </div>
            <div style={{ flex: 1 }}>
              {restaurant.isDisco && (
                <div style={{ display: 'inline-block', background: GRAD, color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 10px', borderRadius: 20, marginBottom: 6, letterSpacing: '0.06em' }}>
                  🪩 PREMIUM
                </div>
              )}
              <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, margin: '0 0 4px', letterSpacing: '-0.02em' }}>
                {restaurant.name}
              </h1>
              <div style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>
                📍 {restaurant.location || restaurant.address}
              </div>
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

          {/* Menu tabs (only if multiple menus) */}
          {menuData.length > 1 && (
            <div style={{ display: 'flex', overflowX: 'auto', borderTop: '1px solid #f0f0f0' }}>
              {menuData.map((section, i) => (
                <button key={section.menu.reference} onClick={() => setActiveMenuIdx(i)}
                  style={{
                    padding: '11px 18px', background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 13, fontWeight: activeMenuIdx === i ? 700 : 500,
                    color: activeMenuIdx === i ? INDIGO : '#666',
                    borderBottom: `2px solid ${activeMenuIdx === i ? INDIGO : 'transparent'}`,
                    fontFamily: F, whiteSpace: 'nowrap', flexShrink: 0, transition: 'color 0.15s',
                  }}>
                  {section.menu.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Two-panel body */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 24px 120px', display: 'flex', gap: 28, alignItems: 'flex-start' }}>

        {/* LEFT: menu */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {menuData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '72px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>🍽️</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: '#666', marginBottom: 8 }}>Menu details coming soon</div>
              <div style={{ fontSize: 14, color: '#aaa' }}>Contact the restaurant to discuss catering options</div>
              {fmSlug && (
                <a href={`https://www.familymeal.com/disco/${fmSlug}`} target="_blank" rel="noopener noreferrer"
                  style={{ display: 'inline-block', marginTop: 20, padding: '11px 22px', background: BLUE, color: '#fff', borderRadius: 10, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
                  Order on FamilyMeal →
                </a>
              )}
            </div>
          ) : (
            activeSection?.categories.map(cat => (
              <div key={cat.reference} style={{ marginBottom: 32 }}>
                {/* Category header (only if multiple categories or single category with a distinct name) */}
                {(activeSection.categories.length > 1 || cat.name !== activeSection.menu.name) && (
                  <h2 style={{ fontSize: 17, fontWeight: 800, color: DARK, margin: '0 0 14px', letterSpacing: '-0.01em' }}>
                    {cat.name}
                  </h2>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}
                  className="pkg-grid">
                  {cat.mealPackages.filter(p => p.available !== false).map(pkg => {
                    const inCart = cartInPkg(pkg.reference)
                    return (
                      <div key={pkg.reference}
                        style={{
                          background: '#fff', borderRadius: 16, overflow: 'hidden',
                          border: `1.5px solid ${inCart > 0 ? BLUE : '#f0f0f0'}`,
                          display: 'flex', flexDirection: 'column',
                          boxShadow: inCart > 0 ? '0 4px 16px rgba(91,111,232,0.12)' : '0 1px 4px rgba(0,0,0,0.04)',
                          transition: 'all 0.15s',
                        }}>

                        {/* Package image placeholder */}
                        {/* TODO: FM image CDN URL pattern unknown — add real images once resolved */}
                        <div style={{
                          height: 140, background: 'linear-gradient(135deg, #f0f0f8 0%, #e8e8f4 100%)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 36,
                          flexShrink: 0,
                        }}>
                          🍱
                        </div>

                        <div style={{ padding: '14px 16px 16px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                          <div style={{ fontSize: 14, fontWeight: 800, color: DARK, marginBottom: 4, lineHeight: 1.3 }}>
                            {pkg.name}
                          </div>
                          {pkg.serves && (
                            <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
                              Serves {pkg.serves}
                            </div>
                          )}
                          {pkg.description && (
                            <p style={{ fontSize: 12, color: '#666', lineHeight: 1.5, margin: '0 0 10px', flex: 1,
                              display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                              {pkg.description}
                            </p>
                          )}

                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto', paddingTop: 8 }}>
                            <div style={{ fontSize: 16, fontWeight: 800, color: BLUE }}>
                              {fmt$(pkg.price)}<span style={{ fontSize: 11, fontWeight: 500, color: '#888' }}>/pp</span>
                            </div>

                            {inCart > 0 ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <button onClick={() => updateQty(pkg.reference, -1)}
                                  style={{ width: 28, height: 28, borderRadius: 7, border: `1.5px solid ${BLUE}`, background: '#fff', cursor: 'pointer', fontSize: 16, color: BLUE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>
                                <span style={{ fontSize: 14, fontWeight: 800, color: BLUE, minWidth: 20, textAlign: 'center' }}>{inCart}</span>
                                <button onClick={() => updateQty(pkg.reference, 1)}
                                  style={{ width: 28, height: 28, borderRadius: 7, border: `1.5px solid ${BLUE}`, background: BLUE, cursor: 'pointer', fontSize: 16, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
                              </div>
                            ) : (
                              <button onClick={() => addToCart(pkg, activeSection.menu.name)}
                                style={{
                                  padding: '7px 14px', background: BLUE, color: '#fff', border: 'none',
                                  borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                                  fontFamily: F, boxShadow: '0 2px 8px rgba(91,111,232,0.25)', whiteSpace: 'nowrap',
                                }}>
                                Add to Order
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* RIGHT: sticky order sidebar */}
        <div className="order-sidebar" style={{ width: 320, flexShrink: 0 }}>
          <div style={{
            position: 'sticky', top: 80, background: '#fff', borderRadius: 16,
            border: '1.5px solid #f0f0f0', overflow: 'hidden',
            boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
            maxHeight: 'calc(100vh - 100px)', overflowY: 'auto',
          }}>
            <div style={{ padding: '16px 16px 14px', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: DARK }}>Order Summary</div>
              <div style={{ fontSize: 12, color: '#888' }}>{restaurant.name}</div>
            </div>
            {cartSidebar}
          </div>
        </div>
      </div>

      {/* Mobile bottom bar */}
      <div className="mobile-order-bar"
        style={{ display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0, padding: '12px 16px', background: '#fff', borderTop: '1px solid #f0f0f0', boxShadow: '0 -4px 16px rgba(0,0,0,0.06)', zIndex: 100 }}>
        <button onClick={() => setMobileCartOpen(true)}
          style={{ width: '100%', padding: '14px', background: cartCount > 0 ? BLUE : '#e8e8e8', color: cartCount > 0 ? '#fff' : '#bbb', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: F, boxShadow: cartCount > 0 ? '0 4px 14px rgba(91,111,232,0.25)' : 'none', transition: 'all 0.15s' }}>
          {cartCount > 0 ? `${cartCount} item${cartCount !== 1 ? 's' : ''} · ${fmt$(cartTotal)} — View Order` : 'Browse Menu to Start Order'}
        </button>
      </div>

      {/* Mobile cart overlay */}
      {mobileCartOpen && (
        <div style={{ position: 'fixed', inset: 0, background: '#fff', zIndex: 600, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: DARK }}>Order Summary</div>
              <div style={{ fontSize: 12, color: '#888' }}>{restaurant.name}</div>
            </div>
            <button onClick={() => setMobileCartOpen(false)}
              style={{ background: '#f0f0f0', border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
          </div>
          {cartSidebar}
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        @media (max-width: 768px) {
          .order-sidebar { display: none !important; }
          .mobile-order-bar { display: block !important; }
          .pkg-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 540px) {
          .pkg-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  )
}
