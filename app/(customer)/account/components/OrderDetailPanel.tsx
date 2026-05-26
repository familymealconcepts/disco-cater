'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const PURPLE = '#6B6EF9'
const GREEN = '#1D9E75'
const ORANGE = '#BA7517'

// ── FM order shape (GET /api/userOrder/{ref}) ───────────────────────────────
// Bindings mirror FM order-history-details.component.ts mappingOrderDetails().

interface OrderAddOn { name?: string; count?: number; price?: number }
interface OrderMealPackage { name?: string; count?: number; price?: number; orderAddOns?: OrderAddOn[]; comment?: string }
interface OrderClassic { name?: string; count?: number; price?: number; comment?: string }

interface OrderRestaurant {
  businessName?: string
  phoneNumber?: string
  timezone?: string
  businessNameWithoutSpaces?: string
  address?: { addressLine1?: string; city?: string; state?: string; zipcode?: string }
}

interface OrderSubscription {
  // Presence of this field means a recurring order. FM doesn't tightly type
  // it on the customer side — we just read the few fields we display.
  frequency?: string
  daysOfWeek?: string[]
  startDate?: string
  endDate?: string
  status?: string
  nextOrderDate?: string
}

export interface FmOrderDetail {
  reference?: string
  orderNumber?: number
  orderStatus?: string
  orderDate?: string
  orderTime?: string
  orderType?: string       // 'DELIVERY' | 'PICKUP'
  deliveryType?: string
  createdDate?: string
  firstName?: string
  lastName?: string
  email?: string
  phoneNumber?: string
  restaurant?: OrderRestaurant
  deliveryAddress?: { addressLine1?: string; addressLine2?: string; city?: string; state?: string; zipcode?: string }
  subtotal?: number
  total?: number
  fee?: number
  ownDeliveryFee?: number
  doordashDeliveryFee?: number
  thirdPartyDeliveryFee?: number
  tipsInPrice?: number
  thirdPartyDeliveryTipsInPrice?: number
  stateSalesTaxInPrice?: number
  localSalesTaxInPrice?: number
  otherSalesTaxInPrice?: number
  discount?: number
  orderMealPackages?: OrderMealPackage[]
  orderClassics?: OrderClassic[]
  orderSubscription?: OrderSubscription | null
  note?: string
}

interface Props {
  orderRef: string
  mode?: 'upcoming' | 'history'
  onClose: () => void
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtMoney(n?: number) {
  return `$${(n || 0).toFixed(2)}`
}

function fmtDate(d?: string) {
  if (!d) return ''
  try {
    return new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  } catch { return d }
}

function fmtTime(t?: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  if (isNaN(h)) return t
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m || 0).padStart(2, '0')} ${ampm}`
}

function recurrenceLabel(sub: OrderSubscription | null | undefined) {
  if (!sub) return ''
  const f = (sub.frequency || '').toUpperCase()
  if (f.includes('WEEK')) return 'Every week'
  if (f.includes('BI') || f.includes('FORTNIGHT')) return 'Bi-weekly'
  if (f.includes('MONTH')) return 'Monthly'
  return sub.frequency || 'Recurring'
}

function deriveHeadcount(d: FmOrderDetail): number | null {
  const counts = (d.orderMealPackages || []).reduce((sum, p) => sum + (p.count || 0), 0)
  if (counts > 0) return counts
  return null
}

function paymentLabel(d: FmOrderDetail): { label: string; color: string } {
  const s = (d.orderStatus || '').toUpperCase()
  if (s === 'UNPAID') return { label: 'Unpaid', color: '#E24B4A' }
  if (s === 'REFUND' || s === 'PARTIAL_REFUND') return { label: 'Refunded', color: ORANGE }
  if (s === 'CANCELED' || s === 'VOID' || s === 'EXPIRED') return { label: s.charAt(0) + s.slice(1).toLowerCase(), color: '#888' }
  return { label: 'Paid', color: GREEN }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function OrderDetailPanel({ orderRef, mode = 'upcoming', onClose }: Props) {
  const router = useRouter()
  const [detail, setDetail] = useState<FmOrderDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true); setError(''); setDetail(null)
    fetch(`/api/fm-order-detail/${orderRef}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: FmOrderDetail) => setDetail(d))
      .catch(() => setError('Could not load order'))
      .finally(() => setLoading(false))
  }, [orderRef])

  // ESC closes
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const recurring = !!detail?.orderSubscription
  const restaurantName = detail?.restaurant?.businessName || 'Order'
  const restaurantLoc = detail?.restaurant?.address?.city
    || detail?.restaurant?.businessNameWithoutSpaces
    || ''
  const headcount = detail ? deriveHeadcount(detail) : null
  const payment = detail ? paymentLabel(detail) : { label: '—', color: '#888' }
  const tagText = recurring ? 'Weekly recurring' : 'Event catering'
  const tagColors = recurring
    ? { bg: '#EEEDFE', fg: '#3C3489' }
    : { bg: '#E1F5EE', fg: '#085041' }
  const dateText = recurring
    ? recurrenceLabel(detail?.orderSubscription)
    : fmtDate(detail?.orderDate)

  function handleEdit() {
    // FM has no customer-side edit endpoint yet (Project Orca 3.5 is on
    // the roadmap). For now we send the user back to the restaurant page
    // so they can start a new order; once the backend ships an edit flow
    // we can deep-link to it from here.
    const slug = detail?.restaurant?.businessNameWithoutSpaces
    if (slug) router.push(`/restaurants/${slug}`)
    else router.push('/fullmap')
  }

  function handleSkip() {
    alert('Skip next is coming soon — FM hasn\'t shipped the customer subscription-skip endpoint yet.')
  }

  function handleCancel() {
    alert('Cancel order is coming soon — FM hasn\'t shipped a customer-side cancel endpoint yet.')
  }

  function handleReorder() {
    const slug = detail?.restaurant?.businessNameWithoutSpaces
    if (slug) router.push(`/restaurants/${slug}`)
    else router.push('/fullmap')
  }

  return (
    <>
      {/* Scrim — closes on click */}
      <div onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 700 }} />

      {/* Panel */}
      <aside
        role="dialog" aria-modal="true" aria-label="Order details"
        className="order-detail-panel"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 320, maxWidth: '100vw',
          background: '#fff', zIndex: 701, fontFamily: F,
          boxShadow: '-8px 0 32px rgba(0,0,0,0.12)',
          display: 'flex', flexDirection: 'column',
          animation: 'odp-slide-in 0.22s ease-out',
        }}
      >
        <style>{`
          @keyframes odp-slide-in { from { transform: translateX(20px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }
          @media (max-width: 480px) {
            .order-detail-panel { width: 100% !important; }
          }
        `}</style>

        {/* Header */}
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: DARK, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {loading ? 'Loading…' : restaurantName}
            </div>
            {detail?.orderNumber !== undefined && (
              <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>Order #{detail.orderNumber}</div>
            )}
          </div>
          <button onClick={onClose} aria-label="Close panel"
            style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: '50%', fontSize: 16, color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
          {loading && <div style={{ color: '#aaa', fontSize: 13 }}>Loading…</div>}
          {error && !loading && <div style={{ background: '#fff3f3', color: '#c00', padding: 10, borderRadius: 8, fontSize: 13 }}>{error}</div>}

          {detail && !loading && !error && (
            <>
              {/* Summary card */}
              <div style={{ background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: DARK, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {restaurantName}{restaurantLoc ? ` — ${restaurantLoc}` : ''}
                    </div>
                    {headcount !== null && (
                      <div style={{ fontSize: 11, color: '#666', marginTop: 3 }}>{headcount} {headcount === 1 ? 'person' : 'people'}</div>
                    )}
                  </div>
                  <span style={{ background: tagColors.bg, color: tagColors.fg, padding: '3px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {tagText}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 12, paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: DARK }}>{fmtMoney(detail.total)}</div>
                  <div style={{ textAlign: 'right', fontSize: 11, color: '#555' }}>
                    <div>{dateText}</div>
                    {detail.orderTime && <div style={{ color: '#888', marginTop: 1 }}>{fmtTime(detail.orderTime)}</div>}
                  </div>
                </div>
              </div>

              {/* Items */}
              {((detail.orderMealPackages?.length || 0) + (detail.orderClassics?.length || 0)) > 0 && (
                <>
                  <SectionLabel>Items</SectionLabel>
                  <div style={{ marginBottom: 16 }}>
                    {(detail.orderMealPackages || []).map((it, i) => (
                      <LineItem key={`mp-${i}`} name={it.name || 'Item'} count={it.count} price={it.price} addOns={it.orderAddOns} comment={it.comment} />
                    ))}
                    {(detail.orderClassics || []).map((it, i) => (
                      <LineItem key={`cl-${i}`} name={it.name || 'Item'} count={it.count} price={it.price} comment={it.comment} />
                    ))}
                  </div>
                </>
              )}

              {/* Details */}
              <SectionLabel>Details</SectionLabel>
              <div style={{ display: 'grid', rowGap: 6, marginBottom: 18 }}>
                <DetailRow label="Type" value={recurring ? 'Recurring' : 'One-time'} />
                <DetailRow label="Service" value={(detail.orderType || '').toLowerCase() === 'delivery' ? 'Delivery' : 'Pickup'} />
                <DetailRow label="Order date" value={recurring ? recurrenceLabel(detail.orderSubscription) : fmtDate(detail.orderDate) || '—'} />
                <DetailRow label="Order time" value={fmtTime(detail.orderTime) || '—'} />
                <DetailRow label="Payment" valueNode={<span style={{ color: payment.color, fontWeight: 700 }}>{payment.label}</span>} />
              </div>

              {/* Delivery address */}
              {detail.orderType === 'DELIVERY' && detail.deliveryAddress?.addressLine1 && (
                <>
                  <SectionLabel>Delivery to</SectionLabel>
                  <div style={{ fontSize: 12, color: DARK, marginBottom: 18, lineHeight: 1.55 }}>
                    {[detail.deliveryAddress.addressLine1, detail.deliveryAddress.addressLine2, detail.deliveryAddress.city, detail.deliveryAddress.state, detail.deliveryAddress.zipcode]
                      .filter(Boolean)
                      .join(', ')}
                  </div>
                </>
              )}

              {detail.note && (
                <>
                  <SectionLabel>Note</SectionLabel>
                  <div style={{ background: '#FFF9E6', border: '1px solid #FFE9A0', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#7A6020', marginBottom: 18, lineHeight: 1.5 }}>
                    {detail.note}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Action bar */}
        {detail && !loading && !error && (
          <div style={{ padding: '14px 18px', borderTop: '1px solid #f0f0f0', display: 'flex', gap: 8 }}>
            {mode === 'history' ? (
              <button onClick={handleReorder}
                style={{ flex: 1, padding: '10px 14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
                Reorder
              </button>
            ) : (
              <>
                <button onClick={handleEdit}
                  style={{ flex: 2, padding: '10px 14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
                  Edit
                </button>
                {recurring ? (
                  <button onClick={handleSkip}
                    style={{ flex: 1, padding: '10px 14px', background: '#fff', color: DARK, border: '1px solid #e0e0e0', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                    Skip next
                  </button>
                ) : (
                  <button onClick={handleCancel}
                    style={{ flex: 1, padding: '10px 14px', background: '#fff', color: '#E24B4A', border: '1px solid #F0BFBE', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                    Cancel
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </aside>
    </>
  )
  // Suppress unused-var warning if PURPLE styles change
  void PURPLE
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 8px' }}>
      {children}
    </div>
  )
}

function DetailRow({ label, value, valueNode }: { label: string; value?: string; valueNode?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12 }}>
      <span style={{ color: '#888' }}>{label}</span>
      <span style={{ color: DARK, fontWeight: 600, textAlign: 'right', maxWidth: '60%' }}>
        {valueNode ?? (value || '—')}
      </span>
    </div>
  )
}

function LineItem({ name, count, price, addOns, comment }: { name: string; count?: number; price?: number; addOns?: OrderAddOn[]; comment?: string }) {
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px dotted #eee' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 12, color: DARK, fontWeight: 500 }}>
          {name}{count && count > 1 ? ` (x${count})` : ''}
        </span>
        <span style={{ fontSize: 12, color: DARK, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {price !== undefined ? `${fmtMoney(price)}/pp` : ''}
        </span>
      </div>
      {addOns && addOns.length > 0 && (
        <div style={{ paddingLeft: 12, marginTop: 4 }}>
          {addOns.map((a, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#666', padding: '2px 0' }}>
              <span>+ {a.name}{a.count && a.count > 1 ? ` (x${a.count})` : ''}</span>
              {a.price !== undefined && <span>{fmtMoney(a.price)}/pp</span>}
            </div>
          ))}
        </div>
      )}
      {comment && (
        <div style={{ paddingLeft: 12, marginTop: 4, fontSize: 11, color: '#888', fontStyle: 'italic' }}>
          {comment}
        </div>
      )}
    </div>
  )
}
