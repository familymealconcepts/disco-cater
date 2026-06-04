'use client'

import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { buildCheckoutPayload, type CheckoutCartLine } from '../../../../../../../lib/pricing/checkout'
import { cartSubtotal, lineUnitPrice } from '../../../../../../../lib/pricing/cart'
import { formatCurrency } from '../../../../../../../lib/pricing/lineItem'

// ─── Brand ─────────────────────────────────────────────────────────────────
const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const GOLD = '#EFB84A'
const GREEN = '#2E9E5B'
const RED = '#E76F51'

// ─── FM menu shapes (mirror customer builder) ────────────────────────────────
interface FmMenu { reference: string; name: string; position?: number; settings?: { serviceCharge?: number | null; serviceChargeName?: string | null } }
interface FmAddOn { reference: string; name: string; price: number; visible?: boolean; position?: number }
interface FmExtraItemsGroup {
  reference: string; name: string; externalName?: string; subExternalName?: string
  minSelectedItems?: number; maxSelectedItems?: number; visible?: boolean; addOns?: FmAddOn[]
}
interface FmPackage {
  reference: string; name: string; description?: string | null; price: number
  serves?: string | number | null; available?: boolean; allowedSpecialInstructions?: boolean
  extraItemsGroups?: FmExtraItemsGroup[]
}
interface FmCategory { reference: string; name: string; description?: string | null; mealPackages: FmPackage[] }
export interface MenuSection { menu: FmMenu; categories: FmCategory[] }

interface DeliveryAddr {
  addressLine1: string; addressLine2?: string; city: string; state: string; zipcode: string
  latitude?: number; longitude?: number; deliveryInstructions?: string
}

// ─── Cart shapes (with edit tracking) ─────────────────────────────────────────
interface EditAddOn { reference: string; name: string; price: number; count: number; extraItemsGroupReference?: string }
interface EditCartLine {
  lineId: string
  reference: string
  name: string
  price: number
  quantity: number
  addOns: EditAddOn[]
  note?: string
  serves?: string | number | null
  origin: 'original' | 'new'
  originalQuantity: number      // 0 for new lines
  removed: boolean
}

// Loose typing for the FM order-details payload — shape varies, read defensively.
type AnyRec = Record<string, unknown>
function num(v: unknown): number { return typeof v === 'number' ? v : 0 }
function str(v: unknown): string { return typeof v === 'string' ? v : '' }

// Pull canonical money fields out of an FM re-price / order response. FM may
// nest them under checkoutPublicResponseDto or return them flat.
function extractFmMoney(resp: AnyRec | null) {
  const d = ((resp?.checkoutPublicResponseDto as AnyRec) ?? resp ?? {}) as AnyRec
  const tax = num(d.stateSalesTaxInPrice) + num(d.localSalesTaxInPrice) + num(d.otherSalesTaxInPrice)
  const delivery = num(d.ownDeliveryFee) + num(d.doordashDeliveryFee) + num(d.thirdPartyDeliveryFee) || num(d.deliveryFee)
  const tips = num(d.tipsInPrice) + num(d.thirdPartyDeliveryTipsInPrice) || num(d.tips)
  const fee = num(d.fee) || num(d.fees)
  const discount = num(d.discount)
  const subtotal = typeof d.subtotal === 'number' ? d.subtotal : null
  const total = typeof d.total === 'number' ? d.total : (typeof d.transactionsTotal === 'number' ? d.transactionsTotal : null)
  return { subtotal, tax, delivery, tips, fee, discount, total }
}

export default function EditOrderClient({ orderRef, restaurantRef, menuData }: { orderRef: string; restaurantRef: string; menuData: MenuSection[] }) {
  const router = useRouter()

  // ─── Lifecycle / load state ───────────────────────────────────────────────
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // ─── Order / cart state ───────────────────────────────────────────────────
  const [cart, setCart] = useState<EditCartLine[]>([])
  const [orderType, setOrderType] = useState<'PICKUP' | 'DELIVERY'>('PICKUP')
  const [orderDate, setOrderDate] = useState('')   // YYYY-MM-DD
  const [orderTime, setOrderTime] = useState('')   // HH:mm:ss
  const [deliveryAddress, setDeliveryAddress] = useState<DeliveryAddr | null>(null)
  const [origTotal, setOrigTotal] = useState(0)
  const [origMoney, setOrigMoney] = useState({ subtotal: 0, tax: 0, delivery: 0, tips: 0, fee: 0, discount: 0, total: 0 })
  const [taxExempt, setTaxExempt] = useState(false)

  // The order ref to PUT/commit against. FM may clone the order into an edit
  // draft (editOrderRef); if so we target that, else the original ref.
  const editRefRef = useRef(orderRef)
  const lineCounter = useRef(0)

  // ─── Lock timer ───────────────────────────────────────────────────────────
  const DEFAULT_LOCK_SECONDS = 600
  const lockTotalRef = useRef(DEFAULT_LOCK_SECONDS)
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_LOCK_SECONDS)
  const [lockExpired, setLockExpired] = useState(false)

  // ─── Re-price (server totals) ─────────────────────────────────────────────
  const [serverMoney, setServerMoney] = useState<ReturnType<typeof extractFmMoney> | null>(null)
  const [repricing, setRepricing] = useState(false)
  const repriceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ─── Commit / discard / UI ────────────────────────────────────────────────
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [committed, setCommitted] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [mobileCartOpen, setMobileCartOpen] = useState(false)

  // ─── Menu browse UI ───────────────────────────────────────────────────────
  const [activeMenuIdx, setActiveMenuIdx] = useState(0)
  const [search, setSearch] = useState('')
  const [modalPkg, setModalPkg] = useState<FmPackage | null>(null)

  const newLineId = () => `line-${++lineCounter.current}`

  // ─── Build cart line from an FM order meal-package ────────────────────────
  const orderLineToCart = useCallback((mp: AnyRec): EditCartLine => {
    const qty = num(mp.count) || num(mp.quantity) || 1
    const addOnsRaw = (Array.isArray(mp.orderAddOns) ? mp.orderAddOns : (Array.isArray(mp.extraItems) ? mp.extraItems : [])) as AnyRec[]
    const addOns: EditAddOn[] = addOnsRaw.map(a => ({
      reference: str(a.reference) || str(a.addOnReference),
      name: str(a.name),
      price: num(a.price),
      count: num(a.count) || num(a.quantity) || 1,
      extraItemsGroupReference: str(a.extraItemsGroupReference) || undefined,
    }))
    return {
      lineId: newLineId(),
      reference: str(mp.reference) || str(mp.mealPackageReference),
      name: str(mp.name),
      price: num(mp.price),
      quantity: qty,
      addOns,
      note: str(mp.comment) || str(mp.specialInstructions) || undefined,
      serves: (mp.serves as string | number | null) ?? null,
      origin: 'original',
      originalQuantity: qty,
      removed: false,
    }
  }, [])

  // ─── PAGE LOAD: details → prepopulate → acquire lock ──────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        console.log('[edit-client] loading details', { orderRef })
        const res = await fetch(`/api/restaurant/orders/${orderRef}/details`)
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          console.error('[edit-client] details fetch failed', { orderRef, status: res.status, body: body.slice(0, 1000) })
          throw new Error(`details ${res.status}`)
        }
        const o = (await res.json()) as AnyRec
        if (cancelled) return
        console.log('[edit-client] details loaded', {
          orderRef,
          mealPackages: Array.isArray(o.orderMealPackages) ? o.orderMealPackages.length : 0,
          classics: Array.isArray(o.orderClassics) ? o.orderClassics.length : 0,
          orderType: o.orderType, orderDate: o.orderDate, orderTime: o.orderTime,
        })

        const mps = [
          ...(Array.isArray(o.orderMealPackages) ? o.orderMealPackages : []),
          ...(Array.isArray(o.orderClassics) ? o.orderClassics : []),
        ] as AnyRec[]
        setCart(mps.map(orderLineToCart))

        setOrderType(str(o.orderType) === 'DELIVERY' || str(o.deliveryType).includes('DELIVERY') ? 'DELIVERY' : 'PICKUP')
        setOrderDate(str(o.orderDate))
        setOrderTime(str(o.orderTime))
        setTaxExempt(o.taxExempt === true)

        const da = o.deliveryAddress as AnyRec | undefined
        if (da && str(da.addressLine1)) {
          setDeliveryAddress({
            addressLine1: str(da.addressLine1),
            addressLine2: str(da.addressLine2) || undefined,
            city: str(da.city),
            state: str(da.state),
            zipcode: str(da.zipcode),
            latitude: num(da.latitude) || undefined,
            longitude: num(da.longitude) || undefined,
            deliveryInstructions: str(da.deliveryInstructions) || undefined,
          })
        }

        const money = extractFmMoney(o)
        setOrigMoney({
          subtotal: money.subtotal ?? 0, tax: money.tax, delivery: money.delivery,
          tips: money.tips, fee: money.fee, discount: money.discount, total: money.total ?? 0,
        })
        setOrigTotal(money.total ?? num(o.transactionsTotal))

        // Acquire the edit lock.
        const lockRes = await fetch(`/api/restaurant/orders/${orderRef}/edit-start`, { method: 'POST' })
        const lockData = (await lockRes.json().catch(() => ({}))) as AnyRec
        if (cancelled) return
        if (lockRes.ok) {
          const editRef = str(lockData.editOrderRef)
          if (editRef) editRefRef.current = editRef
          const raw = lockData.lockDuration
          let secs = DEFAULT_LOCK_SECONDS
          if (typeof raw === 'number' && raw > 0) secs = raw <= 60 ? raw * 60 : raw
          lockTotalRef.current = secs
          setSecondsLeft(secs)
        }
        // If the lock call fails we still let them view/edit; commit will surface
        // any server-side lock error.
        setLoading(false)
      } catch (err) {
        console.error('[edit-client] load sequence threw', { orderRef, err })
        if (!cancelled) { setLoadError('Could not load this order for editing.'); setLoading(false) }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderRef])

  // ─── Lock countdown ───────────────────────────────────────────────────────
  useEffect(() => {
    if (loading || lockExpired || committed) return
    const id = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) { clearInterval(id); setLockExpired(true); releaseLock(); return 0 }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, lockExpired, committed])

  // ─── Silent re-acquire every 8 minutes ────────────────────────────────────
  useEffect(() => {
    if (loading || lockExpired || committed) return
    const id = setInterval(async () => {
      try {
        const r = await fetch(`/api/restaurant/orders/${orderRef}/edit-start`, { method: 'POST' })
        if (r.ok) setSecondsLeft(lockTotalRef.current)
      } catch { /* best effort */ }
    }, 8 * 60 * 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, lockExpired, committed, orderRef])

  // ─── Release lock on tab close / navigate away (best effort) ──────────────
  useEffect(() => {
    const handler = () => {
      try {
        fetch(`/api/restaurant/orders/${orderRef}/edit-lock`, { method: 'DELETE', keepalive: true })
      } catch { /* noop */ }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [orderRef])

  function releaseLock() {
    return fetch(`/api/restaurant/orders/${orderRef}/edit-lock`, { method: 'DELETE', keepalive: true }).catch(() => {})
  }

  // ─── Cart math / diff ─────────────────────────────────────────────────────
  const activeLines = useMemo(() => cart.filter(l => !l.removed), [cart])
  const changed = useMemo(
    () => cart.some(l => l.origin === 'new' || l.removed || l.quantity !== l.originalQuantity),
    [cart]
  )

  // Build the FM checkout payload for the current (non-removed) cart.
  const buildPayload = useCallback(() => {
    const lines: CheckoutCartLine[] = activeLines.map(l => ({
      reference: l.reference,
      name: l.name,
      price: l.price,
      count: l.quantity,
      note: l.note,
      addOns: l.addOns.map(a => ({
        reference: a.reference, name: a.name, price: a.price, count: a.count,
        extraItemsGroupReference: a.extraItemsGroupReference,
      })),
    }))
    const payload = buildCheckoutPayload({
      restaurantRef,
      cart: lines,
      orderType,
      orderDate,
      orderTime,
      deliveryAddress: orderType === 'DELIVERY' && deliveryAddress ? deliveryAddress : undefined,
    })
    // Preserve the existing order's tip and tax-exempt status — item edits
    // shouldn't silently zero them. (Tip is order data, not payment handling.)
    payload.tips = origMoney.tips
    payload.tipsType = 'AMOUNT'
    payload.taxExempt = taxExempt
    return payload
  }, [activeLines, restaurantRef, orderType, orderDate, orderTime, deliveryAddress, origMoney.tips, taxExempt])

  // ─── Debounced re-price against the edit draft ────────────────────────────
  useEffect(() => {
    if (loading || lockExpired || committed || !changed) return
    if (repriceTimer.current) clearTimeout(repriceTimer.current)
    repriceTimer.current = setTimeout(async () => {
      setRepricing(true)
      try {
        const payload = buildPayload()
        const res = await fetch('/api/order/update', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, orderRef: editRefRef.current }),
        })
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as AnyRec | null
          setServerMoney(extractFmMoney(data))
        }
      } catch { /* keep client estimate */ } finally { setRepricing(false) }
    }, 600)
    return () => { if (repriceTimer.current) clearTimeout(repriceTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, changed, loading, lockExpired, committed])

  // ─── Totals (prefer server re-price, fall back to estimate) ───────────────
  const newSubtotal = serverMoney?.subtotal ?? cartSubtotal(activeLines.map(l => ({ price: l.price, count: l.quantity, addOns: l.addOns })))
  const taxesFees = serverMoney ? (serverMoney.tax + serverMoney.fee) : (origMoney.tax + origMoney.fee)
  const delivery = serverMoney ? serverMoney.delivery : origMoney.delivery
  const tip = serverMoney ? serverMoney.tips : origMoney.tips
  const discount = serverMoney ? serverMoney.discount : origMoney.discount
  const newTotal = serverMoney?.total ?? (newSubtotal + taxesFees + delivery + tip - discount)
  const delta = newTotal - origTotal

  // ─── Cart mutations ───────────────────────────────────────────────────────
  function changeQty(lineId: string, dir: 1 | -1) {
    setCart(prev => prev.flatMap(l => {
      if (l.lineId !== lineId) return [l]
      const q = l.quantity + dir
      if (q <= 0) {
        // New lines disappear; original lines become "removed".
        if (l.origin === 'new') return []
        return [{ ...l, quantity: l.originalQuantity, removed: true }]
      }
      return [{ ...l, quantity: q }]
    }))
  }
  function removeLine(lineId: string) {
    setCart(prev => prev.flatMap(l => {
      if (l.lineId !== lineId) return [l]
      if (l.origin === 'new') return []
      return [{ ...l, removed: true }]
    }))
  }
  function restoreLine(lineId: string) {
    setCart(prev => prev.map(l => l.lineId === lineId ? { ...l, removed: false } : l))
  }

  // ─── Add-to-cart (from modifier modal) ────────────────────────────────────
  function addToCart(pkg: FmPackage, qty: number, addOns: EditAddOn[], note?: string) {
    const sig = (a: EditAddOn[], n?: string) =>
      a.map(x => `${x.reference}:${x.count}`).sort().join('|') + '#' + (n || '')
    const incomingSig = sig(addOns, note)
    setCart(prev => {
      // Merge into an existing NEW line with the same config.
      const idx = prev.findIndex(l => l.origin === 'new' && l.reference === pkg.reference && sig(l.addOns, l.note) === incomingSig)
      if (idx >= 0) {
        const copy = [...prev]
        copy[idx] = { ...copy[idx], quantity: copy[idx].quantity + qty }
        return copy
      }
      return [...prev, {
        lineId: newLineId(),
        reference: pkg.reference,
        name: pkg.name,
        price: pkg.price,
        quantity: qty,
        addOns,
        note: note || undefined,
        serves: pkg.serves ?? null,
        origin: 'new',
        originalQuantity: 0,
        removed: false,
      }]
    })
    setModalPkg(null)
    setMobileCartOpen(true)
  }

  function handleItemClick(pkg: FmPackage) {
    const hasGroups = Array.isArray(pkg.extraItemsGroups) && pkg.extraItemsGroups.some(g => g.visible !== false && (g.addOns?.length ?? 0) > 0)
    if (hasGroups || pkg.allowedSpecialInstructions) setModalPkg(pkg)
    else addToCart(pkg, 1, [])
  }

  // ─── Commit ───────────────────────────────────────────────────────────────
  async function commit() {
    if (committing || lockExpired) return
    setCommitError(null)
    setCommitting(true)
    try {
      const payload = buildPayload()
      // 1) Update the draft cart.
      const putRes = await fetch('/api/order/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, orderRef: editRefRef.current }),
      })
      if (!putRes.ok) {
        const e = (await putRes.json().catch(() => ({}))) as AnyRec
        throw new Error(str(e.error) || str(e.message) || 'Could not save the updated cart.')
      }
      // 2) Commit / place the edit.
      const postRes = await fetch('/api/restaurant/orders/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, orderRef: editRefRef.current }),
      })
      if (!postRes.ok) {
        const e = (await postRes.json().catch(() => ({}))) as AnyRec
        throw new Error(str(e.error) || str(e.message) || 'Could not commit the edit.')
      }
      setCommitted(true)
      await releaseLock()
      setTimeout(() => router.push('/restaurant/orders'), 2000)
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Something went wrong committing the edit.')
      setCommitting(false)
    }
  }

  // ─── Discard ──────────────────────────────────────────────────────────────
  async function discard() {
    await releaseLock()
    router.push('/restaurant/orders')
  }

  // ─── Render helpers ───────────────────────────────────────────────────────
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0')
  const ss = String(secondsLeft % 60).padStart(2, '0')

  const filteredSection = useMemo(() => {
    const section = menuData[activeMenuIdx]
    if (!section) return null
    const q = search.trim().toLowerCase()
    if (!q) return section
    const categories = section.categories
      .map(c => ({ ...c, mealPackages: c.mealPackages.filter(p => (p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)) }))
      .filter(c => c.mealPackages.length > 0)
    return { ...section, categories }
  }, [menuData, activeMenuIdx, search])

  // ─── Loading / error ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ fontFamily: F, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 14 }}>
        <style>{`@keyframes eoSpin{to{transform:rotate(360deg)}}`}</style>
        <div style={{ width: 32, height: 32, border: '3px solid #eee', borderTopColor: BLUE, borderRadius: '50%', animation: 'eoSpin 0.7s linear infinite' }} />
        <div style={{ color: '#999', fontSize: 14 }}>Loading order…</div>
      </div>
    )
  }
  if (loadError) {
    return (
      <div style={{ fontFamily: F, textAlign: 'center', padding: '64px 20px' }}>
        <p style={{ color: RED, fontSize: 15, marginBottom: 16 }}>{loadError}</p>
        <button onClick={() => router.push('/restaurant/orders')} style={pillBtn(BLUE)}>Return to Orders</button>
      </div>
    )
  }

  return (
    <div style={{ fontFamily: F, paddingBottom: 40 }}>
      <style>{`@keyframes eoSpin{to{transform:rotate(360deg)}}`}</style>

      {/* ── Sticky edit banner ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 50, background: GOLD, color: DARK,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
        gap: 8, padding: '10px 18px', fontSize: 13, fontWeight: 600,
      }}>
        <span>✏️ Editing Order #{orderRef} — changes are not saved until you click Commit Edit.</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
          Edit lock expires in {mm}:{ss}
        </span>
      </div>

      {/* ── Success banner ── */}
      {committed && (
        <div style={{ background: GREEN, color: '#fff', padding: '10px 18px', fontSize: 14, fontWeight: 600 }}>
          Order #{orderRef} updated successfully. Returning to orders…
        </div>
      )}

      {/* ── Three columns ── */}
      <div className="eo-grid" style={{ display: 'flex', gap: 20, padding: '20px', alignItems: 'flex-start' }}>

        {/* LEFT — menu browser */}
        <div className="eo-menu" style={{ flex: 1, minWidth: 0 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search menu…"
            style={{ width: '100%', padding: '10px 14px', border: '1px solid #e0e0e0', borderRadius: 10, fontSize: 14, fontFamily: F, marginBottom: 14, outline: 'none' }}
          />
          {menuData.length > 1 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {menuData.map((s, i) => (
                <button key={s.menu.reference} onClick={() => setActiveMenuIdx(i)}
                  style={{ padding: '6px 14px', borderRadius: 20, border: '1px solid #e0e0e0', cursor: 'pointer', fontFamily: F, fontSize: 13,
                    background: i === activeMenuIdx ? BLUE : '#fff', color: i === activeMenuIdx ? '#fff' : '#555', fontWeight: i === activeMenuIdx ? 700 : 400 }}>
                  {s.menu.name}
                </button>
              ))}
            </div>
          )}
          {(!filteredSection || filteredSection.categories.length === 0) && (
            <p style={{ color: '#999', fontSize: 14, padding: '24px 0' }}>No menu items{search ? ' match your search' : ' available'}.</p>
          )}
          {filteredSection?.categories.map(cat => (
            <div key={cat.reference} style={{ marginBottom: 28 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: DARK, margin: '0 0 12px' }}>{cat.name}</h3>
              <div style={{ display: 'grid', gap: 10 }}>
                {cat.mealPackages.filter(p => p.available !== false).map(pkg => (
                  <div key={pkg.reference} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, border: '1px solid #eee', borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{pkg.name}</div>
                      {pkg.serves != null && pkg.serves !== '' && <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>Serves {pkg.serves}</div>}
                      {pkg.description && <div style={{ fontSize: 12, color: '#888', marginTop: 4, lineHeight: 1.4 }}>{pkg.description}</div>}
                    </div>
                    <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 6 }}>{formatCurrency(pkg.price)}</div>
                      <button onClick={() => handleItemClick(pkg)} style={{ ...pillBtn(BLUE), padding: '6px 14px', fontSize: 13 }}>Add</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* CENTER — cart */}
        <div className="eo-cart" style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: DARK, margin: '0 0 14px' }}>Order Items</h2>
          {cart.length === 0 && <p style={{ color: '#999', fontSize: 14 }}>No items.</p>}
          <div style={{ display: 'grid', gap: 10 }}>
            {cart.map(line => <CartRow key={line.lineId} line={line} onInc={() => changeQty(line.lineId, 1)} onDec={() => changeQty(line.lineId, -1)} onRemove={() => removeLine(line.lineId)} onRestore={() => restoreLine(line.lineId)} />)}
          </div>
        </div>

        {/* RIGHT — order summary */}
        <div className="eo-summary" style={{ width: 320, flexShrink: 0 }}>
          <div style={{ position: 'sticky', top: 64, background: '#fff', border: '1px solid #eee', borderRadius: 14, padding: '18px 18px 20px' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 14 }}>
              Order Summary — <span style={{ color: BLUE }}>EDIT MODE</span>
            </div>

            <Row label="Original Total" value={formatCurrency(origTotal)} muted strike={changed} />
            <Row label="New Total" value={repricing ? '…' : formatCurrency(newTotal)} bold />

            {changed && Math.abs(delta) >= 0.005 && (
              <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: delta < 0 ? 'rgba(46,158,91,0.08)' : 'rgba(231,111,81,0.08)' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: delta < 0 ? GREEN : RED }}>
                  {delta < 0 ? `Customer refund: -${formatCurrency(Math.abs(delta))}` : `Additional charge: +${formatCurrency(delta)}`}
                </div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 4, lineHeight: 1.4 }}>
                  Customer will be charged automatically if card is on file, or invoiced for the difference.
                </div>
              </div>
            )}

            <div style={{ height: 1, background: '#eee', margin: '14px 0' }} />

            <Row label="Subtotal" value={formatCurrency(newSubtotal)} />
            <Row label="Taxes & Fees" value={formatCurrency(taxesFees)} />
            {orderType === 'DELIVERY' && <Row label="Delivery" value={formatCurrency(delivery)} />}
            <Row label="Tip" value={formatCurrency(tip)} />
            {discount > 0 && <Row label="Discount" value={`-${formatCurrency(discount)}`} />}
            <div style={{ height: 1, background: '#eee', margin: '14px 0' }} />
            <Row label="Total" value={repricing ? '…' : formatCurrency(newTotal)} bold />

            {commitError && (
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'rgba(231,111,81,0.1)', color: RED, fontSize: 12, lineHeight: 1.4 }}>
                {commitError}
              </div>
            )}

            <button onClick={commit} disabled={committing || committed || lockExpired}
              style={{ ...pillBtn(BLUE), width: '100%', marginTop: 16, opacity: (committing || committed || lockExpired) ? 0.6 : 1, cursor: (committing || committed || lockExpired) ? 'default' : 'pointer' }}>
              {committing ? 'Saving changes…' : 'Commit Edit'}
            </button>
            <button onClick={() => setDiscardOpen(true)} disabled={committing || committed}
              style={{ ...pillBtnOutline('#666'), width: '100%', marginTop: 10 }}>
              Discard Changes
            </button>
          </div>
        </div>
      </div>

      {/* Mobile "View Cart" floating button */}
      <button className="eo-fab" onClick={() => setMobileCartOpen(true)}
        style={{ display: 'none', position: 'fixed', bottom: 20, right: 20, zIndex: 60, ...pillBtn(BLUE), padding: '12px 20px', boxShadow: '0 6px 20px rgba(0,0,0,0.2)' }}>
        View Cart ({activeLines.reduce((s, l) => s + l.quantity, 0)})
      </button>

      {/* Modifier modal */}
      {modalPkg && <ModifierModal pkg={modalPkg} onClose={() => setModalPkg(null)} onAdd={addToCart} />}

      {/* Discard confirm modal */}
      {discardOpen && (
        <Overlay onClose={() => setDiscardOpen(false)}>
          <div style={modalCard()}>
            <p style={{ fontSize: 14, color: DARK, margin: '0 0 20px', lineHeight: 1.5 }}>Discard all changes? This cannot be undone.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDiscardOpen(false)} style={pillBtnOutline('#666')}>Cancel</button>
              <button onClick={discard} style={pillBtn(RED)}>Discard</button>
            </div>
          </div>
        </Overlay>
      )}

      {/* Lock-expired modal */}
      {lockExpired && !committed && (
        <Overlay>
          <div style={modalCard()}>
            <p style={{ fontSize: 15, fontWeight: 600, color: DARK, margin: '0 0 8px' }}>Your edit session has expired.</p>
            <p style={{ fontSize: 13, color: '#888', margin: '0 0 20px' }}>Changes were not saved.</p>
            <button onClick={() => router.push('/restaurant/orders')} style={{ ...pillBtn(BLUE), width: '100%' }}>Return to Orders</button>
          </div>
        </Overlay>
      )}

      {/* Mobile cart drawer */}
      {mobileCartOpen && (
        <div className="eo-mobile-cart">
          <Overlay onClose={() => setMobileCartOpen(false)}>
            <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, maxHeight: '80vh', overflowY: 'auto', background: '#fff', borderRadius: '16px 16px 0 0', padding: 20, fontFamily: F }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, color: DARK, margin: 0 }}>Order Items</h2>
                <button onClick={() => setMobileCartOpen(false)} style={{ background: 'none', border: 'none', fontSize: 22, color: '#999', cursor: 'pointer' }}>×</button>
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                {cart.map(line => <CartRow key={line.lineId} line={line} onInc={() => changeQty(line.lineId, 1)} onDec={() => changeQty(line.lineId, -1)} onRemove={() => removeLine(line.lineId)} onRestore={() => restoreLine(line.lineId)} />)}
              </div>
            </div>
          </Overlay>
        </div>
      )}

      <style>{`
        @media (max-width: 900px) {
          .eo-grid { flex-direction: column; }
          .eo-summary { width: 100% !important; }
          .eo-cart { display: none; }
          .eo-fab { display: inline-block !important; }
        }
      `}</style>
    </div>
  )
}

// ─── Small presentational pieces ─────────────────────────────────────────────
function Row({ label, value, bold, muted, strike }: { label: string; value: string; bold?: boolean; muted?: boolean; strike?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 0' }}>
      <span style={{ fontSize: bold ? 14 : 13, color: muted ? '#999' : (bold ? DARK : '#555'), fontWeight: bold ? 700 : 400 }}>{label}</span>
      <span style={{ fontSize: bold ? 15 : 13, fontWeight: bold ? 700 : 500, color: muted ? '#999' : DARK, textDecoration: strike ? 'line-through' : 'none' }}>{value}</span>
    </div>
  )
}

function CartRow({ line, onInc, onDec, onRemove, onRestore }: { line: EditCartLine; onInc: () => void; onDec: () => void; onRemove: () => void; onRestore: () => void }) {
  const isNew = line.origin === 'new'
  const qtyChanged = line.origin === 'original' && !line.removed && line.quantity !== line.originalQuantity
  const borderColor = line.removed ? RED : isNew ? GREEN : '#eee'
  const lineTotal = lineUnitPrice({ price: line.price, addOns: line.addOns }) * line.quantity
  return (
    <div style={{ border: '1px solid #eee', borderLeft: `3px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', background: '#fff', opacity: line.removed ? 0.7 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: DARK, textDecoration: line.removed ? 'line-through' : 'none' }}>
            {line.name}
            {isNew && <Badge color={GREEN}>NEW</Badge>}
            {line.removed && <Badge color={RED}>REMOVED</Badge>}
          </div>
          {line.serves != null && line.serves !== '' && <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>Serves {line.serves}</div>}
          {line.addOns.filter(a => a.count > 0).map((a, i) => (
            <div key={i} style={{ fontSize: 12, color: '#888', marginTop: 2 }}>({a.count}) {a.name}{a.price > 0 ? ` (+${formatCurrency(a.price)} each)` : ''}</div>
          ))}
          {line.note && <div style={{ fontSize: 12, color: '#aaa', fontStyle: 'italic', marginTop: 4 }}>{line.note}</div>}
          {qtyChanged && <div style={{ fontSize: 12, fontWeight: 700, color: BLUE, marginTop: 4 }}>Qty: {line.originalQuantity} → {line.quantity}</div>}
        </div>
        <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: DARK, textDecoration: line.removed ? 'line-through' : 'none' }}>{formatCurrency(lineTotal)}</div>
          {line.removed ? (
            <button onClick={onRestore} style={{ marginTop: 8, background: 'none', border: 'none', color: BLUE, fontSize: 12, cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>Undo</button>
          ) : (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <button onClick={onDec} style={stepBtn}>−</button>
              <span style={{ fontSize: 13, fontWeight: 600, minWidth: 16, textAlign: 'center' }}>{line.quantity}</span>
              <button onClick={onInc} style={stepBtn}>+</button>
              <button onClick={onRemove} title="Remove" style={{ marginLeft: 4, background: 'none', border: 'none', color: '#bbb', fontSize: 16, cursor: 'pointer' }}>🗑</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Badge({ color, children }: { color: string; children: ReactNode }) {
  return <span style={{ marginLeft: 6, background: color, color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 9, fontWeight: 700, letterSpacing: '0.03em', verticalAlign: 'middle' }}>{children}</span>
}

function ModifierModal({ pkg, onClose, onAdd }: { pkg: FmPackage; onClose: () => void; onAdd: (pkg: FmPackage, qty: number, addOns: EditAddOn[], note?: string) => void }) {
  const groups = (pkg.extraItemsGroups || []).filter(g => g.visible !== false && (g.addOns?.length ?? 0) > 0)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [qty, setQty] = useState(1)
  const [note, setNote] = useState('')

  function setCount(ref: string, n: number) { setCounts(c => ({ ...c, [ref]: Math.max(0, n) })) }
  function groupTotal(g: FmExtraItemsGroup) { return (g.addOns || []).reduce((s, a) => s + (counts[a.reference] || 0), 0) }

  const requiredOk = groups.every(g => {
    const min = g.minSelectedItems ?? (g.subExternalName === 'Required' ? 1 : 0)
    const max = g.maxSelectedItems ?? Infinity
    const t = groupTotal(g)
    return t >= min && t <= max
  })

  const addOns: EditAddOn[] = groups.flatMap(g => (g.addOns || [])
    .filter(a => (counts[a.reference] || 0) > 0)
    .map(a => ({ reference: a.reference, name: a.name, price: a.price, count: counts[a.reference], extraItemsGroupReference: g.reference })))
  const unit = pkg.price + addOns.reduce((s, a) => s + a.price * a.count, 0)

  return (
    <Overlay onClose={onClose}>
      <div style={{ ...modalCard(), maxWidth: 440, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: DARK }}>{pkg.name}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, color: '#999', cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ fontSize: 13, color: '#888', marginBottom: 14 }}>{formatCurrency(pkg.price)}{pkg.description ? ` · ${pkg.description}` : ''}</div>

        {groups.map(g => {
          const min = g.minSelectedItems ?? (g.subExternalName === 'Required' ? 1 : 0)
          const max = g.maxSelectedItems ?? 0
          return (
            <div key={g.reference} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>
                {g.externalName || g.name}
                {min > 0 && <span style={{ color: RED, marginLeft: 6, fontSize: 11 }}>Required</span>}
              </div>
              {max > 0 && <div style={{ fontSize: 11, color: '#999', marginBottom: 6 }}>{groupTotal(g)} of {max} selected</div>}
              <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                {(g.addOns || []).filter(a => a.visible !== false).map(a => (
                  <div key={a.reference} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: '#444' }}>
                    <span>{a.name}{a.price > 0 ? ` (+${formatCurrency(a.price)})` : ''}</span>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <button onClick={() => setCount(a.reference, (counts[a.reference] || 0) - 1)} style={stepBtn}>−</button>
                      <span style={{ minWidth: 16, textAlign: 'center', fontWeight: 600 }}>{counts[a.reference] || 0}</span>
                      <button onClick={() => { if (max <= 0 || groupTotal(g) < max) setCount(a.reference, (counts[a.reference] || 0) + 1) }} style={stepBtn}>+</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}

        {pkg.allowedSpecialInstructions && (
          <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Special instructions…"
            style={{ width: '100%', minHeight: 56, padding: 10, border: '1px solid #e0e0e0', borderRadius: 10, fontSize: 13, fontFamily: F, marginBottom: 12, resize: 'vertical', outline: 'none' }} />
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontSize: 13, color: '#555' }}>Quantity</span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => setQty(q => Math.max(1, q - 1))} style={stepBtn}>−</button>
            <span style={{ fontSize: 14, fontWeight: 700, minWidth: 18, textAlign: 'center' }}>{qty}</span>
            <button onClick={() => setQty(q => q + 1)} style={stepBtn}>+</button>
          </div>
        </div>

        <button disabled={!requiredOk} onClick={() => onAdd(pkg, qty, addOns, note || undefined)}
          style={{ ...pillBtn(BLUE), width: '100%', opacity: requiredOk ? 1 : 0.5, cursor: requiredOk ? 'pointer' : 'default' }}>
          Add to Order — {formatCurrency(unit * qty)}
        </button>
      </div>
    </Overlay>
  )
}

function Overlay({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      {children}
    </div>
  )
}

// ─── Style helpers ────────────────────────────────────────────────────────────
function pillBtn(bg: string): CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 999, padding: '11px 22px', fontSize: 14, fontWeight: 700, fontFamily: F, cursor: 'pointer' }
}
function pillBtnOutline(color: string): CSSProperties {
  return { background: '#fff', color, border: `1px solid ${color}`, borderRadius: 999, padding: '11px 22px', fontSize: 14, fontWeight: 600, fontFamily: F, cursor: 'pointer' }
}
function modalCard(): CSSProperties {
  return { background: '#fff', borderRadius: 16, padding: '24px 26px', maxWidth: 400, width: '100%', fontFamily: F }
}
const stepBtn: CSSProperties = { width: 26, height: 26, borderRadius: 8, border: '1px solid #ddd', background: '#fff', fontSize: 15, cursor: 'pointer', lineHeight: 1, color: DARK }
