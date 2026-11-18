'use client'
// Diner promotion cards (lib/promotions/diner-promotions.ts), styled like the Favorites cards. Used by
// Account → Promotions (every promotion, open ones first) and the Orders home (open ones only).
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { sizedImage } from '../../../../lib/sanity-image'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#586CE1'
const GRAD = 'linear-gradient(90deg,#6466E8 0%,#C044C8 50%,#F0468A 100%)'

export interface DinerPromotionCard {
  reference: string
  type: 'FREE_DELIVERY'
  status: 'OFFERED' | 'ACTIVATED' | 'USED' | 'EXPIRED' | 'CANCELLED'
  expiresOn: string
  restaurantName: string
  restaurantSlug: string | null
  restaurantImage: string | null
  restaurantCity: string | null
  restaurantState: string | null
  orderNumber: number | null
}

export const isOpenPromotion = (p: DinerPromotionCard) => p.status === 'OFFERED' || p.status === 'ACTIVATED'

export function promotionDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** Loads the signed-in diner's promotions and activates one (optimistically refreshed). */
export function useDinerPromotions() {
  const [promotions, setPromotions] = useState<DinerPromotionCard[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const refresh = useCallback(async () => {
    setError(false)
    try {
      const r = await fetch('/api/customer/promotions', { credentials: 'include' })
      if (!r.ok) throw new Error(String(r.status))
      const d = await r.json()
      setPromotions(Array.isArray(d.promotions) ? d.promotions : [])
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const activate = useCallback(async (reference: string): Promise<string | null> => {
    const r = await fetch(`/api/customer/promotions/${reference}/activate`, { method: 'POST', credentials: 'include' })
    const d = await r.json().catch(() => ({}))
    await refresh()
    return r.ok ? null : (d.error || 'Could not activate this promotion.')
  }, [refresh])
  return { promotions, loading, error, refresh, activate }
}

export function PromotionCard({ p, onActivate }: { p: DinerPromotionCard; onActivate: (ref: string) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const open = isOpenPromotion(p)
  const img = sizedImage(p.restaurantImage || undefined, 500, 300)
  const loc = [p.restaurantCity, p.restaurantState].filter(Boolean).join(', ')
  const orderHref = p.restaurantSlug ? `/restaurants/${p.restaurantSlug}` : '/fullmap'
  const statusLine = p.status === 'USED'
    ? `Used${p.orderNumber ? ` on order #${p.orderNumber}` : ''}`
    : p.status === 'EXPIRED' ? `Expired ${promotionDate(p.expiresOn)}`
    : p.status === 'CANCELLED' ? 'No longer available'
    : `Expires ${promotionDate(p.expiresOn)}`
  return (
    <div data-testid="promotion-card"
      style={{ border: '1px solid #ebebeb', borderRadius: 12, overflow: 'hidden', background: '#fff', position: 'relative', display: 'flex', flexDirection: 'column', opacity: open ? 1 : 0.6 }}>
      <div style={{ width: '100%', height: 130, background: GRAD, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, color: 'rgba(255,255,255,0.85)', position: 'relative' }}>
        {img
          ? <img src={img} alt="" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', filter: open ? undefined : 'grayscale(1)' }} />
          : '🚚'}
        <span style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(255,255,255,0.94)', color: DARK, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 999, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
          Free delivery
        </span>
      </div>
      <div style={{ padding: '12px 14px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.restaurantName}</div>
        {loc && <div style={{ fontSize: 11, color: '#727272', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loc}</div>}
        <div style={{ fontSize: 12, color: DARK, marginTop: 4 }}>Free delivery on your next order</div>
        <div style={{ fontSize: 11, color: '#727272' }}>{statusLine}</div>
        {open && (
          <div style={{ marginTop: 'auto', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {p.status === 'ACTIVATED' ? (
              <div style={{ textAlign: 'center', padding: '8px 10px', background: '#ECFDF3', color: '#15803D', borderRadius: 7, fontSize: 12, fontWeight: 700 }}>Activated ✓</div>
            ) : (
              <button disabled={busy} onClick={async () => { setBusy(true); setErr(await onActivate(p.reference)); setBusy(false) }}
                style={{ padding: '8px 10px', background: GRAD, color: '#fff', border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: busy ? 'default' : 'pointer', fontFamily: F, opacity: busy ? 0.7 : 1 }}>
                {busy ? 'Activating…' : 'Activate'}
              </button>
            )}
            <Link href={orderHref} style={{ display: 'block', textAlign: 'center', padding: '8px 10px', background: BLUE, color: '#fff', borderRadius: 7, fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
              Order from {p.restaurantName}
            </Link>
            {p.status === 'ACTIVATED' && <div style={{ fontSize: 11, color: '#727272', textAlign: 'center' }}>Applied at checkout on your next delivery order.</div>}
            {err && <div style={{ fontSize: 11, color: '#B42318', textAlign: 'center' }}>{err}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

export function PromotionGrid({ items, onActivate }: { items: DinerPromotionCard[]; onActivate: (ref: string) => Promise<string | null> }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 14 }}>
      {items.map((p) => <PromotionCard key={p.reference} p={p} onActivate={onActivate} />)}
    </div>
  )
}

/** The Orders home's card: open promotions only; renders nothing when there are none. */
export function HomePromotions() {
  const { promotions, activate } = useDinerPromotions()
  const open = promotions.filter(isOpenPromotion)
  if (!open.length) return null
  return (
    <div style={{ marginBottom: 18 }} data-testid="home-promotions">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>Your promotions</div>
        <Link href="/account/promotions" style={{ fontSize: 12, color: BLUE, fontWeight: 600, textDecoration: 'none' }}>See all</Link>
      </div>
      <PromotionGrid items={open} onActivate={activate} />
    </div>
  )
}
