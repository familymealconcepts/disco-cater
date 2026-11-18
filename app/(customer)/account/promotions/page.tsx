'use client'
// Account → Promotions: the diner's promotions (lib/promotions/diner-promotions.ts). Open ones first
// with Activate and Order; used, expired and cancelled ones under "Past". The email's Activate link
// lands here with ?activate=<reference>, which activates it on arrival.
import Link from 'next/link'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PromotionGrid, isOpenPromotion, useDinerPromotions } from '../components/PromotionCards'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#586CE1'

function PromotionsInner() {
  const { promotions, loading, error, refresh, activate } = useDinerPromotions()
  const params = useSearchParams()
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const handled = useRef(false)

  // The email's Activate link.
  useEffect(() => {
    const ref = params.get('activate')
    if (!ref || handled.current) return
    handled.current = true
    void (async () => {
      const err = await activate(ref)
      setNotice(err ? { ok: false, text: err } : { ok: true, text: 'Free delivery is activated. It comes off at checkout on your next delivery order.' })
      router.replace('/account/promotions')
    })()
  }, [params, activate, router])

  const open = promotions.filter(isOpenPromotion)
  const past = promotions.filter((p) => !isOpenPromotion(p))

  return (
    <div style={{ fontFamily: F }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 6, marginTop: 0 }}>Promotions</h1>
      <p style={{ fontSize: 12, color: '#727272', margin: '0 0 22px' }}>Offers from Disco Cater. Activate one, then order: it&apos;s applied at checkout.</p>
      {notice && (
        <div role="status" style={{ border: `1px solid ${notice.ok ? '#ABEFC6' : '#FECDCA'}`, background: notice.ok ? '#ECFDF3' : '#FEF3F2', color: notice.ok ? '#067647' : '#B42318', borderRadius: 10, padding: '10px 14px', fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
          {notice.text}
        </div>
      )}
      {loading ? (
        <div style={{ color: '#727272', fontSize: 13, padding: '20px 0' }}>Loading promotions…</div>
      ) : error ? (
        <div style={{ border: '1px solid #ebebeb', borderRadius: 12, padding: '48px 24px', textAlign: 'center', background: '#fff' }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: DARK, marginBottom: 8 }}>Couldn&apos;t load your promotions</div>
          <button onClick={() => refresh()} style={{ padding: '11px 24px', background: BLUE, color: '#fff', border: 'none', borderRadius: 999, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>Retry</button>
        </div>
      ) : promotions.length === 0 ? (
        <div style={{ border: '1px solid #ebebeb', borderRadius: 12, padding: '64px 24px', textAlign: 'center', background: '#fff' }}>
          <div style={{ fontSize: 48, marginBottom: 16, lineHeight: 1 }}>🎁</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: DARK, marginBottom: 8 }}>No promotions right now</div>
          <div style={{ fontSize: 14, color: '#727272', lineHeight: 1.5, maxWidth: 340, margin: '0 auto 22px' }}>When Disco Cater sends you an offer, it&apos;ll show up here.</div>
          <Link href="/fullmap" style={{ display: 'inline-block', padding: '11px 24px', background: BLUE, color: '#fff', borderRadius: 999, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>Browse restaurants</Link>
        </div>
      ) : (
        <>
          {open.length > 0 && <PromotionGrid items={open} onActivate={activate} />}
          {past.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#727272', textTransform: 'uppercase', letterSpacing: '0.06em', margin: `${open.length ? 26 : 0}px 0 10px` }}>Past</div>
              <PromotionGrid items={past} onActivate={activate} />
            </>
          )}
        </>
      )}
    </div>
  )
}

export default function PromotionsPage() {
  return <Suspense fallback={null}><PromotionsInner /></Suspense>
}
