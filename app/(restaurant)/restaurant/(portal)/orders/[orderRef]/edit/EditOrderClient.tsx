'use client'

import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
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

// FM dates arrive as DD.MM.YYYY or YYYY-MM-DD; normalize to the YYYY-MM-DD that
// <input type="date"> requires (empty string if unparseable). buildCheckoutPayload's
// toFmDate then converts back to DD.MM.YYYY for FM.
function toIsoDateInput(d: string): string {
  const dmy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d || '')
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
  return ymd ? `${ymd[1]}-${ymd[2]}-${ymd[3]}` : ''
}

// "HH:mm" / "HH:mm:ss" → "9:00 AM". Empty string when unparseable.
function fmt12h(t: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '')
  if (!m) return ''
  let h = Number(m[1])
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${m[2]} ${ampm}`
}

// "2026-06-30" (ISO) → "Jun 30, 2026". Falls back to a dash.
function fmtSummaryDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  if (!m) return '—'
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// "2026-06-30" (ISO) → "Mon, Jun 30" for the picker label.
function fmtWeekdayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// 30-minute pickup/delivery slots, 7:00 AM → 9:00 PM (mirrors customer checkout).
const TIME_SLOTS: { value: string; label: string }[] = (() => {
  const out: { value: string; label: string }[] = []
  for (let mins = 7 * 60; mins <= 21 * 60; mins += 30) {
    const value = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
    out.push({ value, label: fmt12h(value) })
  }
  return out
})()

// Pull canonical money fields out of an FM re-price / order response. FM may
// nest them under checkoutPublicResponseDto or return them flat.
function extractFmMoney(resp: AnyRec | null) {
  const d = ((resp?.checkoutPublicResponseDto as AnyRec) ?? resp ?? {}) as AnyRec
  const tax = num(d.stateSalesTaxInPrice) + num(d.localSalesTaxInPrice) + num(d.otherSalesTaxInPrice)
  const delivery = num(d.ownDeliveryFee) + num(d.doordashDeliveryFee) + num(d.thirdPartyDeliveryFee) || num(d.deliveryFee)
  // FM's tip fields: tipsInPrice = the already-priced DOLLAR tip; tips = the raw
  // input (a percentage integer when tipsType==='PERCENTAGE', else a dollar
  // amount); tipsType disambiguates. We keep all three so the loader can derive
  // the true dollar tip (computeDollarTip).
  const tipsInPrice = num(d.tipsInPrice) + num(d.thirdPartyDeliveryTipsInPrice)
  const tipsRaw = num(d.tips)
  const tipsType = typeof d.tipsType === 'string' ? d.tipsType : ''
  // Combined value preserved for the commit payload's tip encoding (buildPayload).
  const tips = tipsInPrice || tipsRaw
  const fee = num(d.fee) || num(d.fees)
  const discount = num(d.discount)
  const subtotal = typeof d.subtotal === 'number' ? d.subtotal : null
  const total = typeof d.total === 'number' ? d.total : (typeof d.transactionsTotal === 'number' ? d.transactionsTotal : null)
  return { subtotal, tax, delivery, tips, tipsType, tipsRaw, tipsInPrice, fee, discount, total }
}

// Resolve the actual DOLLAR tip from FM's fields. FM's priced tipsInPrice wins
// when present; otherwise derive from tipsType + the raw tips value:
//   PERCENTAGE → subtotal * (tips / 100) · CUSTOM → tips · 0 → 0.
function computeDollarTip(tipsType: string, tipsRaw: number, tipsInPrice: number, subtotal: number): number {
  if (tipsInPrice > 0) return tipsInPrice
  if (tipsRaw <= 0) return 0
  if (tipsType === 'PERCENTAGE') return subtotal * (tipsRaw / 100)
  return tipsRaw // CUSTOM or unspecified → already a dollar amount
}

// Gather the order's line items from an FM /details payload. Items live under
// data.order.orderMealPackages (fall back to order.* and the root). Also tolerate
// orderClassics and the ICheckoutPreview shapes (items / mealPackages).
function collectOrderItems(rec: AnyRec): AnyRec[] {
  const order = ((rec?.data as AnyRec)?.order as AnyRec) ?? (rec?.order as AnyRec) ?? rec
  const mp = Array.isArray(order.orderMealPackages) ? order.orderMealPackages as AnyRec[] : []
  const cl = Array.isArray(order.orderClassics) ? order.orderClassics as AnyRec[] : []
  if (mp.length || cl.length) return [...mp, ...cl]
  if (Array.isArray(order.items) && order.items.length) return order.items as AnyRec[]
  if (Array.isArray(order.mealPackages) && order.mealPackages.length) return order.mealPackages as AnyRec[]
  return []
}

// `context` lets the same editor serve both portals against the same API routes
// (which now accept admin auth): 'restaurant' (default) and 'admin' (super admin
// from the admin portal). It only changes the return path + which localStorage
// user key supplies the editor email + how the restaurant ref is resolved.
export default function EditOrderClient({ orderRef, context = 'restaurant' }: { orderRef: string; context?: 'restaurant' | 'admin' }) {
  const router = useRouter()
  const isAdmin = context === 'admin'
  const returnPath = isAdmin ? '/admin/manage-orders' : '/restaurant/orders'
  const editorStorageKey = isAdmin ? 'admin_user' : 'restaurant_user'

  // ─── Lifecycle / load state ───────────────────────────────────────────────
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<{ message: string; status?: number; body?: string } | null>(null)

  // Resolved client-side (localStorage / details response), not passed in.
  const [restaurantRef, setRestaurantRef] = useState('')
  const [menuData, setMenuData] = useState<MenuSection[]>([])

  // ─── Order / cart state ───────────────────────────────────────────────────
  const [cart, setCart] = useState<EditCartLine[]>([])
  const [orderType, setOrderType] = useState<'PICKUP' | 'DELIVERY'>('PICKUP')
  const [orderDate, setOrderDate] = useState('')   // YYYY-MM-DD
  const [orderTime, setOrderTime] = useState('')   // HH:mm:ss
  const [deliveryAddress, setDeliveryAddress] = useState<DeliveryAddr | null>(null)
  const [origTotal, setOrigTotal] = useState(0)
  const [origMoney, setOrigMoney] = useState({ subtotal: 0, tax: 0, delivery: 0, tips: 0, dollarTip: 0, fee: 0, discount: 0, total: 0 })
  const [taxExempt, setTaxExempt] = useState(false)
  const [orderNumber, setOrderNumber] = useState('')

  // ─── Reschedule (date/time) modal ─────────────────────────────────────────
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [draftDate, setDraftDate] = useState('')   // YYYY-MM-DD
  const [draftTime, setDraftTime] = useState('')   // HH:mm
  const origDt = useRef({ date: '', time: '' })     // normalized loaded date/time

  const lineCounter = useRef(0)

  // ─── Edit eligibility (Disco-native — no FM lock) ─────────────────────────
  const [editCount, setEditCount] = useState(0)
  const [canEdit, setCanEdit] = useState(true)
  const [editReason, setEditReason] = useState('')

  // ─── Commit / discard / UI ────────────────────────────────────────────────
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [committed, setCommitted] = useState(false)
  const [invoicedNotice, setInvoicedNotice] = useState(false)
  const [pendingPayment, setPendingPayment] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)

  // ─── Menu browse UI ───────────────────────────────────────────────────────
  const [activeMenuIdx, setActiveMenuIdx] = useState(0)
  const [search, setSearch] = useState('')
  const [modalPkg, setModalPkg] = useState<FmPackage | null>(null)

  const newLineId = () => `line-${++lineCounter.current}`

  // ─── Build cart line from an FM order meal-package ────────────────────────
  const orderLineToCart = useCallback((mp: AnyRec): EditCartLine => {
    // The /details endpoint may nest the package under `mealPackage` and use
    // alternate field names — read defensively across known shapes.
    const nested = (mp.mealPackage as AnyRec | undefined) ?? undefined
    const qty = num(mp.count) || num(mp.quantity) || 1
    const toAddOn = (a: AnyRec, groupRef?: string, defaultCount = 1): EditAddOn => ({
      reference: str(a.reference) || str(a.addOnReference),
      name: str(a.name) || str(a.addOnName),
      price: num(a.price),
      count: num(a.count) || num(a.quantity) || defaultCount,
      extraItemsGroupReference: groupRef || str(a.extraItemsGroupReference) || undefined,
    })
    // Add-ons may be a flat list (orderAddOns/extraItems/addOns) or nested under
    // extraItemsGroups[].addOns — flatten the grouped shape and keep only selected.
    const flat = Array.isArray(mp.orderAddOns) ? mp.orderAddOns
      : Array.isArray(mp.extraItems) ? mp.extraItems
      : Array.isArray(mp.addOns) ? mp.addOns : null
    const addOns: EditAddOn[] = flat
      ? (flat as AnyRec[]).map(a => toAddOn(a))
      : (Array.isArray(mp.extraItemsGroups) ? mp.extraItemsGroups as AnyRec[] : [])
          .flatMap(g => (Array.isArray(g.addOns) ? g.addOns as AnyRec[] : [])
            .map(a => toAddOn(a, str(g.reference) || undefined, 0))
            .filter(a => a.count > 0))
    return {
      lineId: newLineId(),
      reference: str(mp.reference) || str(mp.mealPackageReference) || str(nested?.reference),
      name: str(mp.name) || str(mp.mealPackageName) || str(nested?.name),
      price: num(mp.price) || num(mp.mealPackagePrice) || num(nested?.price),
      quantity: qty,
      addOns,
      note: str(mp.comment) || str(mp.specialInstructions) || undefined,
      serves: (mp.serves as string | number | null) ?? (nested?.serves as string | number | null) ?? null,
      origin: 'original',
      originalQuantity: qty,
      removed: false,
    }
  }, [])

  // ─── Client-side menu loader (best effort — details is the critical path) ──
  const loadMenu = useCallback(async (ref: string) => {
    if (!ref) return
    try {
      const mRes = await fetch(`/api/fm-menu?ref=${encodeURIComponent(ref)}`)
      if (!mRes.ok) { console.error('[edit-client] fm-menu failed', { ref, status: mRes.status }); return }
      const menus = await mRes.json()
      if (!Array.isArray(menus) || !menus.length) return
      const ordered = [...menus].sort((a, b) => {
        const pa = typeof a?.position === 'number' ? a.position : Number.MAX_SAFE_INTEGER
        const pb = typeof b?.position === 'number' ? b.position : Number.MAX_SAFE_INTEGER
        return pa - pb
      })
      const sections: MenuSection[] = []
      for (const menu of ordered) {
        const pRes = await fetch(`/api/fm-packages?restaurantRef=${encodeURIComponent(ref)}&menuRef=${encodeURIComponent(menu.reference)}`)
        if (!pRes.ok) continue
        const cats = await pRes.json()
        sections.push({ menu, categories: Array.isArray(cats) ? cats : [] })
      }
      setMenuData(sections)
      console.log('[edit-client] menu loaded', { ref, sections: sections.length })
    } catch (err) {
      console.error('[edit-client] menu load threw', err)
    }
  }, [])

  // ─── PAGE LOAD: details → prepopulate → acquire lock → menu ───────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        console.log('[edit-client] loading details', { orderRef })
        const res = await fetch(`/api/restaurant/orders/${orderRef}/details`)
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          console.error('[edit-client] details fetch failed', { orderRef, status: res.status, body: body.slice(0, 1500) })
          if (!cancelled) {
            setLoadError({ message: 'The order details request failed.', status: res.status, body: body.slice(0, 2000) })
            setLoading(false)
          }
          return
        }
        const o = (await res.json()) as AnyRec
        if (cancelled) return
        // FM /details nests the order under data.order (fall back to order / root).
        const order = ((o?.data as AnyRec)?.order as AnyRec) ?? (o?.order as AnyRec) ?? o
        console.log('[edit-client] details loaded', {
          orderRef,
          orderNumber: order.orderNumber,
          mealPackages: Array.isArray(order.orderMealPackages) ? order.orderMealPackages.length : 0,
          classics: Array.isArray(order.orderClassics) ? order.orderClassics.length : 0,
          orderType: order.orderType, orderDate: order.orderDate, orderTime: order.orderTime,
        })

        // Resolve the restaurant ref client-side: the restaurant portal prefers
        // its selected location; the admin portal has no such selection, so it
        // always uses the order's own restaurant from the details payload.
        const fromStorage = (!isAdmin && typeof window !== 'undefined') ? (localStorage.getItem('selectedRestaurant') || '') : ''
        const fromDetails = str(order.restaurantReference) || str((order.restaurant as AnyRec | undefined)?.reference)
        const rr = fromStorage || fromDetails
        console.log('[edit-client] restaurantRef resolved', { fromStorage, fromDetails, used: rr })
        if (rr) setRestaurantRef(rr)

        // Pre-fill the cart with the order's existing items (data.order.orderMealPackages).
        const mps = collectOrderItems(o)
        console.log('[edit-client] cart items resolved', { count: mps.length })
        setCart(mps.map(orderLineToCart))

        setOrderType(str(order.orderType) === 'DELIVERY' || str(order.deliveryType).includes('DELIVERY') ? 'DELIVERY' : 'PICKUP')
        setOrderDate(str(order.orderDate))
        setOrderTime(str(order.orderTime))
        setOrderNumber(order.orderNumber != null && order.orderNumber !== '' ? String(order.orderNumber) : '')
        origDt.current = { date: toIsoDateInput(str(order.orderDate)), time: str(order.orderTime).slice(0, 5) }
        setTaxExempt(order.taxExempt === true)

        const da = order.deliveryAddress as AnyRec | undefined
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

        const money = extractFmMoney(order)
        // The real dollar tip — NOT the raw tips field (a percentage integer for
        // PERCENTAGE tips). Used for the tax-rate/total math + the Tip display.
        const dollarTip = computeDollarTip(money.tipsType, money.tipsRaw, money.tipsInPrice, money.subtotal ?? 0)
        setOrigMoney({
          subtotal: money.subtotal ?? 0, tax: money.tax, delivery: money.delivery,
          tips: money.tips, dollarTip, fee: money.fee, discount: money.discount, total: money.total ?? 0,
        })
        setOrigTotal(money.total ?? num(order.transactionsTotal))

        // Check edit eligibility (Disco-native — pickup >24hrs, <3 edits, status).
        try {
          const esRes = await fetch(`/api/restaurant/orders/${orderRef}/edit-status`)
          if (esRes.ok && !cancelled) {
            const es = (await esRes.json()) as AnyRec
            setEditCount(num(es.editCount))
            setCanEdit(es.canEdit !== false)
            setEditReason(str(es.reason))
            // Amber "awaiting payment" only when a pending invoice is still open.
            // A clean order (edit_status null) never shows it. If the invoice was
            // already paid, edit-status applied the edit, so this is false.
            setPendingPayment(es.pendingPayment === true)
          }
        } catch { /* best-effort — default to editable */ }
        if (cancelled) return
        setLoading(false)

        // Load the menu (non-blocking — the editor is usable without it).
        if (rr) loadMenu(rr)
      } catch (err) {
        console.error('[edit-client] load sequence threw', { orderRef, err })
        if (!cancelled) {
          setLoadError({ message: err instanceof Error ? err.message : 'Could not load this order for editing.' })
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderRef])

  // (No FM edit lock — the Disco-native edit flow has no lock/timer/refresh.)

  // ─── Cart math / diff ─────────────────────────────────────────────────────
  const activeLines = useMemo(() => cart.filter(l => !l.removed), [cart])
  const cartChanged = useMemo(
    () => cart.some(l => l.origin === 'new' || l.removed || l.quantity !== l.originalQuantity),
    [cart]
  )
  // Date/time differs from what we loaded → also counts as a change (drives the
  // "changed" UI and triggers a re-price).
  const rescheduled = toIsoDateInput(orderDate) !== origDt.current.date || (orderTime || '').slice(0, 5) !== origDt.current.time
  const changed = cartChanged || rescheduled

  // (The Disco-native edit POST sends activeLines/date/time directly — no FM
  // checkout payload is built client-side anymore.)

  // ─── Totals: client-side estimate ─────────────────────────────────────────
  // No live FM re-price (it caused 404s + wrong initial totals). We derive a
  // blended tax/fee rate from the loaded order and apply it to the edited cart.
  // Display only — FM settles the real payment delta server-side on commit.
  const cartEmpty = activeLines.length === 0

  // Original order baseline (from the /details fetch). Tip is the real DOLLAR
  // tip (origMoney.dollarTip), not the raw percentage integer — otherwise the
  // tax/fee back-out and the displayed Tip would be wrong on percentage tips.
  const origSubtotal = origMoney.subtotal
  const origTip = origMoney.dollarTip
  const origDeliveryFee = origMoney.delivery
  // Everything between subtotal and total that isn't tip/delivery → tax + fees.
  const origTaxAndFee = origTotal - origSubtotal - origTip - origDeliveryFee
  const taxRate = origSubtotal > 0 ? origTaxAndFee / origSubtotal : 0

  // New display values from the current cart (line price includes add-ons).
  const newSubtotal = cartEmpty ? 0 : cartSubtotal(activeLines.map(l => ({ price: l.price, count: l.quantity, addOns: l.addOns })))
  const taxesFees = cartEmpty ? 0 : Math.round(newSubtotal * taxRate * 100) / 100
  const delivery = cartEmpty ? 0 : origDeliveryFee
  const tip = cartEmpty ? 0 : origTip
  const newTotal = cartEmpty ? 0 : newSubtotal + taxesFees + delivery + tip
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
  // Removing an original line keeps it tracked as removed (excluded from the
  // payload via activeLines) but hidden from the cart; new lines just vanish.
  function removeLine(lineId: string) {
    setCart(prev => prev.flatMap(l => {
      if (l.lineId !== lineId) return [l]
      if (l.origin === 'new') return []
      return [{ ...l, removed: true }]
    }))
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
  }

  // Does this package need the modifier modal (has add-on groups or allows notes)?
  function pkgHasModifiers(pkg: FmPackage) {
    return (Array.isArray(pkg.extraItemsGroups) && pkg.extraItemsGroups.some(g => g.visible !== false && (g.addOns?.length ?? 0) > 0)) || !!pkg.allowedSpecialInstructions
  }

  // ─── Inline menu-row stepper helpers ──────────────────────────────────────
  // Aggregate qty for a package across all of its active cart lines.
  const cartQtyForPkg = (ref: string) => activeLines.filter(l => l.reference === ref).reduce((s, l) => s + l.quantity, 0)
  // The plain (no add-ons / no note) line for a package — what the inline
  // stepper drives. Modifier configs are managed from the cart panel / modal.
  const simpleLineFor = (ref: string) => cart.find(l => !l.removed && l.reference === ref && l.addOns.length === 0 && !l.note)

  function incPkg(pkg: FmPackage) {
    // Items with modifiers can't be blindly +1'd — open the modal to configure.
    if (pkgHasModifiers(pkg)) { setModalPkg(pkg); return }
    const line = simpleLineFor(pkg.reference)
    if (line) changeQty(line.lineId, 1)
    else addToCart(pkg, 1, [])
  }
  function decPkg(pkg: FmPackage) {
    const line = simpleLineFor(pkg.reference)
    if (line) { changeQty(line.lineId, -1); return }
    // No plain line (only modifier lines) — step down the first matching line.
    const any = activeLines.find(l => l.reference === pkg.reference)
    if (any) changeQty(any.lineId, -1)
  }

  // ─── Commit (Disco-native edit API) ───────────────────────────────────────
  async function commit() {
    if (committing) return
    // 3-edit cap applies to every role (incl. SUPER_ADMIN). Block + message
    // client-side; the server enforces the same limit.
    if (editCount >= 3) { setCommitError('Maximum edits reached for this order.'); return }
    if (!canEdit) return
    setCommitError(null)
    setCommitting(true)
    try {
      let editorEmail = ''
      try { editorEmail = JSON.parse(localStorage.getItem(editorStorageKey) || '{}')?.email || '' } catch { /* ignore */ }
      const res = await fetch(`/api/restaurant/orders/${orderRef}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activeLines: activeLines.map(l => ({ reference: l.reference, name: l.name, price: l.price, quantity: l.quantity, serves: l.serves ?? null })),
          orderDate: toIsoDateInput(orderDate),
          orderTime,
          editorEmail,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as AnyRec
      if (!res.ok) throw new Error(str(data.error) || 'Could not commit the edit.')

      // Every successful outcome returns to the orders list with a green banner.
      // The invoice path (pending_payment) shows an "invoice sent" message; a
      // direct charge or a no-delta reschedule shows the plain success message.
      const invoiced = str(data.status) === 'pending_payment'
      setInvoicedNotice(invoiced)
      setCommitted(true)
      const qp = new URLSearchParams({ editSuccess: 'true', editOutcome: invoiced ? 'invoiced' : 'success' })
      if (orderNumber) qp.set('orderNumber', orderNumber)
      setTimeout(() => router.push(`${returnPath}?${qp.toString()}`), 1500)
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Something went wrong committing the edit.')
      setCommitting(false)
    }
  }

  // ─── Discard ──────────────────────────────────────────────────────────────
  function discard() {
    router.push(returnPath)
  }

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
      <div style={{ fontFamily: F, maxWidth: 720, margin: '0 auto', padding: '48px 20px' }}>
        <h2 style={{ color: RED, fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>Could not load this order for editing</h2>
        <p style={{ color: DARK, fontSize: 14, margin: '0 0 14px' }}>{loadError.message}</p>
        <div style={{ display: 'grid', gap: 8, marginBottom: 20 }}>
          <ErrLine label="Order ref" value={orderRef} />
          {loadError.status != null && <ErrLine label="HTTP status" value={String(loadError.status)} />}
        </div>
        {loadError.body && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#888', marginBottom: 6 }}>Response body</div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#FAFAFC', border: '1px solid #eee', borderRadius: 10, padding: 14, fontSize: 12, color: '#444', margin: 0, maxHeight: 320, overflow: 'auto' }}>
              {loadError.body}
            </pre>
          </div>
        )}
        <button onClick={() => router.push(returnPath)} style={pillBtn(BLUE)}>Return to Orders</button>
      </div>
    )
  }

  return (
    <div style={{ fontFamily: F, paddingBottom: 40 }}>
      <style>{`@keyframes eoSpin{to{transform:rotate(360deg)}}`}</style>

      {/* ── Sticky edit info bar (blue) + edit-count ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 50, background: '#EEF0FD', color: DARK,
        borderBottom: '1px solid #dfe3fb',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
        gap: 8, padding: '10px 18px', fontSize: 13, fontWeight: 600,
      }}>
        <span>Editing Order #{orderNumber || orderRef.slice(0, 8)} — changes are not saved until you click Update Order.</span>
        <span style={{ fontWeight: 700, color: editCount >= 2 ? GOLD : BLUE }}>
          {editCount >= 2 ? 'Last edit remaining' : `Edit ${editCount + 1} of 3`}
        </span>
      </div>

      {/* ── Read-only notice (ineligible) ── */}
      {!canEdit && (
        <div style={{ background: '#fff3f3', color: '#c0392b', borderBottom: '1px solid #ffd6d6', padding: '10px 18px', fontSize: 14, fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>This order can no longer be edited{editReason ? ` — ${editReason}.` : '.'}</span>
          <button onClick={() => router.push(returnPath)} style={{ background: '#fff', border: '1px solid #f0bdbd', color: '#c0392b', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>Return to Orders</button>
        </div>
      )}

      {/* ── Pending-payment banner (amber) ── */}
      {pendingPayment && (
        <div style={{ background: GOLD, color: DARK, padding: '10px 18px', fontSize: 14, fontWeight: 600 }}>
          Order saved — awaiting customer payment. The customer has been sent an invoice for the difference.
        </div>
      )}

      {/* ── Success banner ── */}
      {committed && (
        <div style={{ background: GREEN, color: '#fff', padding: '10px 18px', fontSize: 14, fontWeight: 600 }}>
          {invoicedNotice
            ? 'Order updated — an invoice for the difference was sent to the customer. Returning to orders…'
            : 'Order updated successfully. Returning to orders…'}
        </div>
      )}

      {/* ── Two columns: menu (left ~60%) + cart & summary (right ~40%) ── */}
      <div className="eo-grid" style={{ display: 'flex', gap: 20, padding: '20px', alignItems: 'flex-start', pointerEvents: canEdit ? undefined : 'none', opacity: canEdit ? 1 : 0.55 }}>

        {/* LEFT — menu browser */}
        <div className="eo-menu" style={{ flex: '1 1 60%', minWidth: 0 }}>
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
                {cat.mealPackages.filter(p => p.available !== false).map(pkg => {
                  const qty = cartQtyForPkg(pkg.reference)
                  return (
                    <div key={pkg.reference} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, border: `1px solid ${qty > 0 ? BLUE : '#eee'}`, borderRadius: 12, padding: '12px 14px', background: '#fff' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{pkg.name}</div>
                        {pkg.serves != null && pkg.serves !== '' && <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>Serves {pkg.serves}</div>}
                        {pkg.description && <div style={{ fontSize: 12, color: '#888', marginTop: 4, lineHeight: 1.4 }}>{pkg.description}</div>}
                      </div>
                      <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 6 }}>{formatCurrency(pkg.price)}</div>
                        {qty > 0 ? (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <button onClick={() => decPkg(pkg)} style={stepBtn} aria-label="Decrease">−</button>
                            <span style={{ fontSize: 13, fontWeight: 700, minWidth: 16, textAlign: 'center' }}>{qty}</span>
                            <button onClick={() => incPkg(pkg)} style={stepBtn} aria-label="Increase">+</button>
                          </div>
                        ) : (
                          <button onClick={() => incPkg(pkg)} style={{ ...pillBtn(BLUE), padding: '6px 16px', fontSize: 13 }}>Add</button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* RIGHT — cart + order summary (sticky, scrolls internally) */}
        <div className="eo-summary" style={{ flex: '1 1 40%', maxWidth: 420, minWidth: 300 }}>
          <div className="eo-summary-card" style={{ position: 'sticky', top: 64, maxHeight: 'calc(100vh - 84px)', overflowY: 'auto', background: '#fff', border: '1px solid #eee', borderRadius: 14, padding: '18px 18px 20px' }}>

            {/* Cart items */}
            <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 12 }}>Order Items</div>
            {activeLines.length === 0
              ? <p style={{ color: '#999', fontSize: 14, margin: '0 0 4px' }}>No items.</p>
              : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {activeLines.map(line => <CartRow key={line.lineId} line={line} onInc={() => changeQty(line.lineId, 1)} onDec={() => changeQty(line.lineId, -1)} onRemove={() => removeLine(line.lineId)} />)}
                </div>
              )}

            <div style={{ height: 1, background: '#eee', margin: '14px 0' }} />

            {/* Schedule + reschedule */}
            <div style={{ marginBottom: 14, padding: '10px 12px', border: `1px solid ${rescheduled ? BLUE : '#eee'}`, borderRadius: 10, background: rescheduled ? 'rgba(91,111,232,0.06)' : '#fafafc' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: '#999', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {orderType === 'DELIVERY' ? 'Delivery' : 'Pickup'}
                    {rescheduled && <span style={{ marginLeft: 6, color: BLUE, fontWeight: 700 }}>• Changed</span>}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginTop: 2 }}>
                    {fmtSummaryDate(toIsoDateInput(orderDate))} · {fmt12h(orderTime) || '—'}
                  </div>
                </div>
                <button
                  onClick={() => { setDraftDate(toIsoDateInput(orderDate)); setDraftTime((orderTime || '').slice(0, 5)); setRescheduleOpen(true) }}
                  style={{ background: 'none', border: `1px solid ${BLUE}`, color: BLUE, borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
                  Reschedule
                </button>
              </div>
            </div>

            <Row label="Original Total" value={formatCurrency(origTotal)} muted strike={changed} />
            <Row label="New Total" value={formatCurrency(newTotal)} bold />

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
            {delivery > 0 && <Row label="Delivery" value={formatCurrency(delivery)} />}
            <Row label="Tip" value={formatCurrency(tip)} />
            <div style={{ height: 1, background: '#eee', margin: '14px 0' }} />
            <Row label="Total" value={formatCurrency(newTotal)} bold />

            {commitError && (
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'rgba(231,111,81,0.1)', color: RED, fontSize: 12, lineHeight: 1.4 }}>
                {commitError}
              </div>
            )}

            <button onClick={commit} disabled={committing || committed || pendingPayment || !canEdit || editCount >= 3}
              style={{ ...pillBtn(BLUE), width: '100%', marginTop: 16, opacity: (committing || committed || pendingPayment || !canEdit || editCount >= 3) ? 0.6 : 1, cursor: (committing || committed || pendingPayment || !canEdit || editCount >= 3) ? 'default' : 'pointer' }}>
              {committing ? 'Saving changes…' : 'Update Order'}
            </button>
            <button onClick={() => setDiscardOpen(true)} disabled={committing || committed}
              style={{ ...pillBtnOutline('#666'), width: '100%', marginTop: 10 }}>
              Cancel
            </button>
          </div>
        </div>
      </div>

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

      {/* Reschedule modal — plain date + time pickers (any future slot). */}
      {rescheduleOpen && (
        <Overlay onClose={() => setRescheduleOpen(false)}>
          <div style={modalCard()} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: DARK }}>Reschedule order</div>
              <button onClick={() => setRescheduleOpen(false)} style={{ background: 'none', border: 'none', fontSize: 22, color: '#999', cursor: 'pointer' }}>×</button>
            </div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#777', marginBottom: 6 }}>
              Date{draftDate ? ` · ${fmtWeekdayDate(draftDate)}` : ''}
            </label>
            <input type="date" value={draftDate} min={new Date().toISOString().slice(0, 10)} onChange={e => setDraftDate(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #e0e0e0', borderRadius: 10, fontSize: 14, fontFamily: F, marginBottom: 14, outline: 'none', boxSizing: 'border-box' }} />
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#777', marginBottom: 6 }}>Time</label>
            <select value={draftTime} onChange={e => setDraftTime(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #e0e0e0', borderRadius: 10, fontSize: 14, fontFamily: F, marginBottom: 20, outline: 'none', boxSizing: 'border-box', background: '#fff', color: DARK }}>
              <option value="">Select a time…</option>
              {TIME_SLOTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setRescheduleOpen(false)} style={pillBtnOutline('#666')}>Cancel</button>
              <button
                disabled={!draftDate || !draftTime}
                onClick={() => {
                  setOrderDate(draftDate)
                  setOrderTime(draftTime.length === 5 ? `${draftTime}:00` : draftTime)
                  setRescheduleOpen(false)
                }}
                style={{ ...pillBtn(BLUE), opacity: (!draftDate || !draftTime) ? 0.5 : 1, cursor: (!draftDate || !draftTime) ? 'default' : 'pointer' }}>
                Update date &amp; time
              </button>
            </div>
          </div>
        </Overlay>
      )}

      <style>{`
        @media (max-width: 900px) {
          .eo-grid { flex-direction: column; }
          .eo-menu, .eo-summary { flex: 1 1 100% !important; max-width: 100% !important; min-width: 0 !important; }
          .eo-summary-card { position: static !important; max-height: none !important; }
        }
      `}</style>
    </div>
  )
}

// ─── Small presentational pieces ─────────────────────────────────────────────
function ErrLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 13 }}>
      <span style={{ color: '#888', minWidth: 90 }}>{label}</span>
      <span style={{ color: DARK, fontFamily: 'monospace', wordBreak: 'break-all' }}>{value}</span>
    </div>
  )
}

function Row({ label, value, bold, muted, strike, pending }: { label: string; value: string; bold?: boolean; muted?: boolean; strike?: boolean; pending?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 0' }}>
      <span style={{ fontSize: bold ? 14 : 13, color: muted ? '#999' : (bold ? DARK : '#555'), fontWeight: bold ? 700 : 400 }}>{label}</span>
      <span style={{ fontSize: bold ? 15 : 13, fontWeight: bold ? 700 : 500, color: muted ? '#999' : DARK, textDecoration: strike ? 'line-through' : 'none', opacity: pending ? 0.4 : 1, transition: 'opacity 0.15s' }}>{value}</span>
    </div>
  )
}

// Clean current-items row — no diff styling. Removed originals are filtered out
// upstream (activeLines), so a row here is always an active item.
function CartRow({ line, onInc, onDec, onRemove }: { line: EditCartLine; onInc: () => void; onDec: () => void; onRemove: () => void }) {
  const lineTotal = lineUnitPrice({ price: line.price, addOns: line.addOns }) * line.quantity
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 10, padding: '12px 14px', background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{line.name}</div>
          {line.serves != null && line.serves !== '' && <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>Serves {line.serves}</div>}
          {line.addOns.filter(a => a.count > 0).map((a, i) => (
            <div key={i} style={{ fontSize: 12, color: '#888', marginTop: 2 }}>({a.count}) {a.name}{a.price > 0 ? ` (+${formatCurrency(a.price)} each)` : ''}</div>
          ))}
          {line.note && <div style={{ fontSize: 12, color: '#aaa', fontStyle: 'italic', marginTop: 4 }}>{line.note}</div>}
        </div>
        <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{formatCurrency(lineTotal)}</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button onClick={onDec} style={stepBtn}>−</button>
            <span style={{ fontSize: 13, fontWeight: 600, minWidth: 16, textAlign: 'center' }}>{line.quantity}</span>
            <button onClick={onInc} style={stepBtn}>+</button>
            <button onClick={onRemove} title="Remove" aria-label="Remove" style={{ marginLeft: 4, background: 'none', border: 'none', color: '#bbb', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
          </div>
        </div>
      </div>
    </div>
  )
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
