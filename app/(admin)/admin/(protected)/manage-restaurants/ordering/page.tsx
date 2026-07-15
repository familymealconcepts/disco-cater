'use client'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import AddRestaurantDialog from './AddRestaurantDialog'
import EditRestaurantDialog from '../EditRestaurantDialog'

const SORT_BLUE = '#5B6FE8'
type SortKey = 'restaurant' | 'admin' | 'email' | 'createdDate' | 'status' | 'stripe'
const SORT_LABELS: Record<SortKey, string> = {
  restaurant: 'Restaurant', admin: 'Admin', email: 'Email',
  createdDate: 'Registration Date', status: 'Online Ordering', stripe: 'Stripe',
}

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

const STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'ARCHIVED'] as const

interface Restaurant {
  // Stable, guaranteed-unique per-row id assigned on load. FM's ordering list
  // can return the SAME `reference` for several multi-unit locations (e.g.
  // multiple "Colonial Ranch Market" rows), so `reference` is NOT safe as the
  // React key or the optimistic-update match — doing so flipped every matching
  // row at once. `_rowId` keeps each rendered row independent; FM API calls
  // still use the real `reference`.
  _rowId: string
  reference: string
  businessName: string
  // FM's URL-safe slug; used to build the 1P direct ordering URL (/order/[slug]).
  businessNameWithoutSpaces?: string
  url?: string
  blocked?: boolean
  nashAllowed?: boolean
  shipdayEnabled?: boolean
  moneyFlow?: string // 'FAMILY_MEAL' (held) | 'DIRECT' (released)
  onlineOrderingAllowed?: boolean
  restaurantStatus?: string
  createdDate?: string
  adminName?: string
  adminEmail?: string
  admin?: { firstName?: string; lastName?: string; email?: string }
  // FM address object — spread onto each row from /api/admin/restaurants; used to
  // show the map listing location as "City, State".
  address?: { city?: string; state?: string }
  // Merged-in Disco-native restaurant that has no FM record (from
  // /api/admin/disco-native-orphans) — flagged so it's never invisible.
  discoOnly?: boolean
  stripeConnected?: boolean
  fmCreationFailed?: boolean
  fmCreationError?: string
}

// Disco-owned per-restaurant overrides (Neon), keyed by reference. Carries the
// fields we render (visible, menuUploadUrl) plus isPremium/orderUrl so a
// visibility toggle can preserve them on the upsert PATCH.
interface OverrideMeta {
  visible: boolean
  isPremium: boolean
  orderUrl: string
  menuUploadUrl: string | null
  isLive: boolean
  isDiscoNative: boolean
  // Canonical "Accept online orders" value from Neon disco_restaurant_overrides.
  // null = no explicit value stored (unset). This is what the restaurant portal
  // reads/writes — the super admin now reads/writes the same field.
  onlineOrderingEnabled: boolean | null
}

function fmtDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    const mm = String(dt.getMonth() + 1).padStart(2, '0')
    const dd = String(dt.getDate()).padStart(2, '0')
    const yy = String(dt.getFullYear()).slice(-2)
    return `${mm}/${dd}/${yy}`
  } catch { return d }
}

function adminNameOf(r: Restaurant): string {
  return r.adminName || `${r.admin?.firstName || ''} ${r.admin?.lastName || ''}`.trim()
}
function adminEmailOf(r: Restaurant): string {
  return r.adminEmail || r.admin?.email || ''
}

// Online ordering — canonical value lives in Neon disco_restaurant_overrides
// .online_ordering_enabled (what the restaurant portal + native order-gate read).
// Prefer that; a disco-native restaurant with no explicit value defaults to ON
// (matches the order gate's COALESCE(...,true)); FM-backed rows fall back to FM's
// onlineOrderingAllowed. `ov` is the row's OverrideMeta (may be undefined).
function isOnlineWith(r: Restaurant, ov: OverrideMeta | undefined): boolean {
  if (ov && ov.onlineOrderingEnabled != null) return ov.onlineOrderingEnabled === true
  if (ov?.isDiscoNative) return true
  return r.onlineOrderingAllowed === true
}

function Toggle({ checked, onChange, disabled, color = BLUE }: { checked: boolean; onChange: () => void; disabled?: boolean; color?: string }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onChange}
      aria-pressed={checked}
      style={{
        width: 32, height: 18, borderRadius: 9, padding: 0,
        background: checked ? color : '#d9d9d9',
        border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative', transition: 'background 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 16 : 2,
        width: 14, height: 14, background: '#fff', borderRadius: '50%',
        transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
      }} />
    </button>
  )
}

// Stripe Connect status per row. Never-checked (checkedAt === null) shows
// "Unknown"; a row mid-check shows "Checking…". Green = connected, grey = not.
function StripeStatus({ status, checking }: { status?: { connected: boolean; checkedAt: string | null; hasStripeAccount?: boolean }; checking?: boolean }) {
  if (checking) return <span style={{ color: '#9CA3AF', fontSize: 12, whiteSpace: 'nowrap' }}>Checking…</span>
  const dot = (color: string) => (
    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 6, verticalAlign: 'middle' }} />
  )
  // A disco Stripe account (connected during Disco onboarding) is authoritative and
  // needs no FM probe. Otherwise fall back to the probed status (stripe_connected),
  // which only means anything once it's been checked (checkedAt set).
  const connected = status?.hasStripeAccount === true || status?.connected === true
  if (connected) return <span style={{ fontSize: 12, color: '#1D9E75', whiteSpace: 'nowrap' }}>{dot('#1D9E75')}Connected</span>
  if (!status || !status.checkedAt) return <span style={{ color: '#9CA3AF', fontSize: 12 }}>Unknown</span>
  return <span style={{ fontSize: 12, color: '#999', whiteSpace: 'nowrap' }}>{dot('#bbb')}Not connected</span>
}

export default function RestaurantsOrderingPage() {
  const [rows, setRows] = useState<Restaurant[]>([])
  // Disco-native restaurants with no FM record — merged into the list so they're visible.
  const [discoOrphans, setDiscoOrphans] = useState<Restaurant[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  // "Transfer to System Admin" confirmation (Disco-native role promotion).
  const [promoteConfirm, setPromoteConfirm] = useState<Restaurant | null>(null)
  const [promoteBusy, setPromoteBusy] = useState(false)
  // Client-side sort of the loaded page. Default: newest registrations first.
  const [sortKey, setSortKey] = useState<SortKey>('createdDate')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  // A clickable, sort-aware column header. ↑/↓ when active (Disco blue), ⇅ idle.
  function sortTh(key: SortKey) {
    const active = sortKey === key
    const arrow = active ? (sortDir === 'asc' ? '↑' : '↓') : '⇅'
    return (
      <th onClick={() => toggleSort(key)} title={`Sort by ${SORT_LABELS[key]}`}
        style={{ ...colHead, cursor: 'pointer', userSelect: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {SORT_LABELS[key]}
          <span style={{ fontSize: 12, fontWeight: 700, color: active ? SORT_BLUE : '#c2c2cc' }}>{arrow}</span>
        </span>
      </th>
    )
  }

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(0) }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (page > 0) params.set('page', String(page))
    params.set('size', String(pageSize))
    if (search) params.set('search', search)
    if (statusFilter) params.set('restaurantStatus', statusFilter)
    const res = await fetch(`/api/admin/restaurants?${params}`)
    if (res.ok) {
      const d = await res.json()
      // Tag every row with a unique local id. FM can repeat `reference` across
      // multi-unit locations, so we suffix with the array index to guarantee
      // uniqueness for React keys + per-row optimistic updates.
      const content: Restaurant[] = (d.content || []).map((r: Restaurant, i: number) => ({
        ...r,
        _rowId: `${r.reference ?? 'noref'}#${i}`,
      }))
      setRows(content)
      setTotal(d.totalElements || 0)
    } else {
      setError('Failed to load restaurants')
      setRows([])
      setTotal(0)
    }
    setLoading(false)
  }, [page, pageSize, search, statusFilter])

  useEffect(() => { load() }, [load])

  // Load Disco-native restaurants that have no FM record, once, so they can be
  // merged into the FM-sourced list below and never stay invisible.
  useEffect(() => {
    fetch('/api/admin/disco-native-orphans')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (Array.isArray(d?.orphans)) setDiscoOrphans(d.orphans.map((o: Restaurant) => ({ ...o, discoOnly: true }))) })
      .catch(() => {})
  }, [])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  // "Disco Cater Marketplace" — the single Disco-native map/marketplace visibility
  // toggle (disco_restaurant_overrides.visible, what the fullmap filter reads). It
  // does NOT touch any FM field. Toggling opens a confirmation modal; the PATCH
  // (preserving the row's current isPremium/orderUrl) only fires on confirm.
  function requestVisibleToggle(r: Restaurant) {
    setMarketplaceConfirm({ r, next: !(overrideMap[r.reference]?.visible) })
  }

  async function confirmVisible() {
    if (!marketplaceConfirm) return
    const { r, next } = marketplaceConfirm
    const cur = overrideMap[r.reference] || { visible: false, isPremium: false, orderUrl: '', menuUploadUrl: null }
    setMarketplaceBusy(true)
    setOverrideMap(prev => ({ ...prev, [r.reference]: { ...cur, visible: next } }))
    try {
      const res = await fetch('/api/admin/restaurant-overrides', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantReference: r.reference, visible: next, isPremium: cur.isPremium, orderUrl: cur.orderUrl || undefined }),
      })
      if (!res.ok) throw new Error()
      showToast(`${r.businessName} ${next ? 'shown on' : 'hidden from'} the Disco Cater map & marketplace`)
      setMarketplaceConfirm(null)
    } catch {
      setOverrideMap(prev => ({ ...prev, [r.reference]: cur }))
      showToast('Could not update map & marketplace visibility')
    } finally {
      setMarketplaceBusy(false)
    }
  }

  async function toggleNash(r: Restaurant) {
    const next = !r.nashAllowed
    setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, nashAllowed: next } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/nash?nashAllowed=${next}`, { method: 'PATCH' })
    if (!res.ok) setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, nashAllowed: !next } : x))
  }

  // FM has a single Shipday toggle (restaurant.service.ts:317 —
  // PATCH /api/admin/restaurants/{ref}/shipdayEnabled). There are no split
  // delivery/pickup endpoints; the earlier split returned 404.
  async function toggleShipday(r: Restaurant) {
    const next = !r.shipdayEnabled
    setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, shipdayEnabled: next } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/shipday?shipdayEnabled=${next}`, { method: 'PATCH' })
    if (!res.ok) setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, shipdayEnabled: !next } : x))
  }

  // "Hold Payments on FamilyMeal": ON = moneyFlow FAMILY_MEAL (held),
  // OFF = DIRECT (released). FM restaurant-table.component.ts:387-400.
  async function toggleMoneyFlow(r: Restaurant) {
    const held = r.moneyFlow !== 'DIRECT'
    const next = held ? 'DIRECT' : 'FAMILY_MEAL'
    setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, moneyFlow: next } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/money-flow?moneyFlow=${next}`, { method: 'PUT' })
    if (!res.ok) setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, moneyFlow: held ? 'FAMILY_MEAL' : 'DIRECT' } : x))
    else showToast(`${r.businessName}: payments ${next === 'FAMILY_MEAL' ? 'held' : 'released'}`)
  }

  async function deleteRestaurant(r: Restaurant) {
    if (!confirm(`Delete "${r.businessName}"? This cannot be undone.`)) return
    let res = await fetch(`/api/admin/restaurants/${r.reference}`, { method: 'DELETE' })
    // Server safeguard: a restaurant with real order history requires a second,
    // explicit confirmation before it can be deleted.
    if (res.status === 409) {
      const d = await res.json().catch(() => null)
      if (d?.requiresConfirmation) {
        if (!confirm(`⚠️ "${r.businessName}" has ${d.orderCount} order(s) in its history. Deleting it permanently removes the restaurant and cannot be undone.\n\nAre you absolutely sure you want to delete it?`)) return
        res = await fetch(`/api/admin/restaurants/${r.reference}?confirmDeleteWithOrders=${encodeURIComponent(r.reference)}`, { method: 'DELETE' })
      }
    }
    if (res.ok) { showToast(`${r.businessName} deleted`); load() }
    else showToast('Delete failed')
  }

  // Stripe must be connected before online ordering can be toggled — a
  // restaurant can't accept orders without a payout account. Disco-native
  // restaurants connect via disco_restaurant_accounts.stripe_account_id, so a
  // present Stripe account counts as connected too (fallback).
  // A Disco-native restaurant's Stripe account is matched by its admin email (its
  // own identity), since its Disco reference won't equal the FM row reference.
  const hasDiscoStripe = (r: Restaurant) => {
    const email = adminEmailOf(r).toLowerCase()
    return !!email && discoStripeEmails.has(email)
  }
  const isStripeConnected = (r: Restaurant) => {
    const s = stripeMap[r.reference]
    return s?.connected === true || s?.hasStripeAccount === true || hasDiscoStripe(r)
  }
  // Status passed to the Stripe column: OR-in the email-matched Disco connection so
  // a Disco-native restaurant reads Connected even though its reference differs.
  const stripeStatusFor = (r: Restaurant) => {
    const s = stripeMap[r.reference]
    if (hasDiscoStripe(r)) return { connected: s?.connected ?? false, checkedAt: s?.checkedAt ?? null, hasStripeAccount: true }
    return s
  }

  // Online Ordering = FM onlineOrderingAllowed boolean. Toggling opens a
  // confirmation modal; confirming routes through the GET→merge→PUT restaurant
  // endpoint so ONLY onlineOrderingAllowed changes (status/blocked untouched).
  function requestOnlineOrderingToggle(r: Restaurant) {
    // Guard: no Stripe → show an inline warning instead of the confirm modal.
    if (!isStripeConnected(r)) {
      setOrderingWarning(r._rowId)
      setTimeout(() => setOrderingWarning(w => (w === r._rowId ? null : w)), 4000)
      return
    }
    setOrderingWarning(null)
    setOrderingConfirm({ r, next: !isOnlineWith(r, overrideMap[r.reference]) })
  }

  async function confirmOnlineOrdering() {
    if (!orderingConfirm) return
    const { r, next } = orderingConfirm
    setOrderingBusy(true)
    try {
      // Canonical write: Neon disco_restaurant_overrides.online_ordering_enabled —
      // the field the restaurant portal + native order-gate read. Writing it here
      // makes the two sides agree (this was the sync bug: admin read FM's
      // onlineOrderingAllowed, which the disco-native write path never sets).
      const ovRes = await fetch('/api/admin/restaurant-overrides', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantReference: r.reference, onlineOrderingEnabled: next }),
      })
      if (!ovRes.ok) throw new Error()
      // FM-backed restaurants also carry FM's onlineOrderingAllowed — keep FM in
      // sync too. Best-effort: a disco-native restaurant has no FM record (404),
      // which must not fail the toggle.
      if (!overrideMap[r.reference]?.isDiscoNative) {
        await fetch(`/api/admin/restaurants/${r.reference}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ onlineOrderingAllowed: next }),
        }).catch(() => {})
      }
      setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, onlineOrderingAllowed: next } : x))
      setOverrideMap(prev => {
        const cur = prev[r.reference]
        if (!cur) return prev
        return { ...prev, [r.reference]: { ...cur, onlineOrderingEnabled: next } }
      })
      showToast(`${r.businessName}: online ordering ${next ? 'enabled' : 'disabled'}`)
      setOrderingConfirm(null)
    } catch {
      showToast('Could not update online ordering')
    } finally {
      setOrderingBusy(false)
    }
  }

  async function resetPassword(r: Restaurant) {
    if (!confirm(`Send password reset for ${r.adminEmail || r.admin?.email}?`)) return
    const res = await fetch(`/api/admin/restaurants/${r.reference}/reset-password`, { method: 'PUT' })
    const data = await res.json().catch(() => ({} as { emailed?: boolean }))
    if (!res.ok) { showToast('Could not reset the password'); return }
    // The password IS reset even when the email fails (native path returns
    // emailed:false) — say so instead of falsely claiming the email was sent. The
    // FM path omits `emailed`, so undefined = sent.
    if (data?.emailed === false) showToast('Password reset, but the email could not be sent — share the new password manually')
    else showToast('Password reset email sent')
  }

  // Promote the restaurant's Disco account (and its group) to SYSTEM_ADMIN.
  async function confirmPromote() {
    if (!promoteConfirm) return
    setPromoteBusy(true)
    try {
      // Pass the admin's email so the API can find the Disco account even when its
      // restaurant_reference differs from the table reference.
      const email = adminEmailOf(promoteConfirm)
      const res = await fetch(
        `/api/admin/restaurants/${promoteConfirm.reference}/promote-system-admin?email=${encodeURIComponent(email)}`,
        { method: 'POST' },
      )
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setPromoteConfirm(null)
        showToast('Promoted to System Admin — access granted to all locations.')
      } else {
        showToast(data?.error || 'Could not promote to System Admin')
      }
    } catch {
      showToast('Could not promote to System Admin')
    } finally {
      setPromoteBusy(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const [addOpen, setAddOpen] = useState(false)
  const [editRef, setEditRef] = useState<string | null>(null)
  // Online-ordering confirmation modal (FM onlineOrderingAllowed). next = target on/off.
  const [orderingConfirm, setOrderingConfirm] = useState<{ r: Restaurant; next: boolean } | null>(null)
  const [orderingBusy, setOrderingBusy] = useState(false)
  // _rowId of a row showing the "connect Stripe first" inline warning (auto-clears).
  const [orderingWarning, setOrderingWarning] = useState<string | null>(null)
  // Map/marketplace visibility confirmation modal (Neon visible). next = target on/off.
  const [marketplaceConfirm, setMarketplaceConfirm] = useState<{ r: Restaurant; next: boolean } | null>(null)
  const [marketplaceBusy, setMarketplaceBusy] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncProgress, setSyncProgress] = useState('')
  const [fullSyncBusy, setFullSyncBusy] = useState(false)
  const [cacheBusy, setCacheBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [enrichBusy, setEnrichBusy] = useState(false)
  const [enrichProgress, setEnrichProgress] = useState('')

  // One-time: pull cuisine/description/image from Sanity into the map cache.
  async function importSanityData() {
    if (!confirm('This will import cuisine, description and images from Sanity into the map cache. Continue?')) return
    setImportBusy(true)
    setError('')
    try {
      const res = await fetch('/api/admin/import-sanity-restaurants', { method: 'POST' })
      const d = await res.json().catch(() => null)
      if (!res.ok) throw new Error(d?.error || 'Sanity import failed')
      showToast(`Sanity import: ${d.matched} matched, ${d.inserted} inserted, ${d.skipped} skipped, ${d.premium ?? 0} marked Premium`)
    } catch (e) {
      setError((e as Error).message || 'Sanity import failed')
    } finally {
      setImportBusy(false)
    }
  }

  // Rebuild the public map cache (disco_restaurant_cache) from FM.
  async function refreshMapCache() {
    if (!confirm('This will rebuild the map cache from FM (all active restaurants). Continue?')) return
    setCacheBusy(true)
    setError('')
    try {
      const res = await fetch('/api/admin/refresh-restaurant-cache', { method: 'POST' })
      const d = await res.json().catch(() => null)
      if (!res.ok) throw new Error(d?.error || 'Cache refresh failed')
      showToast(`Map cache refreshed: ${d.cached} cached of ${d.total} fetched (${Math.round((d.durationMs || 0) / 1000)}s)`)
    } catch (e) {
      setError((e as Error).message || 'Cache refresh failed')
    } finally {
      setCacheBusy(false)
    }
  }
  // Per-restaurant Stripe status (keyed by reference) from Neon overrides, shown
  // as a column on each row. checkedAt === null means "never synced".
  const [stripeMap, setStripeMap] = useState<Record<string, { connected: boolean; checkedAt: string | null; hasStripeAccount: boolean }>>({})
  // Admin emails of Disco-native accounts that ARE Stripe-connected. Disco-native
  // restaurants connect Stripe under their Disco reference, which never matches the
  // FM reference this table is keyed by — so we match FM rows to their Disco Stripe
  // account by admin email (the reliable FM↔Disco link) instead of by reference.
  const [discoStripeEmails, setDiscoStripeEmails] = useState<Set<string>>(new Set())
  // True once the cached Stripe statuses have loaded — gates the background check
  // so we don't treat everything as "never checked" before the cache arrives.
  const [stripeLoaded, setStripeLoaded] = useState(false)
  // References currently being background-checked (drives the row "Checking…").
  const [checkingRefs, setCheckingRefs] = useState<Set<string>>(new Set())
  // References we've already kicked off a background check for this session, so a
  // re-render / page revisit never re-checks the same restaurant.
  const attemptedRef = useRef<Set<string>>(new Set())
  // Disco overrides (visibility / Premium / menu) per reference, from the same fetch.
  const [overrideMap, setOverrideMap] = useState<Record<string, OverrideMeta>>({})

  // Client-side sort of the currently-loaded page (no extra API calls).
  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const stripeRank = (r: Restaurant) => {
      const s = stripeMap[r.reference]
      if (!s || !s.checkedAt) return -1 // never-synced ranks lowest
      return s.connected ? 1 : 0
    }
    const val = (r: Restaurant): string | number => {
      switch (sortKey) {
        case 'restaurant': return r.businessName || ''
        case 'admin': return adminNameOf(r)
        case 'email': return adminEmailOf(r)
        case 'createdDate': { const t = r.createdDate ? new Date(r.createdDate).getTime() : 0; return Number.isFinite(t) ? t : 0 }
        case 'status': return isOnlineWith(r, overrideMap[r.reference]) ? 1 : 0
        case 'stripe': return stripeRank(r)
      }
    }
    // Merge in Disco-native restaurants that have no FM record, deduped by
    // REFERENCE against the FM rows. A true orphan has no FM record, so its
    // reference never appears in the FM list — meaning every orphan is shown.
    // (Deduping by admin *email* was wrong: it hid a distinct Disco-native
    // restaurant whenever it happened to share an admin email with an unrelated FM
    // restaurant — e.g. searching "test" surfaced FM "Test 23"/"Test Bagel" and
    // suppressed their separate Disco-native twins, hiding the orphans entirely.)
    const fmRefs = new Set(rows.map(r => r.reference))
    const orphanRows = discoOrphans
      .filter(o => !fmRefs.has(o.reference))
      .map(o => ({ ...o, _rowId: `disco-only#${o.reference}`, discoOnly: true }))
    return [...orphanRows, ...rows].sort((a, b) => {
      const va = val(a), vb = val(b)
      const cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), undefined, { sensitivity: 'base' })
      return cmp * dir
    })
  }, [rows, discoOrphans, sortKey, sortDir, stripeMap])

  const loadStripeMap = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/restaurant-overrides')
      if (!res.ok) return
      const d = await res.json()
      const sMap: Record<string, { connected: boolean; checkedAt: string | null; hasStripeAccount: boolean }> = {}
      const oMap: Record<string, OverrideMeta> = {}
      for (const o of (d?.overrides || []) as {
        restaurantReference: string; stripeConnected: boolean; stripeCheckedAt: string | null
        visible?: boolean; isPremium?: boolean; orderUrl?: string; menuUploadUrl?: string | null
        isLive?: boolean; isDiscoNative?: boolean; hasStripeAccount?: boolean
        onlineOrderingEnabled?: boolean | null
      }[]) {
        sMap[o.restaurantReference] = { connected: !!o.stripeConnected, checkedAt: o.stripeCheckedAt, hasStripeAccount: !!o.hasStripeAccount }
        oMap[o.restaurantReference] = {
          visible: !!o.visible, isPremium: !!o.isPremium,
          orderUrl: o.orderUrl || '', menuUploadUrl: o.menuUploadUrl ?? null,
          isLive: !!o.isLive, isDiscoNative: !!o.isDiscoNative,
          onlineOrderingEnabled: o.onlineOrderingEnabled ?? null,
        }
      }
      setStripeMap(sMap)
      setOverrideMap(oMap)
      setDiscoStripeEmails(new Set((Array.isArray(d?.discoStripeEmails) ? d.discoStripeEmails : []).map((e: string) => String(e).toLowerCase())))
    } catch { /* non-fatal: the columns just won't render */ }
    finally { setStripeLoaded(true) }
  }, [])

  useEffect(() => { loadStripeMap() }, [loadStripeMap])

  // Smart background Stripe check: once the cached statuses + the current page's
  // rows are loaded, check ONLY the rows that have never been checked
  // (stripe_checked_at IS NULL → no cached status). Already-connected and
  // already-not-connected rows are trusted forever and never re-checked here.
  // attemptedRef guards against re-runs / loops; the manual "Sync Stripe Status"
  // button remains for full re-checks.
  useEffect(() => {
    if (!stripeLoaded || loading || !rows.length) return
    const toCheck = Array.from(new Set(
      rows.map(r => r.reference).filter(ref => ref && !attemptedRef.current.has(ref) && !stripeMap[ref]?.checkedAt)
    )).slice(0, pageSize)
    if (!toCheck.length) return
    toCheck.forEach(ref => attemptedRef.current.add(ref))
    setCheckingRefs(prev => new Set([...prev, ...toCheck]))
    ;(async () => {
      try {
        const res = await fetch('/api/admin/sync-stripe-status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantReferences: toCheck }),
        })
        if (res.ok) {
          const d = await res.json()
          const statuses = (d?.statuses || {}) as Record<string, boolean>
          const now = new Date().toISOString()
          setStripeMap(prev => {
            const next = { ...prev }
            for (const ref of toCheck) {
              next[ref] = { connected: !!statuses[ref], checkedAt: now, hasStripeAccount: prev[ref]?.hasStripeAccount ?? false }
            }
            return next
          })
        }
      } catch { /* leave as Unknown on failure */ }
      finally {
        setCheckingRefs(prev => { const n = new Set(prev); toCheck.forEach(ref => n.delete(ref)); return n })
      }
    })()
  }, [stripeLoaded, loading, rows, stripeMap, pageSize])

  // Probe FM Stripe Connect status for every visible restaurant, one batch at a
  // time (each request stays under the function-duration limit), looping until
  // the route reports done. Stops on the first failed batch.
  async function syncStripeStatus() {
    if (!confirm('This will check Stripe Connect status for all visible restaurants. This may take several minutes. Continue?')) return
    setSyncBusy(true)
    setSyncProgress('')
    setError('')
    const BATCH = 25
    let offset = 0
    let connected = 0
    let notConnected = 0
    let total = 0
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await fetch('/api/admin/sync-stripe-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchSize: BATCH, offset }),
        })
        const d = await res.json().catch(() => null)
        if (!res.ok) throw new Error(d?.error || 'Stripe status sync failed')

        connected += d.connected || 0
        notConnected += d.notConnected || 0
        total = d.total || 0
        setSyncProgress(`Syncing… ${Math.min(d.nextOffset, total)}/${total}`)

        if (d.done) break
        offset = d.nextOffset
      }
      showToast(`Stripe sync complete: ${connected} connected, ${notConnected} not connected (of ${total})`)
      await loadStripeMap()
    } catch (e) {
      const msg = e instanceof Error ? e.message : ((e as { error?: string })?.error || String(e))
      setError(msg || 'Stripe status sync failed')
    } finally {
      setSyncBusy(false)
      setSyncProgress('')
    }
  }

  // Full Stripe Connect sync across EVERY FM restaurant (all pages) in one call.
  async function fullSyncStripe() {
    if (!confirm('Run a FULL Stripe Connect sync across ALL restaurants? This may take a couple of minutes.')) return
    setFullSyncBusy(true)
    setError('')
    try {
      const res = await fetch('/api/admin/sync-stripe-status/full', { method: 'POST' })
      const d = await res.json().catch(() => null)
      if (!res.ok) throw new Error(d?.error || 'Full sync failed')
      showToast(`Synced ${d.total} restaurants. ${d.connected} connected.`)
      await loadStripeMap()
    } catch (e) {
      setError((e as Error).message || 'Full sync failed')
    } finally {
      setFullSyncBusy(false)
    }
  }

  // Enrich cache rows missing cuisine/description/image via Google Places, one
  // batch at a time, looping until the route reports done. Stops on first error.
  async function enrichWithGoogle() {
    if (!confirm('This will look up cuisine, descriptions, and images from Google Places for restaurants missing them. This may take several minutes. Continue?')) return
    setEnrichBusy(true)
    setEnrichProgress('')
    setError('')
    const BATCH = 25
    let offset = 0
    let enriched = 0
    let notFound = 0
    let skipped = 0
    let processed = 0
    let total = 0
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await fetch('/api/admin/enrich-restaurants-places', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchSize: BATCH, offset }),
        })
        const d = await res.json().catch(() => null)
        console.log('[Enrich] Batch result:', JSON.stringify(d))
        if (!res.ok) throw new Error(d?.error || 'Enrichment failed')

        enriched += d.enriched || 0
        notFound += d.notFound || 0
        skipped += d.skipped || 0
        processed += (d.enriched || 0) + (d.notFound || 0) + (d.skipped || 0)
        // `total` shrinks as rows are enriched, so anchor the denominator to the
        // largest total + processed count we've seen for a stable progress bar.
        total = Math.max(total, (d.total || 0) + enriched)
        setEnrichProgress(`Enriching… ${Math.min(processed, total)}/${total}`)

        if (d.done) break
        offset = d.nextOffset
      }
      showToast(`Enrichment complete: ${enriched} enriched, ${notFound} not found, ${skipped} skipped`)
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : ((e as { error?: string })?.error || String(e))
      setError(msg || 'Enrichment failed')
    } finally {
      setEnrichBusy(false)
      setEnrichProgress('')
    }
  }

  // One-time: show every active FM restaurant on the Disco fullmap.
  async function bulkSetVisible() {
    if (!confirm('This will show all active FM restaurants on the Disco Cater map. Continue?')) return
    setBulkBusy(true)
    setError('')
    try {
      const res = await fetch('/api/admin/bulk-set-visible', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) throw new Error(d?.error || 'Bulk update failed')
      showToast(`Map updated: ${d.inserted} added, ${d.updated} already-present set visible`)
    } catch (e) {
      setError((e as Error).message || 'Bulk update failed')
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, height: '100vh', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* CSS-only hover tooltips for the header action buttons. */}
      <style>{`
        .ord-btn { position: relative; }
        .ord-tip {
          position: absolute;
          top: calc(100% + 6px);
          left: 50%;
          transform: translateX(-50%);
          background: #1A1028;
          color: #fff;
          font-size: 12px;
          font-weight: 500;
          line-height: 1.4;
          text-align: center;
          border-radius: 6px;
          padding: 6px 10px;
          max-width: 200px;
          width: max-content;
          white-space: normal;
          z-index: 100;
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transition: opacity 0.12s ease;
        }
        .ord-btn:hover .ord-tip { opacity: 1; visibility: visible; }
      `}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, gap: 16, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Restaurants — Ordering</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(0) }} style={{ ...selectSt, minWidth: 160 }}>
            <option value="">All statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input
            type="text" placeholder="Search…" value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            style={{ ...inputSt, width: 240 }}
          />
          <button className="ord-btn" onClick={bulkSetVisible} disabled={bulkBusy}
            style={{ display: 'inline-flex', alignItems: 'center', background: '#fff', color: BLUE, border: `1.5px solid ${BLUE}`, borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: bulkBusy ? 'wait' : 'pointer', fontFamily: F, whiteSpace: 'nowrap', opacity: bulkBusy ? 0.6 : 1 }}>
            {bulkBusy ? 'Setting…' : 'Bulk Set Visible'}
            <i className="ti ti-info-circle" style={{ fontSize: 12, marginLeft: 4, opacity: 0.6 }} />
            <span className="ord-tip">Mark all active FM restaurants as visible on the Disco Cater map</span>
          </button>
          <button className="ord-btn" onClick={syncStripeStatus} disabled={syncBusy}
            style={{ display: 'inline-flex', alignItems: 'center', background: '#fff', color: BLUE, border: `1.5px solid ${BLUE}`, borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: syncBusy ? 'wait' : 'pointer', fontFamily: F, whiteSpace: 'nowrap', opacity: syncBusy ? 0.6 : 1 }}>
            {syncBusy ? (syncProgress || 'Syncing…') : 'Sync Stripe Status'}
            <i className="ti ti-info-circle" style={{ fontSize: 12, marginLeft: 4, opacity: 0.6 }} />
            <span className="ord-tip">Check which restaurants have Stripe Connect set up (required to accept orders)</span>
          </button>
          <button className="ord-btn" onClick={fullSyncStripe} disabled={fullSyncBusy}
            style={{ display: 'inline-flex', alignItems: 'center', background: BLUE, color: '#fff', border: `1.5px solid ${BLUE}`, borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: fullSyncBusy ? 'wait' : 'pointer', fontFamily: F, whiteSpace: 'nowrap', opacity: fullSyncBusy ? 0.6 : 1 }}>
            {fullSyncBusy ? 'Full syncing…' : 'Full Sync'}
            <i className="ti ti-info-circle" style={{ fontSize: 12, marginLeft: 4, opacity: 0.6 }} />
            <span className="ord-tip">Check Stripe Connect for EVERY restaurant (all pages) and update the table</span>
          </button>
          <button className="ord-btn" onClick={refreshMapCache} disabled={cacheBusy}
            style={{ display: 'inline-flex', alignItems: 'center', background: '#fff', color: BLUE, border: `1.5px solid ${BLUE}`, borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: cacheBusy ? 'wait' : 'pointer', fontFamily: F, whiteSpace: 'nowrap', opacity: cacheBusy ? 0.6 : 1 }}>
            {cacheBusy ? 'Refreshing…' : 'Refresh Map Cache'}
            <i className="ti ti-info-circle" style={{ fontSize: 12, marginLeft: 4, opacity: 0.6 }} />
            <span className="ord-tip">Rebuild the restaurant map data from FamilyMeal (run after adding new restaurants)</span>
          </button>
          {/* "Import Sanity Data" button hidden per request — importSanityData()
              and /api/admin/import-sanity-restaurants remain available. */}
          <button className="ord-btn" onClick={enrichWithGoogle} disabled={enrichBusy}
            style={{ display: 'inline-flex', alignItems: 'center', background: '#fff', color: BLUE, border: `1.5px solid ${BLUE}`, borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: enrichBusy ? 'wait' : 'pointer', fontFamily: F, whiteSpace: 'nowrap', opacity: enrichBusy ? 0.6 : 1 }}>
            {enrichBusy ? (enrichProgress || 'Enriching…') : 'Enrich with Google'}
            <i className="ti ti-info-circle" style={{ fontSize: 12, marginLeft: 4, opacity: 0.6 }} />
            <span className="ord-tip">Fetch cuisine, descriptions and photos from Google Places for restaurants missing this data</span>
          </button>
          <button onClick={() => setAddOpen(true)}
            style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
            + Add Restaurant
          </button>
        </div>
      </div>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {/* Grow to fill the remaining viewport height (flex:1) and scroll the rows
          inside this container so the sticky header has a scrolling ancestor to
          pin against. minHeight:0 lets the flex child shrink so its own overflow
          scrolls instead of the page. */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto', flex: 1, minHeight: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1500 }}>
          <thead>
            <tr>
              <th style={colHead} title="Show on Disco Cater map and marketplace">Disco Cater Marketplace</th>
              {sortTh('restaurant')}
              {sortTh('admin')}
              {sortTh('email')}
              {sortTh('createdDate')}
              <th style={colHead}>Checkout Page</th>
              {sortTh('stripe')}
              {sortTh('status')}
              <th style={colHead}>Third-Party Allowed</th>
              <th style={colHead}>Hold Payments</th>
              <th style={colHead}>Shipday</th>
              {/* Pinned to the right edge so the action buttons stay visible
                  (and never clip) while the wide table scrolls horizontally. */}
              <th style={{ ...colHead, textAlign: 'right', position: 'sticky', right: 0, top: 0, zIndex: 3, minWidth: 120, borderLeft: '1px solid #f0f0f0' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={12} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !rows.length && <tr><td colSpan={12} style={{ ...cell, textAlign: 'center', color: '#999' }}>No restaurants.</td></tr>}
            {!loading && sortedRows.map(r => {
              const adminName = r.adminName || `${r.admin?.firstName || ''} ${r.admin?.lastName || ''}`.trim()
              const adminEmail = r.adminEmail || r.admin?.email || ''
              return (
                <tr key={r._rowId}>
                  {/* Disco Cater Marketplace: the single Disco-native map/marketplace
                      visibility toggle (disco_restaurant_overrides.visible). */}
                  <td style={cell}>
                    <Toggle checked={!!overrideMap[r.reference]?.visible} onChange={() => requestVisibleToggle(r)} color="#1D9E75" />
                  </td>
                  <td style={{ ...cell, fontWeight: 600 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {r.businessName}
                      {r.discoOnly ? (
                        <span
                          title={r.fmCreationFailed ? `FamilyMeal record creation failed: ${r.fmCreationError || 'unknown error'}` : 'Live in Disco with no FamilyMeal record'}
                          style={{ fontSize: 10, fontWeight: 600, color: '#B45309', background: '#FEF3C7', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}
                        >Disco-only · no FM record</span>
                      ) : overrideMap[r.reference]?.isDiscoNative ? (
                        <span style={{ fontSize: 10, fontWeight: 400, color: '#6B7280', background: '#F3F4F6', padding: '2px 6px', borderRadius: 4 }}>Disco</span>
                      ) : null}
                    </span>
                    {(r.address?.city || r.address?.state) && (
                      <div style={{ fontSize: 11, fontWeight: 400, color: '#999', marginTop: 2 }}>
                        {[r.address?.city, r.address?.state].filter(Boolean).join(', ')}
                      </div>
                    )}
                  </td>
                  <td style={{ ...cell, color: '#555' }}>{adminName || '—'}</td>
                  <td style={{ ...cell, color: '#555' }}>{adminEmail}</td>
                  <td style={{ ...cell, color: '#666' }}>{fmtDate(r.createdDate)}</td>
                  {/* Checkout Page: the 1P direct ordering URL (/order/[slug]),
                      slug = FM businessNameWithoutSpaces lowercased. */}
                  <td style={cell}>
                    {(() => {
                      const slug = (r.businessNameWithoutSpaces || r.businessName || '').toLowerCase().replace(/[^a-z0-9]/g, '')
                      return slug
                        ? <a href={`https://www.discocater.com/order/${slug}`} target="_blank" rel="noreferrer" title={`https://www.discocater.com/order/${slug}`} style={{ color: BLUE, textDecoration: 'none', fontSize: 16 }}>↗</a>
                        : '—'
                    })()}
                  </td>
                  <td style={cell}><StripeStatus status={stripeStatusFor(r)} checking={checkingRefs.has(r.reference)} /></td>
                  {/* Online Ordering: FM onlineOrderingAllowed boolean. Disabled
                      until Stripe is connected (can't accept orders without payouts). */}
                  <td style={cell}>
                    {(() => {
                      const stripeOk = isStripeConnected(r)
                      return (
                        <>
                          <div
                            title={stripeOk ? undefined : 'Stripe must be connected before enabling online ordering'}
                            onClick={stripeOk ? undefined : () => requestOnlineOrderingToggle(r)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, opacity: stripeOk ? 1 : 0.4, cursor: stripeOk ? 'default' : 'not-allowed' }}
                          >
                            <Toggle checked={isOnlineWith(r, overrideMap[r.reference])} onChange={() => requestOnlineOrderingToggle(r)} disabled={!stripeOk} color="#1D9E75" />
                            <span style={{ fontSize: 12, color: isOnlineWith(r, overrideMap[r.reference]) ? '#1D9E75' : '#999', fontWeight: 600 }}>
                              {isOnlineWith(r, overrideMap[r.reference]) ? 'On' : 'Off'}
                            </span>
                          </div>
                          {orderingWarning === r._rowId && (
                            <div style={{ fontSize: 11, color: '#E53935', marginTop: 4, maxWidth: 220, lineHeight: 1.4 }}>
                              This restaurant must connect Stripe before online ordering can be enabled.
                            </div>
                          )}
                        </>
                      )
                    })()}
                  </td>
                  <td style={cell}><Toggle checked={!!r.nashAllowed} onChange={() => toggleNash(r)} /></td>
                  <td style={cell}><Toggle checked={r.moneyFlow !== 'DIRECT'} onChange={() => toggleMoneyFlow(r)} color="#EFB84A" /></td>
                  <td style={cell}><Toggle checked={!!r.shipdayEnabled} onChange={() => toggleShipday(r)} /></td>
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap', position: 'sticky', right: 0, zIndex: 1, minWidth: 120, background: '#fff', borderLeft: '1px solid #f0f0f0' }}>
                    <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <button title="Refresh" onClick={() => load()} style={iconBtn}>⟳</button>
                      <button title="Edit restaurant" onClick={() => setEditRef(r.reference)} style={{ ...iconBtn, color: '#6B6EF9', fontWeight: 700 }}>Edit</button>
                      <button title="Delete" onClick={() => deleteRestaurant(r)} style={{ ...iconBtn, color: '#E53935' }}>🗑</button>
                      <Kebab
                        menuUrl={overrideMap[r.reference]?.menuUploadUrl || null}
                        onResetPassword={() => resetPassword(r)}
                        onTransferSystemAdmin={() => setPromoteConfirm(r)}
                      />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ fontSize: 12, color: '#666' }}>{total} restaurant{total === 1 ? '' : 's'}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
          <span>Per page:</span>
          <select value={pageSize} onChange={e => { setPage(0); setPageSize(Number(e.target.value)) }} style={smallSelect}>
            {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, background: DARK, color: '#fff',
          padding: '10px 16px', borderRadius: 8, fontSize: 13, zIndex: 400,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>{toast}</div>
      )}

      {/* Visual hint for the gold theme — show on hover of status select */}
      <style>{`
        select:focus { outline: 2px solid ${GOLD}; outline-offset: 1px; }
      `}</style>

      {addOpen && (
        <AddRestaurantDialog
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); showToast('Restaurant created'); setPage(0); load() }}
        />
      )}

      {editRef && (
        <EditRestaurantDialog
          restaurantRef={editRef}
          onClose={() => setEditRef(null)}
          onSaved={(msg) => { setEditRef(null); showToast(msg); load() }}
        />
      )}

      {orderingConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,15,40,0.45)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '24px 26px', maxWidth: 440, width: '90%', boxShadow: '0 12px 40px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 10 }}>
              {orderingConfirm.next ? 'Turn on' : 'Turn off'} online ordering?
            </div>
            <p style={{ fontSize: 13.5, color: '#555', lineHeight: 1.55, margin: '0 0 22px' }}>
              {orderingConfirm.next
                ? <>Turn on online ordering for <strong>{orderingConfirm.r.businessName}</strong>? Customers will be able to place orders.</>
                : <>Turn off online ordering for <strong>{orderingConfirm.r.businessName}</strong>? This will prevent customers from placing new orders.</>}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setOrderingConfirm(null)} disabled={orderingBusy}
                style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: orderingBusy ? 'default' : 'pointer', fontFamily: F, color: '#555' }}>
                Cancel
              </button>
              <button onClick={confirmOnlineOrdering} disabled={orderingBusy}
                style={{ background: orderingConfirm.next ? '#1D9E75' : '#E53935', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: orderingBusy ? 'wait' : 'pointer', fontFamily: F, opacity: orderingBusy ? 0.7 : 1 }}>
                {orderingBusy ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {marketplaceConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,15,40,0.45)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '24px 26px', maxWidth: 440, width: '90%', boxShadow: '0 12px 40px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 10 }}>
              {marketplaceConfirm.next ? 'Show on' : 'Hide from'} the Disco Cater map &amp; marketplace?
            </div>
            <p style={{ fontSize: 13.5, color: '#555', lineHeight: 1.55, margin: '0 0 22px' }}>
              {marketplaceConfirm.next
                ? <>Show <strong>{marketplaceConfirm.r.businessName}</strong> on the Disco Cater map and marketplace?</>
                : <>Hide <strong>{marketplaceConfirm.r.businessName}</strong> from the Disco Cater map and marketplace? They will no longer appear in search results.</>}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setMarketplaceConfirm(null)} disabled={marketplaceBusy}
                style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: marketplaceBusy ? 'default' : 'pointer', fontFamily: F, color: '#555' }}>
                Cancel
              </button>
              <button onClick={confirmVisible} disabled={marketplaceBusy}
                style={{ background: marketplaceConfirm.next ? '#1D9E75' : '#E53935', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: marketplaceBusy ? 'wait' : 'pointer', fontFamily: F, opacity: marketplaceBusy ? 0.7 : 1 }}>
                {marketplaceBusy ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {promoteConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,15,40,0.45)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '24px 26px', maxWidth: 460, width: '90%', boxShadow: '0 12px 40px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 10 }}>
              Promote to System Admin?
            </div>
            <p style={{ fontSize: 13.5, color: '#555', lineHeight: 1.55, margin: '0 0 22px' }}>
              Promote <strong>{adminNameOf(promoteConfirm) || adminEmailOf(promoteConfirm) || 'this admin'}</strong> to System Admin?
              They will have access to all locations under <strong>{promoteConfirm.businessName}</strong>.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setPromoteConfirm(null)} disabled={promoteBusy}
                style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: promoteBusy ? 'default' : 'pointer', fontFamily: F, color: '#555' }}>
                Cancel
              </button>
              <button onClick={confirmPromote} disabled={promoteBusy}
                style={{ background: '#5B6FE8', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: promoteBusy ? 'wait' : 'pointer', fontFamily: F, opacity: promoteBusy ? 0.7 : 1 }}>
                {promoteBusy ? 'Promoting…' : 'Promote'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Row "…" actions menu. The menu is rendered in a PORTAL on document.body so it
// escapes the table container's `overflow: auto` (which previously clipped it,
// especially for the last rows). Position is computed from the trigger button's
// getBoundingClientRect() each time it opens; it closes on outside click and on
// scroll (capture, so the inner scrolling table fires it too) / resize.
const KEBAB_MENU_WIDTH = 200

function Kebab({ menuUrl, onResetPassword, onTransferSystemAdmin }: { menuUrl: string | null; onResetPassword: () => void; onTransferSystemAdmin: () => void }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  function openMenu() {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    // Right-align the menu under the button, clamped to the viewport.
    const left = Math.max(8, Math.min(rect.right - KEBAB_MENU_WIDTH, window.innerWidth - KEBAB_MENU_WIDTH - 8))
    setPos({ top: rect.bottom + 4, left })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function onDocPointer(e: MouseEvent) {
      // Ignore clicks on the menu itself or the trigger (the trigger's own
      // onClick handles toggling).
      if (menuRef.current?.contains(e.target as Node)) return
      if (btnRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const close = () => setOpen(false)
    window.addEventListener('mousedown', onDocPointer)
    window.addEventListener('scroll', close, true) // capture → inner table scroll too
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', onDocPointer)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const itemStyle: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '10px 14px', fontSize: 13, color: DARK, cursor: 'pointer', fontFamily: F }

  // "View Menu": an http(s) URL opens in a new tab; any other non-empty value
  // (a stored filename / blob ref) triggers a download; empty → disabled.
  const hasMenu = !!(menuUrl && menuUrl.trim())
  function viewMenu() {
    if (!hasMenu) return
    const url = (menuUrl as string).trim()
    if (/^https?:\/\//i.test(url)) {
      window.open(url, '_blank', 'noopener')
    } else {
      const a = document.createElement('a')
      a.href = url
      a.download = url.split('/').pop() || 'menu'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  }

  return (
    <>
      <button ref={btnRef} title="More" onClick={() => (open ? setOpen(false) : openMenu())} style={iconBtn}>⋯</button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: KEBAB_MENU_WIDTH, background: '#fff', border: '1px solid #eee', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.12)', zIndex: 1000 }}
        >
          <button
            onClick={() => { if (!hasMenu) return; setOpen(false); viewMenu() }}
            disabled={!hasMenu}
            title={hasMenu ? undefined : 'No menu uploaded'}
            style={{ ...itemStyle, color: hasMenu ? DARK : '#bbb', cursor: hasMenu ? 'pointer' : 'not-allowed' }}>
            View Menu
          </button>
          <button onClick={() => { setOpen(false); onResetPassword() }} style={{ ...itemStyle, borderTop: '1px solid #f0f0f0' }}>
            Reset password
          </button>
          <button onClick={() => { setOpen(false); onTransferSystemAdmin() }} style={{ ...itemStyle, borderTop: '1px solid #f0f0f0' }}>
            Transfer to System Admin
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2 }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const selectSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const iconBtn: React.CSSProperties = { background: '#f5f5f8', border: '1px solid #e8e8ee', borderRadius: 6, padding: '4px 8px', fontSize: 13, cursor: 'pointer', color: '#555', fontFamily: F, lineHeight: 1 }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
