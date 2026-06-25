'use client'
import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import GenerateReportButton from '../_components/GenerateReportButton'
import { printOrder, type PrintableOrder } from '../_components/PrintOrderDocument'
import {
  lineQty, lineRowTotal, lineModifiers, modifierQty, modifierRowTotal, formatCurrency,
} from '../../../../../lib/pricing/lineItem'
import { getOrderSourceBadge } from '../../../../../lib/order-utils'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
// Disco-brand gradient text (used for the Disco promo line).
const GRADIENT_TEXT: React.CSSProperties = { background: 'linear-gradient(90deg, #6B6EF9, #C044C8, #F0468A)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExtraItem {
  name?: string
  count?: number
  quantity?: number
  price?: number
}

interface OrderMealPackage {
  name?: string
  /** FM emits `count` on /api/orders/{ref}; `quantity` was a Disco-Cater
   *  legacy alias that doesn't actually exist on the response, which is
   *  why the drawer used to render every line as qty 1. */
  count?: number
  quantity?: number
  price?: number
  /** FM emits `orderAddOns`; `extraItems` was a similar legacy alias. */
  orderAddOns?: ExtraItem[]
  extraItems?: ExtraItem[]
  specialInstructions?: string
  comment?: string
  classicModifier?: { name?: string }
}

interface Order {
  // list-shape (used by table rows)
  orderReference: string
  orderNumber: number
  firstName: string
  lastName: string
  // Present on the aggregated /api/system-admin/orders response so the
  // SA can see which location each order belongs to (Track 1).
  restaurantName?: string
  orderDate: string
  orderTime: string
  orderCreatedDate: string
  restaurantTimezone: string
  persons?: number
  orderType: string
  deliveryType: string
  transactionsTotal: number
  orderStatus: string
  orderSeenByAdmin: boolean
  orderStatusesToChange: string[]
  nashDeliveryStatus?: string
  nashDeliveryPickupEta?: string
  nashDeliveryDropoffEta?: string
  nashDeliveryPublicTrackingUrl?: string
  maxAllowedRefundAmount?: number
  note?: string
  // FM wire attribution: "DISCO" (3P, marketplace, lead-gen fee) or
  // "FAMILYMEAL" (1P, restaurant's own direct link). It's already on the FM
  // response — the old type just dropped it. Rendered as a "3P"/"1P" pill;
  // never show the raw value.
  sourceoforder?: string

  // Disco-native edit state, returned directly from Neon (disco_orders) by the
  // orders list API. editCount caps edits at 3 for ALL roles (incl. SUPER_ADMIN).
  editCount?: number
  editStatus?: string | null

  // Recurring-order indicators. FM surfaces "this order is part of a recurring
  // series" under different keys depending on deployment, so any truthy one of
  // these marks the order as recurring (see isRecurringOrder).
  orderSubscription?: unknown
  isRecurring?: boolean
  subscriptionReference?: string
  recurring?: boolean

  // detail-shape additions (returned by GET /api/orders/{ref})
  email?: string
  phoneNumber?: string
  total?: number
  subtotal?: number
  serviceCharge?: number
  fee?: number
  fees?: number
  ownDeliveryFee?: number
  doordashDeliveryFee?: number
  thirdPartyDeliveryFee?: number
  tipsInPrice?: number
  thirdPartyDeliveryTipsInPrice?: number
  stateSalesTaxInPrice?: number
  localSalesTaxInPrice?: number
  otherSalesTaxInPrice?: number
  taxExempt?: boolean
  taxExemptId?: string
  discount?: number
  refund?: number
  orderDropOffTime?: string
  resultTrackingLink?: string
  restaurant?: {
    businessName?: string
    timezone?: string
    deliveryOrderTimeWindows?: string
    feeCategories?: { displayFeeCategoriesName?: string }[]
    address?: { addressLine1?: string; phoneNumber?: string; city?: string; state?: string; zipcode?: string }
  }
  deliveryAddress?: {
    addressLine1?: string; city?: string; state?: string; zipcode?: string; deliveryInstructions?: string
  }
  orderMealPackages?: OrderMealPackage[]
  orderClassics?: OrderMealPackage[]
}

interface SalesStatItem {
  addOnName?: string
  mealPackageName?: string
  count: number
  price: number
  total: number
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = ['DUE', 'UNPAID', 'PAID']
const HISTORY_STATUSES = ['COMPLETED', 'REOPEN', 'CANCELED', 'EXPIRED', 'RESERVED', 'VOID', 'VOIDED', 'REFUND', 'PARTIAL_REFUND']
const COUNTS_STATUSES = ['COMPLETED', 'DUE']
const TERMINAL = new Set(['EXPIRED', 'REOPEN', 'REFUND', 'PARTIAL_REFUND', 'CANCELED', 'VOID', 'VOIDED'])

const STATUS_LABEL: Record<string, string> = {
  DUE: 'Due', COMPLETED: 'Completed', REOPEN: 'Reopened', REFUND: 'Refunded',
  PARTIAL_REFUND: 'Partial refunded', CANCELED: 'Canceled', EXPIRED: 'Expired',
  RESERVED: 'Reserved', VOID: 'Voided', VOIDED: 'Voided', PAID: 'Paid', UNPAID: 'Unpaid',
}

// Restaurant-local timezone for pickup/delivery eligibility checks. The orders
// API doesn't surface a per-restaurant timezone yet, so we fall back to a safe
// default (Eastern) and prefer any tz that does come through on the order.
const RESTAURANT_TZ_DEFAULT = 'America/New_York'

// Current wall-clock time in `tz`, as a zero-padded 'YYYY-MM-DDTHH:MM:SS'
// string. Because order_date/order_time are also stored as naked wall-clock in
// the restaurant's tz, two such strings compare chronologically as plain text.
function nowWallClockInTz(tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = (t: string) => parts.find(p => p.type === t)?.value || '00'
  let hh = get('hour')
  if (hh === '24') hh = '00' // some engines emit '24' for midnight under hour12:false
  return `${get('year')}-${get('month')}-${get('day')}T${hh}:${get('minute')}:${get('second')}`
}

// True once the order's pickup/delivery datetime (order_date + order_time, in
// the restaurant's tz) has passed — the gate for showing the Void action.
function isPastPickup(order: Order): boolean {
  if (!order.orderDate || !order.orderTime) return false
  // FM sometimes returns dates as DD.MM.YYYY — normalize to YYYY-MM-DD first.
  const date = order.orderDate.includes('.') ? order.orderDate.split('.').reverse().join('-') : order.orderDate
  const time = order.orderTime.length === 5 ? `${order.orderTime}:00` : order.orderTime.slice(0, 8)
  const orderWall = `${date}T${time}`
  const tz = order.restaurantTimezone || order.restaurant?.timezone || RESTAURANT_TZ_DEFAULT
  return nowWallClockInTz(tz) >= orderWall
}

// FM's fm-types pipe maps both NASH_DELIVERY and DLIVRD_DELIVERY to
// "Third-Party Delivery" — it never surfaces the provider name (Nash/Dlivrd).
const DELIVERY_LABEL: Record<string, string> = {
  OWN_DELIVERY: 'Self-Delivery', NASH_DELIVERY: 'Third-Party Delivery',
  DOOR_DASH_DELIVERY: 'DoorDash Delivery', DLIVRD_DELIVERY: 'Third-Party Delivery',
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

function fmtTime(t: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

// Recurring detection — FM surfaces the indicator under different keys across
// deployments, so any truthy one of these marks the order as recurring.
function isRecurringOrder(o: {
  orderSubscription?: unknown; isRecurring?: boolean; subscriptionReference?: string; recurring?: boolean
}): boolean {
  return !!(o.orderSubscription || o.isRecurring || o.subscriptionReference || o.recurring)
}

function RecurringBadge() {
  return (
    <span style={{
      display: 'inline-block', marginLeft: 6, padding: '1px 6px', borderRadius: 6,
      fontSize: 10, fontWeight: 700, verticalAlign: 'middle', color: '#fff', background: '#5B6FE8',
    }}
      title="Part of a recurring order">
      🔄 Recurring
    </span>
  )
}

function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-')
  return `${mo}/${day}/${y}`
}

// Subtle 1P/3P pill for the orders-list SOURCE column.
//   FAMILYMEAL → 1P (first-party / direct)   ·   DISCO → 3P (marketplace)
function SourcePill({ source }: { source: string }) {
  const s = (source || '').trim().toUpperCase()
  if (!s) return <span style={{ color: '#ccc' }}>—</span>
  const label = s === 'DISCO' ? '3P' : s === 'FAMILYMEAL' ? '1P' : s
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 400,
      padding: '2px 8px', borderRadius: 10, color: '#6B7280', background: '#F3F4F6',
    }}>
      {label}
    </span>
  )
}

function fmtDateTime(iso?: string) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch { return iso }
}

// "Jun 23, 2026 4:35 PM" — order-placed timestamp in the restaurant's timezone
// (defaults to America/New_York when the order carries no tz).
function fmtCreatedAt(iso?: string, tz: string = RESTAURANT_TZ_DEFAULT): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz })
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
    return `${date} ${time}`
  } catch { return '' }
}

// Mirrors FM mappingOrderDetails() — combines delivery / tips / tax fields
function deriveTotals(o: Order) {
  const subtotal = o.subtotal ?? 0
  const tax = (o.stateSalesTaxInPrice ?? 0) + (o.localSalesTaxInPrice ?? 0) + (o.otherSalesTaxInPrice ?? 0)
  const tips = (o.tipsInPrice ?? 0) + (o.thirdPartyDeliveryTipsInPrice ?? 0)
  const delivery = (o.ownDeliveryFee ?? 0) + (o.doordashDeliveryFee ?? 0) + (o.thirdPartyDeliveryFee ?? 0)
  // Prefer o.total when present; fall back to transactionsTotal so the
  // drawer still shows something usable if the API omits one field.
  const total = (typeof o.total === 'number' ? o.total : o.transactionsTotal) || 0
  return { subtotal, tax, tips, delivery, total }
}

function statusColor(status: string, orderDate: string, orderTime: string) {
  if (!orderDate || !orderTime) return undefined
  const dt = new Date(`${orderDate}T${orderTime}`)
  const now = new Date()
  const diffMs = dt.getTime() - now.getTime()
  if (diffMs >= 0 && diffMs <= 3600000) return '#77AE70'
  if (diffMs < 0) return '#E76F51'
  return undefined
}

// An order is editable only when it's not in a finished state AND the catering
// date/time is more than 24h out. (Date/time are parsed in the browser's local
// tz — matching statusColor — so this is approximate near the boundary; the
// real edit page in Session 2 should re-validate server-side.)
const NON_EDITABLE_STATUSES = new Set(['COMPLETED', 'EXPIRED', 'CANCELED', 'CANCELLED'])
const MAX_EDITS = 3

// SUPER_ADMIN (read from the restaurant_user session) bypasses the 24-hour rule.
function isSuperAdmin(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem('restaurant_user')
    return raw ? JSON.parse(raw).role === 'SUPER_ADMIN' : false
  } catch { return false }
}

function isEditEligible(order: Order): boolean {
  const status = (order.orderStatus || '').toUpperCase()
  if (NON_EDITABLE_STATUSES.has(status)) return false
  if (!order.orderDate || !order.orderTime) return false
  // Edit-count cap from Neon (disco_orders.edit_count). Applies to EVERY role —
  // SUPER_ADMIN only bypasses the 24-hour rule below, never the 3-edit limit.
  if ((order.editCount ?? 0) >= MAX_EDITS) return false
  // SUPER_ADMIN can edit regardless of how close pickup is — status + edit-count
  // checks above still apply to them.
  if (isSuperAdmin()) return true
  // FM returns orderDate as DD.MM.YYYY — normalize to YYYY-MM-DD before Date().
  const iso = order.orderDate.includes('.') ? order.orderDate.split('.').reverse().join('-') : order.orderDate
  const ts = new Date(`${iso}T${order.orderTime}`).getTime()
  if (Number.isNaN(ts)) return false
  return ts > Date.now() + 24 * 60 * 60 * 1000
}

// ─── Components ──────────────────────────────────────────────────────────────

function ConfirmDialog({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '90%', fontFamily: F }}>
        <p style={{ fontSize: 14, color: DARK, margin: '0 0 20px', lineHeight: 1.5 }}>{message}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={onConfirm} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>Confirm</button>
        </div>
      </div>
    </div>
  )
}

// ─── Edit History Panel ───────────────────────────────────────────────────────
// Right slide-in panel showing the edit timeline for an order. The FM wire
// shape for an edit record is unconfirmed, so each field is read defensively
// across the likely key names, and a raw fallback is shown when the shape is
// unrecognized (useful while we nail down the real payload in testing).

interface EditRecord {
  [key: string]: unknown
}

function pick(obj: EditRecord, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]
  }
  return undefined
}

function EditHistoryPanel({ orderRef, onClose }: { orderRef: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [history, setHistory] = useState<EditRecord[]>([])
  const [raw, setRaw] = useState<unknown>(null)
  // Mount closed, then flip to open on the next tick so the CSS transition
  // animates the panel in from the right.
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setOpen(true), 10)
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(false)
    fetch(`/api/restaurant/orders/${orderRef}/edit-history`)
      .then(async res => {
        if (!res.ok) throw new Error('bad status')
        return res.json()
      })
      .then(data => {
        if (cancelled) return
        setHistory(Array.isArray(data?.history) ? data.history : [])
        setRaw(data?.raw ?? null)
      })
      .catch(() => { if (!cancelled) setError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [orderRef])

  function renderEdit(e: EditRecord, i: number) {
    const editor = pick(e, ['editedBy', 'editorName', 'userName', 'user', 'adminName', 'changedBy']) as string | undefined
    const when = pick(e, ['editedAt', 'timestamp', 'createdDate', 'createdAt', 'date', 'updatedAt']) as string | undefined
    const oldTotal = pick(e, ['oldTotal', 'previousTotal', 'oldPrice', 'previousPrice']) as number | undefined
    const newTotal = pick(e, ['newTotal', 'total', 'newPrice', 'price']) as number | undefined
    const priceChanged = typeof oldTotal === 'number' && typeof newTotal === 'number' && oldTotal !== newTotal
    const itemChanges = (pick(e, ['itemChanges', 'changes', 'items', 'lineChanges']) as EditRecord[] | undefined) || []

    return (
      <div key={i} style={{ borderLeft: '2px solid #5B6FE8', paddingLeft: 14, marginBottom: 22 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{editor || 'Edited'}</div>
        {when && <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>{fmtDateTime(typeof when === 'string' ? when : String(when))}</div>}

        {priceChanged && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#555' }}>
            <div style={{ fontWeight: 600, color: DARK, marginBottom: 4 }}>Price Change</div>
            <span style={{ color: '#E76F51', textDecoration: 'line-through' }}>{fmt(oldTotal!)}</span>
            <span style={{ margin: '0 6px', color: '#aaa' }}>→</span>
            <span style={{ color: '#2E9E5B', fontWeight: 600 }}>{fmt(newTotal!)}</span>
          </div>
        )}

        {Array.isArray(itemChanges) && itemChanges.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#555' }}>
            <div style={{ fontWeight: 600, color: DARK, marginBottom: 4 }}>Item Changes</div>
            {itemChanges.map((c, ci) => {
              const action = String(pick(c, ['action', 'type', 'changeType']) || '').toUpperCase()
              const name = String(pick(c, ['name', 'mealPackageName', 'itemName', 'addOnName']) || 'Item')
              const oldQty = pick(c, ['oldCount', 'oldQty', 'previousCount'])
              const newQty = pick(c, ['newCount', 'newQty', 'count', 'qty'])
              const isAdd = action.includes('ADD')
              const isRemove = action.includes('REMOVE') || action.includes('DELETE')
              const color = isAdd ? '#2E9E5B' : isRemove ? '#E76F51' : '#555'
              const sign = isAdd ? '+ ' : isRemove ? '− ' : ''
              const qtyText = oldQty !== undefined && newQty !== undefined
                ? ` (${oldQty} → ${newQty})`
                : newQty !== undefined ? ` ×${newQty}` : ''
              return (
                <div key={ci} style={{ color, marginBottom: 2 }}>{sign}{name}{qtyText}</div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <style>{`@keyframes ehSpin{to{transform:rotate(360deg)}}`}</style>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
          opacity: open ? 1 : 0, transition: 'opacity 0.25s ease-out',
        }}
      />
      <div style={{
        position: 'fixed', top: 0, right: 0, height: '100vh', width: 'min(480px, 100vw)',
        background: '#fff', zIndex: 1000, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
        display: 'flex', flexDirection: 'column', fontFamily: F,
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.25s ease-out',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #f0f0f0' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: DARK }}>Edit History — Order #{orderRef}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 22, lineHeight: 1, color: '#999', cursor: 'pointer', padding: 0 }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 0', gap: 14 }}>
              <div style={{ width: 28, height: 28, border: '3px solid #eee', borderTopColor: '#5B6FE8', borderRadius: '50%', animation: 'ehSpin 0.7s linear infinite' }} />
              <div style={{ fontSize: 13, color: '#999' }}>Loading…</div>
            </div>
          )}

          {!loading && error && (
            <div style={{ padding: '48px 0', textAlign: 'center', color: '#E76F51', fontSize: 14 }}>Could not load edit history.</div>
          )}

          {!loading && !error && history.length === 0 && (
            <div style={{ padding: '48px 0', textAlign: 'center', color: '#999', fontSize: 14 }}>
              No edits have been made to this order.
            </div>
          )}

          {!loading && !error && history.length > 0 && (
            <div>{history.map(renderEdit)}</div>
          )}

          {/* Raw fallback — only while the FM edit-record shape is unconfirmed. */}
          {!loading && !error && raw != null && (
            <details style={{ marginTop: 24, fontSize: 11, color: '#aaa' }}>
              <summary style={{ cursor: 'pointer' }}>Raw response (debug)</summary>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#FAFAFC', padding: 10, borderRadius: 8, marginTop: 8 }}>{JSON.stringify(raw, null, 2)}</pre>
            </details>
          )}
        </div>
      </div>
    </>
  )
}

function NoteModal({ order, orderRef, onClose, onSaved }: { order: Order; orderRef: string; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState(order.note || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  async function save() {
    setSaving(true); setErr('')
    try {
      // Use the drawer's orderRef (the ref the order was loaded with) — the FM
      // detail object exposes `reference`, NOT `orderReference`, so reading the
      // latter off `order` was undefined → /orders/undefined/note.
      const res = await fetch(`/api/restaurant/orders/${orderRef}/note`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        throw new Error(d?.error || 'Could not save the note.')
      }
      // Only refresh + close on a real save so the note shows immediately.
      onSaved()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the note.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 420, width: '90%', fontFamily: F }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, color: DARK }}>Add Note</h3>
        <textarea
          value={note} onChange={e => setNote(e.target.value)} required
          style={{ width: '100%', minHeight: 100, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '10px 12px', fontSize: 13, fontFamily: F, resize: 'vertical', outline: 'none' }}
        />
        {err && <div style={{ marginTop: 10, fontSize: 12, color: '#DC2626' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={save} disabled={saving || !note.trim()} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>Save</button>
        </div>
      </div>
    </div>
  )
}

function RefundModal({ order, orderRef, onClose, onSaved }: { order: Order; orderRef: string; onClose: () => void; onSaved: () => void }) {
  const maxAmt = order.maxAllowedRefundAmount || order.transactionsTotal
  const [amount, setAmount] = useState(String(maxAmt || ''))
  const [useFullAmt, setUseFullAmt] = useState(true)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (useFullAmt) setAmount(String(maxAmt || '')) }, [useFullAmt, maxAmt])
  async function save() {
    setSaving(true)
    await fetch(`/api/restaurant/orders/${orderRef}/refund`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: parseFloat(amount) }),
    })
    setSaving(false)
    onSaved()
    onClose()
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '90%', fontFamily: F }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, color: DARK }}>Refund Order</h3>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>Amount</label>
          <input
            type="number" value={amount} onChange={e => setAmount(e.target.value)}
            style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none' }}
          />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: '#555', marginBottom: 16 }}>
          <input type="checkbox" checked={useFullAmt} onChange={e => setUseFullAmt(e.target.checked)} />
          Use full amount ({fmt(maxAmt)})
        </label>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={save} disabled={saving || !amount} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: '#E76F51', color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>
            Refund
          </button>
        </div>
      </div>
    </div>
  )
}

// Disco-native void confirmation. No amount field — voiding issues no refund and
// sends no notification; it only records that food was prepared but not
// fulfilled. Calls the Neon-only PUT .../void endpoint.
function VoidModal({ orderRef, onClose, onSaved }: { orderRef: string; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false)
  async function save() {
    setSaving(true)
    try {
      await fetch(`/api/restaurant/orders/${orderRef}/void`, { method: 'PUT' })
    } finally {
      setSaving(false)
    }
    onSaved()
    onClose()
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 400, width: '90%', fontFamily: F }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16, color: DARK }}>Void Order</h3>
        <p style={{ fontSize: 14, color: '#555', margin: '0 0 22px', lineHeight: 1.55 }}>
          Void this order? This action indicates the food was prepared but not fulfilled.
          No refund will be issued and the customer will not be notified. This cannot be undone.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: saving ? 'default' : 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: '#E53935', color: '#fff', fontSize: 13, cursor: saving ? 'wait' : 'pointer', fontFamily: F, fontWeight: 600, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Voiding…' : 'Void Order'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ReopenModal({ order, orderRef, onClose, onSaved }: { order: Order; orderRef: string; onClose: () => void; onSaved: () => void }) {
  const [orderDate, setOrderDate] = useState(order.orderDate || '')
  const [orderTime, setOrderTime] = useState(order.orderTime?.slice(0, 5) || '')
  const [saving, setSaving] = useState(false)
  async function save() {
    setSaving(true)
    await fetch(`/api/restaurant/orders/${orderRef}/reopen`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderDate, orderTime: orderTime + ':00' }),
    })
    setSaving(false)
    onSaved()
    onClose()
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '90%', fontFamily: F }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, color: DARK }}>Reopen Order</h3>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>Order Date</label>
          <input type="date" value={orderDate} onChange={e => setOrderDate(e.target.value)}
            style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none' }} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>Order Time</label>
          <input type="time" value={orderTime} onChange={e => setOrderTime(e.target.value)}
            style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none' }} />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={save} disabled={saving || !orderDate || !orderTime} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>Reopen</button>
        </div>
      </div>
    </div>
  )
}

function OrderDrawer({ orderRef, onClose, onOrderUpdated }: { orderRef: string; onClose: () => void; onOrderUpdated: () => void }) {
  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<'refund' | 'void' | 'reopen' | 'note' | null>(null)
  const [confirm, setConfirm] = useState<{ msg: string; action: () => void } | null>(null)
  // Disco promo used on this order (from promo_code_uses), if any. Display-only.
  const [promo, setPromo] = useState<{ code: string; discountApplied: number; refundStatus: string } | null>(null)

  const loadOrder = useCallback(async () => {
    const res = await fetch(`/api/restaurant/orders/${orderRef}`)
    if (res.ok) setOrder(await res.json())
    setLoading(false)
  }, [orderRef])

  useEffect(() => { loadOrder() }, [loadOrder])

  // Disco promo lookup (separate from FM's native discount).
  useEffect(() => {
    let cancelled = false
    fetch(`/api/promo/order-promo?orderRef=${encodeURIComponent(orderRef)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setPromo(d || null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [orderRef])

  async function updateStatus(status: string) {
    await fetch(`/api/restaurant/orders/${orderRef}/status?orderStatus=${status}`, { method: 'PUT' })
    onOrderUpdated()
    loadOrder()
  }

  function handleStatusChange(status: string) {
    if (status === 'CANCELED' || status === 'VOID') {
      setConfirm({
        msg: 'Do you want to cancel? Order status will be changed and customer will be notified.',
        action: () => updateStatus(status),
      })
    } else {
      updateStatus(status)
    }
  }

  // FM totals derivation (shared/order-details mappingOrderDetails lines 78-93)
  const totals = order ? deriveTotals(order) : null
  const customerFull = order ? `${order.firstName || ''} ${order.lastName || ''}`.trim() : ''
  const isTaxExempt = !!order && (order.taxExempt === true || !!order.taxExemptId)

  function printDrawer() {
    if (!order) return
    // Opens a fresh window with a standalone FM-style HTML document and
    // calls print() on that window. The in-page approach (window.print()
    // on the main doc with an @media print visibility cascade) printed
    // blank pages on Safari + some Chrome configs because the drawer is
    // position:fixed, which breaks the nested print-doc layout. The
    // new-window path side-steps the parent stylesheet entirely.
    const ok = printOrder(order as PrintableOrder)
    if (!ok) {
      alert('Pop-up blocked. Please allow pop-ups for this site so we can open the print preview.')
    }
  }

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 480, background: '#fff', zIndex: 200, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column', fontFamily: F }} className="order-drawer-root">
      {/* Header */}
      <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }} className="order-drawer-chrome">
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: DARK }}>Order Details</h2>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#888', lineHeight: 1 }}>×</button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }} className="order-print-area">
        {loading && <div style={{ color: '#888', fontSize: 13 }}>Loading…</div>}
        {order && totals && (
          <>
            {/* FM-style print header */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: DARK, lineHeight: 1.5 }}>
                Disco Cater Order #{order.orderNumber}{getOrderSourceBadge(order.sourceoforder || '')} ({fmt(totals.total)}) {fmtDate(order.orderDate)}
                {order.orderTime && <>, {fmtTime(order.orderTime)}</>}
                {customerFull && <> for {customerFull}</>}
              </div>
            </div>

            {isRecurringOrder(order) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#EEF0FF', color: '#5B6FE8', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 13, fontWeight: 600 }} className="order-drawer-chrome">
                🔄 Recurring order
              </div>
            )}

            <div style={{ background: '#F7F8FC', borderRadius: 8, padding: '8px 14px', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} className="order-drawer-chrome">
              <span style={{ fontSize: 12, color: '#666' }}>Status</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: DARK }}>{STATUS_LABEL[order.orderStatus] || order.orderStatus}</span>
            </div>

            {/* Status change */}
            {!TERMINAL.has(order.orderStatus) && order.orderStatusesToChange?.length > 0 && (
              <div style={{ marginBottom: 16 }} className="order-drawer-chrome">
                <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>Change Status</label>
                <select
                  value=""
                  onChange={e => { if (e.target.value) handleStatusChange(e.target.value) }}
                  style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, background: '#fff', outline: 'none' }}
                >
                  <option value="">Select new status…</option>
                  {[...new Set(order.orderStatusesToChange)].map(s => (
                    <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>
                  ))}
                </select>
              </div>
            )}

            {/* ORDER DETAILS table — store info */}
            <SectionHeader>Order Details</SectionHeader>
            <DetailRow label="Date" value={fmtDate(order.orderDate)} />
            <DetailRow label="Time" value={fmtTime(order.orderTime)} />
            {order.persons != null && <DetailRow label="Headcount" value={String(order.persons)} />}
            {order.orderCreatedDate && <DetailRow label="Order Placed" value={fmtCreatedAt(order.orderCreatedDate, order.restaurantTimezone || order.restaurant?.timezone || undefined)} />}
            {order.restaurant?.businessName && <DetailRow label="Store" value={order.restaurant.businessName} />}
            {order.restaurant?.address?.addressLine1 && <DetailRow label="Store address" value={[order.restaurant.address.addressLine1, order.restaurant.address.city, order.restaurant.address.state, order.restaurant.address.zipcode].filter(Boolean).join(', ')} />}
            {order.restaurant?.address?.phoneNumber && <DetailRow label="Store phone" value={order.restaurant.address.phoneNumber} />}
            {isTaxExempt && <DetailRow label="Tax Exempt ID" value={order.taxExemptId || '—'} />}

            {/* DELIVERY / PICKUP TIME — customer info */}
            <SectionHeader>{order.orderType === 'DELIVERY' ? 'Delivery Pick-up Time' : 'Pickup Time'}</SectionHeader>
            {order.orderDropOffTime ? (
              <DetailRow label="Drop-off" value={fmtDateTime(order.orderDropOffTime)} />
            ) : (
              <>
                <DetailRow label="Date" value={fmtDate(order.orderDate)} />
                <DetailRow label="Time" value={fmtTime(order.orderTime)} />
              </>
            )}
            <DetailRow label="Customer" value={customerFull || '—'} />
            {order.email && <DetailRow label="Email" value={order.email} />}
            {order.phoneNumber && <DetailRow label="Phone" value={order.phoneNumber} />}
            {order.orderType === 'DELIVERY' && order.deliveryAddress?.addressLine1 && (
              <DetailRow label="Address" value={[order.deliveryAddress.addressLine1, order.deliveryAddress.city, order.deliveryAddress.state, order.deliveryAddress.zipcode].filter(Boolean).join(', ')} />
            )}
            {order.deliveryAddress?.deliveryInstructions && (
              <DetailRow label="Instructions" value={order.deliveryAddress.deliveryInstructions} />
            )}
            {/* Live courier tracking — present once the 3rd-party delivery dispatches. */}
            {order.nashDeliveryPublicTrackingUrl && (
              <a
                href={order.nashDeliveryPublicTrackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#5B6FE8', textDecoration: 'none', margin: '8px 0 4px' }}
              >
                🚗 Track your delivery →
              </a>
            )}

            {/* Line items */}
            {((order.orderMealPackages?.length || 0) + (order.orderClassics?.length || 0)) > 0 && (
              <>
                <SectionHeader>Items</SectionHeader>
                <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
                  <thead>
                    <tr style={{ background: '#F7F8FC' }}>
                      <th style={{ ...lineColHead, width: 40 }}>Qty</th>
                      <th style={lineColHead}>Item</th>
                      <th style={{ ...lineColHead, textAlign: 'right', width: 70 }}>Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...(order.orderMealPackages || []), ...(order.orderClassics || [])].map((it, i) => (
                      <LineItemRow key={i} item={it} />
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {/* Order Notes — between the items and totals (matches FM). */}
            {order.note && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: DARK, marginBottom: 4 }}>Order Notes:</div>
                <div style={{ fontSize: 13, color: '#444', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{order.note}</div>
              </div>
            )}

            {/* Totals breakdown — mirrors FM template lines 395-540 */}
            <div style={{ borderTop: '1px solid #eee', paddingTop: 12, marginTop: 8 }}>
              <TotalRow label="Subtotal" value={totals.subtotal} />
              {(order.serviceCharge ?? 0) > 0 && (
                <TotalRow
                  label={order.restaurant?.feeCategories?.[0]?.displayFeeCategoriesName || 'Service Charge'}
                  value={order.serviceCharge ?? 0}
                />
              )}
              <TotalRow label={isTaxExempt ? 'Taxes (Tax Exempt)' : 'Taxes'} value={isTaxExempt ? 0 : totals.tax} />
              {(order.fee ?? order.fees ?? 0) > 0 && <TotalRow label="Fees" value={order.fee ?? order.fees ?? 0} />}
              {totals.tips > 0 && <TotalRow label="Tips" value={totals.tips} />}
              {totals.delivery > 0 && <TotalRow label="Delivery Fee" value={totals.delivery} />}
              {(order.discount ?? 0) > 0 && <TotalRow label="Promo" value={-(order.discount ?? 0)} />}
              {(order.refund ?? 0) > 0 && <TotalRow label="Refund" value={-(order.refund ?? 0)} />}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingTop: 10, borderTop: '1px solid #eee' }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: DARK }}>Total</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: DARK }}>{fmt(totals.total)}</span>
              </div>
              {/* Disco promo — display-only credit (FM total above is the full
                  amount the restaurant received). Gradient to distinguish from
                  FM's native Promo line. */}
              {promo && (() => {
                // Three states: completed (gradient), pending (neutral grey,
                // in-flight), failed (amber warning).
                const failed = promo.refundStatus === 'failed'
                const pending = promo.refundStatus === 'pending'
                const lineStyle: React.CSSProperties = failed ? { color: '#EFB84A' } : pending ? { color: '#999' } : GRADIENT_TEXT
                const prefix = failed ? '⚠ ' : pending ? '⏳ ' : ''
                const note = failed
                  ? 'Credit not yet applied — contact support'
                  : pending
                    ? 'Credit being processed'
                    : 'Applied as a card credit to the customer'
                const noteColor = failed ? '#EFB84A' : '#999'
                return (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 13, fontWeight: 700 }}>
                    <span style={lineStyle}>{prefix}Disco Promo ({promo.code})</span>
                    <span style={lineStyle}>−{fmt(promo.discountApplied)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: noteColor, marginTop: 2 }}>{note}</div>
                </>
                )
              })()}
            </div>

            {/* Action Buttons — hidden when printing */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 18 }} className="order-drawer-chrome">
              {order.orderStatus === 'DUE' && (
                <button onClick={() => handleStatusChange('COMPLETED')}
                  style={{ padding: '8px 14px', background: '#22C55E', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                  Complete
                </button>
              )}
              {order.orderStatus === 'COMPLETED' && (
                <button onClick={() => setModal('reopen')}
                  style={{ padding: '8px 14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                  Reopen
                </button>
              )}
              {(order.maxAllowedRefundAmount ?? 0) > 0 && order.orderStatus !== 'REOPEN' && (
                <button onClick={() => setModal('refund')}
                  style={{ padding: '8px 14px', background: '#E76F51', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                  Refund
                </button>
              )}
              {/* Void is only offered once the pickup/delivery datetime has
                  passed — it records "food prepared, not fulfilled". */}
              {!TERMINAL.has(order.orderStatus) && isPastPickup(order) && (
                <button onClick={() => setModal('void')}
                  style={{ padding: '8px 14px', background: '#6B7280', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                  Void
                </button>
              )}
              <button onClick={() => setModal('note')}
                style={{ padding: '8px 14px', background: '#F59E0B', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                Add notes
              </button>
              <button onClick={printDrawer}
                style={{ padding: '8px 14px', background: '#fff', color: DARK, border: '1px solid #ddd', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                Print
              </button>
            </div>
          </>
        )}
      </div>

      {modal === 'refund' && order && <RefundModal order={order} orderRef={orderRef} onClose={() => setModal(null)} onSaved={() => { onOrderUpdated(); loadOrder() }} />}
      {modal === 'void' && order && <VoidModal orderRef={orderRef} onClose={() => setModal(null)} onSaved={() => { onOrderUpdated(); loadOrder() }} />}
      {modal === 'reopen' && order && <ReopenModal order={order} orderRef={orderRef} onClose={() => setModal(null)} onSaved={() => { onOrderUpdated(); loadOrder() }} />}
      {modal === 'note' && order && <NoteModal order={order} orderRef={orderRef} onClose={() => setModal(null)} onSaved={() => { onOrderUpdated(); loadOrder() }} />}
      {confirm && <ConfirmDialog message={confirm.msg} onConfirm={() => { confirm.action(); setConfirm(null) }} onCancel={() => setConfirm(null)} />}
    </div>
  )
}

// ─── Order Counts Tab ─────────────────────────────────────────────────────────

function OrderCountsTab() {
  const today = new Date().toISOString().split('T')[0]
  const plus6 = new Date(Date.now() + 6 * 86400000).toISOString().split('T')[0]
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(plus6)
  const [data, setData] = useState<{ mealPackages: SalesStatItem[]; addOns: SalesStatItem[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!fromDate || !toDate) return
    setLoading(true); setError('')
    const params = new URLSearchParams({ fromDate, toDate })
    COUNTS_STATUSES.forEach(s => params.append('orderStatuses', s))
    try {
      const res = await fetch(`/api/restaurant/orders/sale-stats?${params}`)
      if (res.ok) {
        const d = await res.json()
        setData({ mealPackages: d?.mealPackages || [], addOns: d?.addOns || [] })
      } else {
        const d = await res.json().catch(() => null)
        setError(d?.error || `Failed to load (HTTP ${res.status})`)
        setData({ mealPackages: [], addOns: [] })
      }
    } catch {
      setError('Unable to reach server')
      setData({ mealPackages: [], addOns: [] })
    }
    setLoading(false)
  }, [fromDate, toDate])

  // Fire once on mount with the today→+6 default; afterwards only the
  // Generate Report button (or tab re-mount) triggers a fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  const hasData = !!(data && (data.mealPackages.length || data.addOns.length))
  const num = (n: number | undefined) => (typeof n === 'number' ? n.toFixed(2) : '')

  // CSV: one file, Items section then Modifiers section. Raw numeric values
  // (no $/commas) so the file opens cleanly in any spreadsheet app.
  const exportCsv = () => {
    if (!data) return
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines: string[] = []
    lines.push(`Disco Cater Order Counts,${fromDate} to ${toDate}`)
    lines.push('')
    lines.push('Items')
    lines.push(['Item', 'Count', 'Price', 'Total'].join(','))
    data.mealPackages.forEach(it => lines.push([q(it.mealPackageName || it.addOnName || ''), it.count, num(it.price), num(it.total)].join(',')))
    lines.push('')
    lines.push('Modifiers')
    lines.push(['Modifier', 'Item', 'Count', 'Price', 'Total'].join(','))
    data.addOns.forEach(it => lines.push([q(it.addOnName || ''), q(it.mealPackageName || ''), it.count, num(it.price), num(it.total)].join(',')))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `order-counts_${fromDate}_${toDate}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  // PDF: print-optimized HTML in a new window, then trigger the browser's
  // print dialog (Save as PDF). Mirrors the print pattern used for orders.
  const exportPdf = () => {
    if (!data) return
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
    const money = (n: number | undefined) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—')
    const itemRows = data.mealPackages.map(it => `<tr><td>${esc(it.mealPackageName || it.addOnName || '—')}</td><td class="r">${it.count}</td><td class="r">${money(it.price)}</td><td class="r">${money(it.total)}</td></tr>`).join('')
    const modRows = data.addOns.map(it => `<tr><td>${esc(it.addOnName || '—')}</td><td>${esc(it.mealPackageName || '—')}</td><td class="r">${it.count}</td><td class="r">${money(it.price)}</td><td class="r">${money(it.total)}</td></tr>`).join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Order Counts ${esc(fromDate)} – ${esc(toDate)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1A1028; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin: 0 0 24px; }
  h2 { font-size: 15px; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; text-transform: uppercase; font-size: 11px; color: #888; padding: 8px 10px; border-bottom: 2px solid #eee; }
  td { padding: 8px 10px; border-bottom: 1px solid #f0f0f0; }
  .r { text-align: right; }
  @media print { body { margin: 0; } }
</style></head><body>
  <h1>Disco Cater — Order Counts</h1>
  <p class="sub">${esc(fromDate)} to ${esc(toDate)}</p>
  <h2>Items</h2>
  <table><thead><tr><th>Item</th><th class="r">Count</th><th class="r">Price</th><th class="r">Total</th></tr></thead><tbody>${itemRows || '<tr><td colspan="4" style="text-align:center;color:#aaa">No items</td></tr>'}</tbody></table>
  <h2>Modifiers</h2>
  <table><thead><tr><th>Modifier</th><th>Item</th><th class="r">Count</th><th class="r">Price</th><th class="r">Total</th></tr></thead><tbody>${modRows || '<tr><td colspan="5" style="text-align:center;color:#aaa">No modifiers</td></tr>'}</tbody></table>
  <script>window.onload = function(){ window.print() }<\/script>
</body></html>`
    const w = window.open('', '_blank', 'width=900,height=700')
    if (!w) return
    w.document.write(html)
    w.document.close()
  }

  const colHead = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase' as const, padding: '10px 14px', textAlign: 'left' as const }
  const cell = { padding: '10px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
  const exportBtn: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, fontFamily: F, color: DARK, background: '#fff', cursor: 'pointer' }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} disabled={loading}
          style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', opacity: loading ? 0.6 : 1 }} />
        <span style={{ color: '#aaa' }}>–</span>
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} disabled={loading}
          style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', opacity: loading ? 0.6 : 1 }} />
        <GenerateReportButton onClick={load} loading={loading} />
        <button onClick={exportCsv} disabled={!hasData || loading} style={{ ...exportBtn, opacity: !hasData || loading ? 0.5 : 1, cursor: !hasData || loading ? 'default' : 'pointer' }}>Export CSV</button>
        <button onClick={exportPdf} disabled={!hasData || loading} style={{ ...exportBtn, opacity: !hasData || loading ? 0.5 : 1, cursor: !hasData || loading ? 'default' : 'pointer' }}>Export PDF</button>
      </div>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      <h3 style={{ fontSize: 14, fontWeight: 700, color: DARK, margin: '0 0 12px' }}>Items</h3>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', marginBottom: 24, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ background: '#F7F8FC' }}>
            <th style={colHead}>Items</th>
            <th style={{ ...colHead, textAlign: 'right' }}>Count</th>
            <th style={{ ...colHead, textAlign: 'right' }}>Price</th>
            <th style={{ ...colHead, textAlign: 'right' }}>Total ($)</th>
          </tr></thead>
          <tbody>
            {data?.mealPackages?.map((item, i) => (
              <tr key={i}>
                <td style={cell}>{item.mealPackageName || item.addOnName || '—'}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{item.count}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{fmt(item.price)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{fmt(item.total)}</td>
              </tr>
            ))}
            {!loading && !data?.mealPackages?.length && (
              <tr><td colSpan={4} style={{ ...cell, color: '#aaa', textAlign: 'center' }}>No completed or due orders in this date range.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 700, color: DARK, margin: '0 0 12px' }}>Modifiers</h3>
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ background: '#F7F8FC' }}>
            <th style={colHead}>Modifier</th>
            <th style={colHead}>Items</th>
            <th style={{ ...colHead, textAlign: 'right' }}>Count</th>
            <th style={{ ...colHead, textAlign: 'right' }}>Price</th>
            <th style={{ ...colHead, textAlign: 'right' }}>Total ($)</th>
          </tr></thead>
          <tbody>
            {data?.addOns?.map((item, i) => (
              <tr key={i}>
                <td style={cell}>{item.addOnName || '—'}</td>
                <td style={cell}>{item.mealPackageName || '—'}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{item.count}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{fmt(item.price)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{fmt(item.total)}</td>
              </tr>
            ))}
            {!loading && !data?.addOns?.length && (
              <tr><td colSpan={5} style={{ ...cell, color: '#aaa', textAlign: 'center' }}>No modifiers in this date range.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Main Orders Page ─────────────────────────────────────────────────────────

function OrdersContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  // Guard: multi-location SAs who never picked a restaurant get an empty
  // /api/orders response from FM because no current restaurant is set.
  // Read role + selection from localStorage (the only places the layout
  // already syncs them) and show a friendly prompt instead of the
  // "No orders found" empty state which looks broken.
  // Track 1: SA with no location picked now shows orders AGGREGATED
  // across all their locations (the proxy routes to /api/system-admin/
  // orders), not a "pick a location" prompt. `aggregating` drives the
  // Restaurant column + the info banner.
  const [aggregating, setAggregating] = useState(false)
  // User role drives the edit-history icon rule: ADMIN / SYSTEM_ADMIN only see it
  // on orders that actually have edits; SUPER_ADMIN is unaffected (always shown).
  const [role, setRole] = useState('')
  useEffect(() => {
    try {
      const raw = localStorage.getItem('restaurant_user')
      const r = raw ? (JSON.parse(raw).role || '') : ''
      setRole(r)
      const sel = localStorage.getItem('selectedRestaurant')
      const isMulti = r === 'SYSTEM_ADMIN' || r === 'SUPER_ADMIN'
      setAggregating(isMulti && !sel)
    } catch {}
  }, [])

  // After a successful order edit the edit page redirects here with
  // ?editSuccess=true&orderNumber=XXXXX&editOutcome=success|invoiced. Capture it
  // into a dismissible banner, then strip the params from the URL (preserving any
  // others, e.g. tab) so a refresh doesn't re-show it.
  const [editSuccessBanner, setEditSuccessBanner] = useState<string | null>(null)
  const [editOutcome, setEditOutcome] = useState<string>('success')
  useEffect(() => {
    if (searchParams.get('editSuccess') !== 'true') return
    setEditSuccessBanner(searchParams.get('orderNumber') || '')
    setEditOutcome(searchParams.get('editOutcome') || 'success')
    const p = new URLSearchParams(searchParams.toString())
    p.delete('editSuccess')
    p.delete('orderNumber')
    p.delete('editOutcome')
    const qs = p.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tab = (searchParams.get('tab') || 'active') as 'active' | 'history' | 'counts'
  const [orders, setOrders] = useState<Order[]>([])
  // orderReference → number of disco_order_edits rows (drives the edit-history icon).
  const [editCounts, setEditCounts] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [size] = useState(25)
  const [search, setSearch] = useState('')
  // Input vs applied: the date inputs are unbound from the fetch effect
  // so typing/selecting doesn't trigger partial fetches. Clicking
  // "Apply Filters" commits the inputs into applied state, which the
  // fetch effect watches.
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [appliedFrom, setAppliedFrom] = useState('')
  const [appliedTo, setAppliedTo] = useState('')
  // Client-side recurring filter over the loaded page of orders.
  const [recurringFilter, setRecurringFilter] = useState<'all' | 'recurring' | 'onetime'>('all')
  const [loading, setLoading] = useState(false)
  const [sortField, setSortField] = useState('order_date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [drawerRef, setDrawerRef] = useState<string | null>(null)
  const [historyRef, setHistoryRef] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ msg: string; action: () => void } | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const statuses = tab === 'active' ? ACTIVE_STATUSES : HISTORY_STATUSES

  function setTab(t: string) {
    const p = new URLSearchParams(searchParams.toString())
    p.set('tab', t)
    router.replace(`${pathname}?${p}`)
    setPage(0)
    setSearch('')
    setFromDate(''); setToDate('')
    setAppliedFrom(''); setAppliedTo('')
  }

  function applyDateFilters() {
    setPage(0)
    setAppliedFrom(fromDate)
    setAppliedTo(toDate)
    // useEffect re-fires loadOrders with the new applied values
  }

  function clearFilters() {
    setSearch('')
    setFromDate(''); setToDate('')
    setAppliedFrom(''); setAppliedTo('')
  }

  const loadOrders = useCallback(async (resetPage?: boolean) => {
    if (tab === 'counts') return
    setLoading(true)
    const p = new URLSearchParams()
    const currentPage = resetPage ? 0 : page
    p.set('page', String(currentPage))
    p.set('size', String(size))
    statuses.forEach(s => p.append('orderStatuses', s))
    p.append('sort', `${sortField},${sortDir}`)
    if (sortField === 'order_date') p.append('sort', `order_time,${sortDir}`)
    if (sortField === 'first_name') p.append('sort', `last_name,${sortDir}`)
    if (search) p.set('search', search)
    if (appliedFrom) p.set('fromDate', appliedFrom)
    if (appliedTo) p.set('toDate', appliedTo)
    const res = await fetch(`/api/restaurant/orders?${p}`)
    if (res.ok) {
      const d = await res.json()
      setOrders(d.content || [])
      setTotal(d.totalElements || 0)
    }
    setLoading(false)
  }, [tab, page, size, statuses, sortField, sortDir, search, appliedFrom, appliedTo])

  // Load whenever any dependency in loadOrders changes (tab, page, sort, search, dates)
  useEffect(() => {
    loadOrders()
  }, [loadOrders])

  // Fetch the edit-history count for the loaded page of orders so the table only
  // shows the edit-history icon on orders that actually have edits. Best-effort.
  useEffect(() => {
    const refs = orders.map(o => o.orderReference).filter(Boolean)
    if (!refs.length) { setEditCounts({}); return }
    let cancelled = false
    fetch('/api/restaurant/orders/edit-counts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderRefs: refs }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d?.counts) setEditCounts(d.counts) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [orders])

  // Polling for active tab
  useEffect(() => {
    if (tab !== 'active') return
    const id = setInterval(() => loadOrders(), 60000)
    return () => clearInterval(id)
  }, [loadOrders, tab])

  async function openOrder(order: Order) {
    if (!order.orderSeenByAdmin) {
      await fetch(`/api/restaurant/orders/${order.orderReference}/seen`, { method: 'PUT' })
      setOrders(prev => prev.map(o => o.orderReference === order.orderReference ? { ...o, orderSeenByAdmin: true } : o))
    }
    setDrawerRef(order.orderReference)
  }

  async function handleMarkAllComplete() {
    setConfirm({
      msg: 'Mark all active orders as complete? This will complete all DUE/PAID orders.',
      action: async () => {
        const params = new URLSearchParams()
        if (appliedFrom) params.set('fromDate', appliedFrom)
        if (appliedTo) params.set('toDate', appliedTo)
        await fetch(`/api/restaurant/orders/set-completed?${params}`, { method: 'PUT' })
        loadOrders()
      },
    })
  }

  function handleSort(field: string) {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('desc') }
  }

  const totalPages = Math.ceil(total / size)
  const colHead = (field: string, label: string) => (
    <th
      onClick={() => handleSort(field)}
      style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap', background: '#F7F8FC' }}
    >
      {label} {sortField === field ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </th>
  )

  // Recurring filter is applied client-side over the currently-loaded page.
  const displayedOrders = recurringFilter === 'all'
    ? orders
    : orders.filter(o => recurringFilter === 'recurring' ? isRecurringOrder(o) : !isRecurringOrder(o))

  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      {editSuccessBanner !== null && (() => {
        const tag = editSuccessBanner ? `Order #${editSuccessBanner}` : 'Order'
        const message = editOutcome === 'invoiced'
          ? `${tag} has been updated. The customer has been sent an invoice for the difference.`
          : `${tag} has been updated successfully.`
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', marginBottom: 16, background: '#ECFDF3', border: '1px solid #ABEFC6', borderRadius: 8 }}>
            <span style={{ fontSize: 13, color: '#067647', fontWeight: 600 }}>{message}</span>
            <button onClick={() => setEditSuccessBanner(null)} aria-label="Dismiss"
              style={{ background: 'none', border: 'none', color: '#067647', fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: 4 }}>×</button>
          </div>
        )
      })()}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 20px', gap: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Orders</h1>
        <button onClick={() => router.push('/restaurant/orders/create')}
          style={{ padding: '9px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, boxShadow: '0 2px 8px rgba(91,111,232,0.25)', whiteSpace: 'nowrap' }}>
          + Create Order
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e8e8e8', marginBottom: 20 }}>
        {[['active', 'Active'], ['history', 'Order History'], ['counts', 'Order Counts']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{
              padding: '10px 20px', background: 'none', border: 'none', borderBottom: tab === key ? `2px solid ${BLUE}` : '2px solid transparent',
              color: tab === key ? BLUE : '#888', fontWeight: tab === key ? 700 : 400,
              fontSize: 14, cursor: 'pointer', fontFamily: F, marginBottom: -1,
            }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'counts' ? (
        <OrderCountsTab />
      ) : (
        <>
          {/* Track 1 — aggregated-locations banner for SYSTEM_ADMIN with
              no location picked. The Restaurant column below shows which
              location each order belongs to; picking a location (from the
              dashboard dropdown) scopes down to one. */}
          {aggregating && (
            <div style={{ background: 'rgba(107,110,249,0.06)', border: '1px solid rgba(107,110,249,0.18)', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12.5, color: '#555', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span aria-hidden>📍</span>
              <span>Showing orders across <strong style={{ color: DARK }}>all your locations</strong>. Pick a location from the Reporting dropdown to scope to one.</span>
            </div>
          )}

          {/* Filter Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            <input
              type="text" placeholder="Search orders…" value={search} onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && loadOrders(true)}
              style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, outline: 'none', minWidth: 200 }}
            />
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} disabled={loading}
              style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, outline: 'none', opacity: loading ? 0.6 : 1 }} />
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} disabled={loading}
              style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, outline: 'none', opacity: loading ? 0.6 : 1 }} />
            <select value={recurringFilter} onChange={e => setRecurringFilter(e.target.value as 'all' | 'recurring' | 'onetime')} disabled={loading}
              title="Filter by recurring"
              style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, outline: 'none', background: '#fff', color: DARK, cursor: 'pointer', opacity: loading ? 0.6 : 1 }}>
              <option value="all">All orders</option>
              <option value="recurring">Recurring only</option>
              <option value="onetime">One-time only</option>
            </select>
            <GenerateReportButton onClick={applyDateFilters} loading={loading} label="Apply Filters" loadingLabel="Loading…" />
            {(search || fromDate || toDate || appliedFrom || appliedTo) && !loading && (
              <button onClick={clearFilters}
                style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: F }}>
                Clear
              </button>
            )}
            {tab === 'active' && (
              <button onClick={handleMarkAllComplete}
                style={{ padding: '8px 14px', background: '#22C55E', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, marginLeft: 'auto' }}>
                Mark all complete
              </button>
            )}
          </div>

          {/* Table */}
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {colHead('first_name', 'Order')}
                  {aggregating && (
                    <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'left', background: '#F7F8FC' }}>Restaurant</th>
                  )}
                  <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'left', background: '#F7F8FC' }}>Source</th>
                  {colHead('order_date', 'Order Time')}
                  <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'left', background: '#F7F8FC', whiteSpace: 'nowrap' }}>Created</th>
                  <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'left', background: '#F7F8FC' }}>Service</th>
                  <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'left', background: '#F7F8FC' }}>Delivery Status</th>
                  {colHead('transactions_total', 'Total')}
                  <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'left', background: '#F7F8FC' }}>Status</th>
                  <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'right', background: '#F7F8FC' }}></th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={aggregating ? 10 : 9} style={{ padding: '32px', textAlign: 'center', color: '#aaa', fontSize: 13 }}>Loading…</td></tr>
                )}
                {!loading && displayedOrders.length === 0 && (
                  <tr><td colSpan={aggregating ? 10 : 9} style={{ padding: '32px', textAlign: 'center', color: '#aaa', fontSize: 13 }}>No orders found</td></tr>
                )}
                {displayedOrders.map(order => {
                  const timeColor = statusColor(order.orderStatus, order.orderDate, order.orderTime)
                  const isNew = !order.orderSeenByAdmin
                  return (
                    <tr
                      key={order.orderReference}
                      onClick={e => {
                        // Belt-and-suspenders: even if a child's stopPropagation
                        // is ever bypassed, never open the detail drawer for a
                        // click that originated in the row-actions cell.
                        if ((e.target as HTMLElement).closest('[data-row-actions]')) return
                        openOrder(order)
                      }}
                      style={{
                        cursor: 'pointer',
                        background: isNew ? 'rgba(107,110,249,0.04)' : undefined,
                        borderTop: '1px solid #f5f5f5',
                        transition: 'background 0.1s',
                      }}
                    >
                      <td style={{ padding: '12px 14px' }}>
                        <div style={{ fontWeight: isNew ? 700 : 500, fontSize: 13, color: DARK }}>
                          {order.firstName} {order.lastName}
                          {isRecurringOrder(order) && <RecurringBadge />}
                          {isNew && <span style={{ marginLeft: 6, background: BLUE, color: '#fff', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 700 }}>NEW</span>}
                        </div>
                        <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>#{order.orderNumber}</div>
                      </td>
                      {aggregating && (
                        <td style={{ padding: '12px 14px', fontSize: 13, color: '#555' }}>
                          {order.restaurantName || '—'}
                        </td>
                      )}
                      <td style={{ padding: '12px 14px' }}>
                        <SourcePill source={order.sourceoforder || ''} />
                      </td>
                      <td style={{ padding: '12px 14px' }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: timeColor || DARK }}>{fmtTime(order.orderTime)}</div>
                        <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>{fmtDate(order.orderDate)}</div>
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 12, color: '#666', whiteSpace: 'nowrap' }}>
                        {fmtCreatedAt(order.orderCreatedDate, order.restaurantTimezone || undefined) || '—'}
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 13, color: '#666' }}>
                        {DELIVERY_LABEL[order.deliveryType] || order.orderType || '—'}
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 12, color: '#888' }}>
                        {order.nashDeliveryStatus || '—'}
                        {order.nashDeliveryPickupEta && <div style={{ fontSize: 11 }}>Pickup: {order.nashDeliveryPickupEta}</div>}
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 13, fontWeight: 600, color: DARK }}>
                        {fmt(order.transactionsTotal)}
                      </td>
                      <td style={{ padding: '12px 14px' }}>
                        {TERMINAL.has(order.orderStatus) ? (
                          <span style={{ fontSize: 13, color: '#888' }}>{STATUS_LABEL[order.orderStatus] || order.orderStatus}</span>
                        ) : (
                          <select
                            value={order.orderStatus}
                            onClick={e => e.stopPropagation()}
                            onChange={e => {
                              e.stopPropagation()
                              const newStatus = e.target.value
                              if (newStatus === 'CANCELED' || newStatus === 'VOID') {
                                setConfirm({
                                  msg: 'Do you want to cancel? Order status will be changed and customer will be notified.',
                                  action: async () => {
                                    await fetch(`/api/restaurant/orders/${order.orderReference}/status?orderStatus=${newStatus}`, { method: 'PUT' })
                                    loadOrders()
                                  },
                                })
                              } else {
                                fetch(`/api/restaurant/orders/${order.orderReference}/status?orderStatus=${newStatus}`, { method: 'PUT' })
                                  .then(() => loadOrders())
                              }
                            }}
                            style={{ border: '1px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, background: '#fff', color: DARK, outline: 'none', cursor: 'pointer' }}
                          >
                            <option value={order.orderStatus}>{STATUS_LABEL[order.orderStatus] || order.orderStatus}</option>
                            {/* FM's orderStatusesToChange includes the current status — dedupe
                                and drop it so it isn't listed twice (e.g. a doubled "Due"). */}
                            {[...new Set(order.orderStatusesToChange || [])].filter(s => s !== order.orderStatus).map(s => (
                              <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td data-row-actions style={{ padding: '12px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {/* Hide edit in the all-locations (aggregated) view: editing
                            needs the order's specific location selected first, so a
                            SYSTEM_ADMIN/SUPER_ADMIN must navigate into a location. */}
                        {!aggregating && isEditEligible(order) && (
                          <button
                            title="Edit order"
                            aria-label="Edit order"
                            onClick={e => {
                              e.stopPropagation()
                              router.push(`/restaurant/orders/${order.orderReference}/edit`)
                            }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#5B6FE8', padding: '2px 6px', lineHeight: 1 }}
                          >
                            ✏️
                          </button>
                        )}
                        {/* Edit-history icon: SUPER_ADMIN always sees it;
                            ADMIN / SYSTEM_ADMIN only when the order has edits
                            (disco_order_edits count > 0). */}
                        {(role === 'SUPER_ADMIN' || (editCounts[order.orderReference] || 0) > 0) && (
                          <button
                            title="View edit history"
                            aria-label="View edit history"
                            onClick={e => {
                              e.stopPropagation()
                              setHistoryRef(order.orderReference)
                            }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#5B6FE8', padding: '2px 6px', lineHeight: 1 }}
                          >
                            🔄
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
              <div style={{ fontSize: 13, color: '#888' }}>
                {total} orders — page {page + 1} of {totalPages}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setPage(0)} disabled={page === 0}
                  style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page === 0 ? 'default' : 'pointer', opacity: page === 0 ? 0.4 : 1, fontSize: 13, fontFamily: F }}>«</button>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                  style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page === 0 ? 'default' : 'pointer', opacity: page === 0 ? 0.4 : 1, fontSize: 13, fontFamily: F }}>‹</button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  const pg = Math.max(0, Math.min(totalPages - 5, page - 2)) + i
                  return (
                    <button key={pg} onClick={() => setPage(pg)}
                      style={{ padding: '6px 10px', border: '1px solid', borderColor: pg === page ? BLUE : '#ddd', borderRadius: 6, background: pg === page ? BLUE : '#fff', color: pg === page ? '#fff' : DARK, cursor: 'pointer', fontSize: 13, fontFamily: F, fontWeight: pg === page ? 700 : 400 }}>
                      {pg + 1}
                    </button>
                  )
                })}
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                  style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page >= totalPages - 1 ? 'default' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1, fontSize: 13, fontFamily: F }}>›</button>
                <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}
                  style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page >= totalPages - 1 ? 'default' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1, fontSize: 13, fontFamily: F }}>»</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Order Drawer */}
      {drawerRef && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 199 }} onClick={() => setDrawerRef(null)} />
          <OrderDrawer orderRef={drawerRef} onClose={() => setDrawerRef(null)} onOrderUpdated={() => loadOrders()} />
        </>
      )}

      {/* Edit History Panel */}
      {historyRef && (
        <EditHistoryPanel orderRef={historyRef} onClose={() => setHistoryRef(null)} />
      )}

      {confirm && <ConfirmDialog message={confirm.msg} onConfirm={() => { confirm.action(); setConfirm(null) }} onCancel={() => setConfirm(null)} />}
    </div>
  )
}

export default function OrdersPage() {
  return (
    <Suspense>
      <OrdersContent />
    </Suspense>
  )
}

// ─── Order Drawer helpers ─────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{ fontSize: 11, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, margin: '14px 0 8px' }}>
      {children}
    </h3>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px dotted #eee', fontSize: 13 }}>
      <span style={{ color: '#888' }}>{label}</span>
      <span style={{ color: DARK, textAlign: 'right', maxWidth: '70%' }}>{value}</span>
    </div>
  )
}

function TotalRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
      <span style={{ color: '#666' }}>{label}</span>
      <span style={{ color: DARK }}>{fmt(value)}</span>
    </div>
  )
}

function LineItemRow({ item }: { item: OrderMealPackage }) {
  // Mirrors FM's shared/order-details template field-for-field. The
  // previous version read `quantity` / `extraItems` — neither field is
  // emitted by FM (FM uses `count` and `orderAddOns`), so qty always
  // fell to 1 and modifiers never rendered. Bug repro: Westwoods BBQ
  // #27350018 displayed "1 Burnt Ends $0.00" with no modifier rows,
  // while subtotal was $540. See lib/pricing/lineItem.ts for the
  // shared helpers and FM source citations.
  const qty = lineQty(item)
  const name = item.name || '—'
  const lineTotal = lineRowTotal(item)
  const modifiers = lineModifiers(item)
  return (
    <>
      <tr>
        <td style={lineCell}>{qty}</td>
        <td style={lineCell}>{name}</td>
        <td style={{ ...lineCell, textAlign: 'right' }}>{formatCurrency(lineTotal)}</td>
      </tr>
      {modifiers.map((ex, i) => (
        <tr key={i}>
          <td style={lineCellSub}></td>
          <td style={{ ...lineCellSub, paddingLeft: 24 }}>+ ({modifierQty(ex)}) {ex.name}</td>
          <td style={{ ...lineCellSub, textAlign: 'right' }}>{formatCurrency(modifierRowTotal(ex))}</td>
        </tr>
      ))}
      {(item.specialInstructions || item.comment) && (
        <tr>
          <td style={lineCellSub}></td>
          <td style={{ ...lineCellSub, paddingLeft: 24, fontStyle: 'italic', color: '#888' }} colSpan={2}>
            Special Instructions: {item.specialInstructions || item.comment}
          </td>
        </tr>
      )}
    </>
  )
}

const lineColHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '8px 10px', textAlign: 'left' }
const lineCell: React.CSSProperties = { padding: '8px 10px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
const lineCellSub: React.CSSProperties = { padding: '4px 10px', fontSize: 12, color: '#555' }
