'use client'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import AddRestaurantDialog from './AddRestaurantDialog'
import EditRestaurantDialog from '../EditRestaurantDialog'
import { evaluateMarketplaceReadiness } from '../../../../../../lib/marketplace-visibility'

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
  // Canonical money flow from Neon disco_restaurant_overrides.money_flow.
  // null = no explicit value stored, which every consumer already treats as
  // DIRECT (promo gates test `=== 'FAMILY_MEAL'`; disco-native-orphans selects
  // COALESCE(money_flow,'DIRECT')).
  moneyFlow: string | null
  // FM-side menu drift (disco_menu_drift_snapshots) — set for Disco-native
  // restaurants whose FM menu has changed since the last import/verification.
  menuDriftDetected: boolean
  menuDriftDetails: { type: string; reference: string; name: string; before?: string | number; after?: string | number }[]
  // Disco-native restaurant with a set-password invite that was issued but
  // never accepted before its window passed (invite_token still set,
  // invite_token_expires_at < NOW()) — nobody can log in. Cheapest real
  // signal for a dead invite; see Kebab's "Resend invite".
  inviteExpired: boolean
  // Disco-native only — null = active, a timestamp = archived. Stronger than
  // isLive/visible; the Archive button reads this to switch to Restore.
  archivedAt: string | null
}

// Fallback used only when an optimistic patch (archive/restore) needs to
// write into overrideMap before that row's real override entry has loaded
// from /api/admin/restaurant-overrides — should be rare, since Archive/
// Restore only render for rows that already have one.
function defaultOverrideMeta(isDiscoNative: boolean): OverrideMeta {
  return {
    visible: false, isPremium: false, orderUrl: '', menuUploadUrl: null,
    isLive: false, isDiscoNative, onlineOrderingEnabled: null, moneyFlow: null,
    menuDriftDetected: false, menuDriftDetails: [], inviteExpired: false,
    archivedAt: null,
  }
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

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url)
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

// One retry with a short backoff — FM pages occasionally 504 transiently;
// a single retry recovers those without materially slowing the load.
async function fetchPageWithRetry(url: string): Promise<any | null> {
  const first = await fetchJson(url)
  if (first) return first
  await new Promise(r => setTimeout(r, 1500))
  return fetchJson(url)
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

// Money flow — "Hold Payments on FamilyMeal". FAMILY_MEAL = held, DIRECT =
// released.
//
// This used to be read straight off FM's admin-list value as
// `r.moneyFlow !== 'DIRECT'`, which meant ABSENT displayed as HELD. 28
// restaurants showed "payments held" while nothing was held — 18 disco-native
// (Love & Plates, Aztec Dave's Cantina, Tom Toms Italian, Lee's Chinese Food,
// Cena Vegan, Rendang Republic, Almost Home + 11 test restaurants) and 10
// FM-backed with no admin-list row (Katz's Deli, Westwood Fountain, Apollo
// Bagels - Industry City, Westwoods BBQ & Spice Co, 502 Baking Company...).
// A native restaurant has no FM record at all, so "absent" was never a
// statement about its payouts.
//
// Prefer Neon (now kept correct for FM-backed rows by the money-flow
// reconciler), fall back to FM's value, and default to DIRECT when neither has
// one — the same default every other consumer already applies.
function effectiveMoneyFlow(r: Restaurant, ov: OverrideMeta | undefined): 'DIRECT' | 'FAMILY_MEAL' {
  const v = ov?.moneyFlow ?? r.moneyFlow ?? null
  return v === 'FAMILY_MEAL' ? 'FAMILY_MEAL' : 'DIRECT'
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
  // Set when the assembled row count doesn't reconcile against FM's
  // totalElements — i.e. one or more pages failed even after retry. The list
  // still renders (partial data beats none for an admin mid-task) but a
  // banner makes the gap impossible to miss instead of pretending it's whole.
  const [incomplete, setIncomplete] = useState<{ loaded: number; expected: number; failedPages: number } | null>(null)
  // "Transfer to System Admin" confirmation (Disco-native role promotion).
  const [promoteConfirm, setPromoteConfirm] = useState<Restaurant | null>(null)
  const [promoteBusy, setPromoteBusy] = useState(false)
  // Permanent delete — test restaurants / duplicates only (native, no FM
  // record). Two-step: fetch a live preview first (never trust a stale one),
  // show it, only then allow the actual irreversible delete.
  const [deletePreview, setDeletePreview] = useState<{
    r: Restaurant
    eligible: boolean
    reason: string | null
    restaurantName: string | null
    orderCount: number
    order: { total: number | null; status: string | null; customerEmail: string | null; customerName: string | null; placedAt: string | null } | null
    rowCounts: Record<string, number>
  } | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
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

  // Read the full restaurant admin-list from Neon (disco_restaurant_admin_list_cache)
  // instead of calling FM directly. FM's restaurant-list endpoint has a low
  // concurrency ceiling and pulling ~9 pages sequentially on every page load
  // took ~145s — this now reads a background-synced cache in one fast Neon
  // query instead (see lib/restaurant-admin-list-cache.ts, synced every 15
  // min by a cron + this page's own "Refresh Now" button). restaurantStatus
  // used to be filtered server-side on the FM request; now that the full set
  // is always read from cache, that filter runs client-side in visibleRows
  // above, alongside search — both across the combined FM + Disco-only set.
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setIncomplete(null)
    try {
      const data = await fetchPageWithRetry('/api/admin/restaurant-admin-list-cache')
      if (!data) { setError('Failed to load restaurants'); setRows([]); setTotal(0); setLoading(false); return }
      const all: unknown[] = Array.isArray(data.content) ? data.content : []
      const totalElements = Number(data.totalElements ?? 0)
      // Tag every row with a unique local id. FM can repeat `reference` across
      // multi-unit locations, so we suffix with the array index to guarantee
      // uniqueness for React keys + per-row optimistic updates.
      const content: Restaurant[] = all.map((r, i) => ({ ...(r as Restaurant), _rowId: `${(r as Restaurant).reference ?? 'noref'}#${i}` }))
      setRows(content)
      setTotal(totalElements)
      setCacheMeta({ cachedAt: data.cachedAt ?? null, lastError: data.lastError ?? null })
      // Reconcile against the cache's own last-successful-sync total. This
      // should always match by construction — the cache only ever swaps in a
      // fully-reconciled set (see refreshRestaurantAdminListCache) — so a
      // mismatch here means the cache hasn't been populated yet (fresh
      // deploy, before the first cron tick) rather than a live-fetch
      // failure. Same banner either way: never render a partial list as whole.
      if (totalElements > 0 && content.length < totalElements) {
        setIncomplete({ loaded: content.length, expected: totalElements, failedPages: 0 })
      }
    } catch {
      setError('Failed to load restaurants')
      setRows([])
      setTotal(0)
    }
    setLoading(false)
  }, [])

  // Manual cache refresh — an admin who knows something changed on FM's side
  // doesn't have to wait for the next 15-min cron tick. Runs the identical
  // sequential-fetch + reconcile + staging-swap logic as the cron; on
  // failure the live cache (and this page) are untouched, so `load()` after
  // still shows the last good data rather than an empty/partial table.
  const [cacheMeta, setCacheMeta] = useState<{ cachedAt: string | null; lastError: string | null }>({ cachedAt: null, lastError: null })
  const [refreshingCache, setRefreshingCache] = useState(false)
  async function refreshCacheNow() {
    setRefreshingCache(true)
    try {
      const res = await fetch('/api/admin/refresh-restaurant-admin-list-cache', { method: 'POST' })
      const d = await res.json().catch(() => null)
      if (res.ok && d?.ok) {
        showToast(`Restaurant list refreshed: ${d.fetched} of ${d.totalElements} restaurants (${Math.round((d.durationMs || 0) / 1000)}s)`)
      } else {
        showToast(d?.error || 'Refresh failed — still showing the last good data')
      }
    } catch {
      showToast('Refresh failed — still showing the last good data')
    } finally {
      setRefreshingCache(false)
      load()
    }
  }

  useEffect(() => { load() }, [load])

  // Disco-native restaurants that have no FM record, so they can be merged
  // into the FM-sourced list below and never stay invisible. Named (not
  // inline) so a brand-new one can be picked up right after creation too —
  // AddRestaurantDialog's onCreated used to only call load() (the FM-cache
  // read), which can never surface a no-FM-record restaurant at all, so a
  // freshly created native restaurant stayed invisible until a full page
  // reload happened to re-run this same fetch on mount.
  const loadDiscoOrphans = useCallback(() => {
    return fetch('/api/admin/disco-native-orphans')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (Array.isArray(d?.orphans)) setDiscoOrphans(d.orphans.map((o: Restaurant) => ({ ...o, discoOnly: true }))) })
      .catch(() => {})
  }, [])

  useEffect(() => { loadDiscoOrphans() }, [loadDiscoOrphans])

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
    const held = effectiveMoneyFlow(r, overrideMap[r.reference]) === 'FAMILY_MEAL'
    const next = held ? 'DIRECT' : 'FAMILY_MEAL'
    setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, moneyFlow: next } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/money-flow?moneyFlow=${next}`, { method: 'PUT' })
    if (!res.ok) setRows(prev => prev.map(x => x._rowId === r._rowId ? { ...x, moneyFlow: held ? 'FAMILY_MEAL' : 'DIRECT' } : x))
    else showToast(`${r.businessName}: payments ${next === 'FAMILY_MEAL' ? 'held' : 'released'}`)
  }

  // Archive (Disco-native only) replaces the old hard delete: reversible via
  // Restore, no rows removed, order/payment history untouched. FM-backed
  // restaurants can't reach this — the button is disabled before it's ever
  // clicked (see the Actions cell below).
  async function archiveRestaurant(r: Restaurant) {
    if (!confirm(`Archive "${r.businessName}"? This removes it from the marketplace, admin lists, and portal login. It's fully reversible via Restore.`)) return
    let res = await fetch(`/api/admin/restaurants/${r.reference}`, { method: 'DELETE' })
    // Server safeguard: a restaurant with real order history requires a second,
    // explicit confirmation before it's archived.
    if (res.status === 409) {
      const d = await res.json().catch(() => null)
      if (d?.requiresConfirmation) {
        if (!confirm(`⚠️ "${r.businessName}" has ${d.orderCount} order(s) in its history. Archiving hides it from the marketplace, admin lists, and portal login — reversible via Restore.\n\nContinue?`)) return
        res = await fetch(`/api/admin/restaurants/${r.reference}?confirmArchiveWithOrders=${encodeURIComponent(r.reference)}`, { method: 'DELETE' })
      }
    }
    if (res.ok) {
      showToast(`${r.businessName} archived`)
      // Optimistic local patch instead of a full load(): the restaurant list
      // now reads a background-synced cache (up to 15 min stale), so a
      // reload here wouldn't show the archive the admin just performed.
      // archivedAt drives the Archived badge + Restore-button swap below —
      // patching it directly makes the change visible immediately regardless
      // of cache staleness. Same pattern as toggleNash/toggleShipday/toggleMoneyFlow.
      setOverrideMap(prev => ({
        ...prev,
        [r.reference]: { ...(prev[r.reference] || defaultOverrideMeta(true)), archivedAt: new Date().toISOString() },
      }))
    } else {
      const d = await res.json().catch(() => null)
      showToast(d?.error || 'Archive failed')
    }
  }

  async function restoreRestaurant(r: Restaurant) {
    if (!confirm(`Restore "${r.businessName}"? It reappears on the marketplace, admin lists, and portal login immediately. Its admin will need a fresh invite — the old one was revoked on archive.`)) return
    const res = await fetch(`/api/admin/restaurants/${r.reference}/restore`, { method: 'POST' })
    if (res.ok) {
      showToast(`${r.businessName} restored`)
      setOverrideMap(prev => ({
        ...prev,
        [r.reference]: { ...(prev[r.reference] || defaultOverrideMeta(true)), archivedAt: null },
      }))
    } else {
      const d = await res.json().catch(() => null)
      showToast(d?.error || 'Restore failed')
    }
  }

  // Permanent delete, step 1: fetch a live preview. Never assume eligibility
  // client-side — the server re-checks native/no-FM/order-count every time.
  async function requestPermanentDelete(r: Restaurant) {
    try {
      const res = await fetch(`/api/admin/restaurants/${r.reference}/permanent-delete`)
      const d = await res.json().catch(() => null)
      if (!res.ok || !d) { showToast('Could not check delete eligibility'); return }
      setDeletePreview({ r, ...d })
    } catch {
      showToast('Could not check delete eligibility')
    }
  }

  // Step 2: the actual irreversible delete, only reachable from the preview
  // modal below. Echoes back the exact rowCounts/orderCount just previewed —
  // the server refuses if anything changed in between.
  async function confirmPermanentDelete() {
    if (!deletePreview || !deletePreview.eligible) return
    setDeleteBusy(true)
    try {
      const res = await fetch(`/api/admin/restaurants/${deletePreview.r.reference}/permanent-delete`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmOrderCount: deletePreview.orderCount, confirmRowCounts: deletePreview.rowCounts }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok) { showToast(d?.error || 'Delete failed'); return }
      showToast(`${deletePreview.restaurantName || deletePreview.r.businessName} permanently deleted`)
      setDiscoOrphans(prev => prev.filter(o => o.reference !== deletePreview.r.reference))
      setDeletePreview(null)
    } catch {
      showToast('Delete failed')
    } finally {
      setDeleteBusy(false)
    }
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

  // Reissue a fresh set-password invite (new token, new 14-day window) for a
  // native restaurant whose original invite died unused, and email it.
  async function resendInvite(r: Restaurant) {
    if (!confirm(`Resend the set-password invite for ${r.businessName}?`)) return
    const res = await fetch(`/api/admin/restaurants/${r.reference}/resend-invite`, { method: 'POST' })
    const data = await res.json().catch(() => ({} as { error?: string; email?: string; emailed?: boolean }))
    if (!res.ok) { showToast(data?.error || 'Could not resend the invite'); return }
    if (data?.emailed === false) showToast(`New invite issued for ${data.email}, but the email could not be sent`)
    else showToast(`Invite resent to ${data?.email}`)
    // Optimistic patch instead of loadStripeMap()'s full re-fetch: a fresh
    // invite was just issued, so the "invite expired" badge is stale now
    // regardless of when the next background refresh happens.
    setOverrideMap(prev => {
      const cur = prev[r.reference]
      if (!cur) return prev
      return { ...prev, [r.reference]: { ...cur, inviteExpired: false } }
    })
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
  // Merge → filter (search, across BOTH sets) → sort (whole combined set) →
  // the caller slices for pagination. Search used to run FM-side only (an FM
  // orphan was never sent to FM at all, so it could never be excluded by a
  // query it didn't match); sort used to run on [...orphanRows, ...rows]
  // directly, which does re-sort correctly, but two things still broke it:
  // orphans had no adminName field at all (fixed at the merge boundary in
  // /api/admin/disco-native-orphans, not here — see that route), so every
  // orphan tied at '' on the Admin column and rode the stable-sort's
  // preserved-input-order artifact toward one end regardless of real data;
  // and nothing paginated the combined set — orphans were unconditionally
  // prepended to whatever one FM page happened to be loaded, so they
  // rendered on every page, not a real position in one.
  const visibleRows = useMemo(() => {
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
    // restaurantStatus (ACTIVE/INACTIVE/SUSPENDED/ARCHIVED) is an FM concept —
    // it never applied to Disco-only orphans even when this filter ran
    // server-side against FM directly, so it's applied only to the FM-backed
    // rows here, after computing fmRefs against the FULL unfiltered set (a
    // status-filtered dedup set could wrongly un-hide an orphan that happens
    // to share a reference with an FM row of a different status).
    const fmRowsFiltered = statusFilter ? rows.filter(r => r.restaurantStatus === statusFilter) : rows
    const combined = [...orphanRows, ...fmRowsFiltered]

    const q = search.trim().toLowerCase()
    const filtered = q
      ? combined.filter(r =>
          (r.businessName || '').toLowerCase().includes(q) ||
          adminNameOf(r).toLowerCase().includes(q) ||
          adminEmailOf(r).toLowerCase().includes(q),
        )
      : combined

    return filtered.sort((a, b) => {
      const va = val(a), vb = val(b)
      let cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), undefined, { sensitivity: 'base' })
      // Tie-break on restaurant name so a tie (e.g. every Disco-only row
      // sharing '' before the Admin-name fix, or any two real ties) doesn't
      // fall back to stable-sort's preserved-input-order — which always
      // favored orphans, since they're spliced in at the front above.
      if (cmp === 0) cmp = (a.businessName || '').localeCompare(b.businessName || '', undefined, { sensitivity: 'base' })
      return cmp * dir
    })
  }, [rows, discoOrphans, sortKey, sortDir, stripeMap, search, overrideMap, statusFilter])

  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize))
  const pageRows = useMemo(() => visibleRows.slice(page * pageSize, (page + 1) * pageSize), [visibleRows, page, pageSize])

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
        moneyFlow?: string | null
        menuDriftDetected?: boolean; menuDriftDetails?: OverrideMeta['menuDriftDetails']
        inviteExpired?: boolean; archivedAt?: string | null
      }[]) {
        sMap[o.restaurantReference] = { connected: !!o.stripeConnected, checkedAt: o.stripeCheckedAt, hasStripeAccount: !!o.hasStripeAccount }
        oMap[o.restaurantReference] = {
          visible: !!o.visible, isPremium: !!o.isPremium,
          orderUrl: o.orderUrl || '', menuUploadUrl: o.menuUploadUrl ?? null,
          isLive: !!o.isLive, isDiscoNative: !!o.isDiscoNative,
          onlineOrderingEnabled: o.onlineOrderingEnabled ?? null,
          moneyFlow: o.moneyFlow ?? null,
          menuDriftDetected: !!o.menuDriftDetected, menuDriftDetails: o.menuDriftDetails ?? [],
          inviteExpired: !!o.inviteExpired,
          archivedAt: o.archivedAt ?? null,
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
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Restaurants — Ordering</h1>
          {cacheMeta.cachedAt && (
            <div style={{ fontSize: 11, color: cacheMeta.lastError ? '#B45309' : '#999', marginTop: 2 }}>
              List last synced {new Date(cacheMeta.cachedAt).toLocaleString()}
              {cacheMeta.lastError ? ' — a more recent sync attempt failed; still showing this last good data' : ''}
            </div>
          )}
        </div>
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
          <button className="ord-btn" onClick={refreshCacheNow} disabled={refreshingCache}
            style={{ display: 'inline-flex', alignItems: 'center', background: '#fff', color: BLUE, border: `1.5px solid ${BLUE}`, borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, cursor: refreshingCache ? 'wait' : 'pointer', fontFamily: F, whiteSpace: 'nowrap', opacity: refreshingCache ? 0.6 : 1 }}>
            {refreshingCache ? 'Refreshing…' : 'Refresh List'}
            <i className="ti ti-info-circle" style={{ fontSize: 12, marginLeft: 4, opacity: 0.6 }} />
            <span className="ord-tip">Pull the latest restaurant list from FamilyMeal now, instead of waiting for the next automatic sync (every 15 min)</span>
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

      {incomplete && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: '#FFF4E5', color: '#8A5300', border: '1px solid #FFDDA8', padding: '12px 16px', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          <span>
            <strong>Incomplete results:</strong> showing {incomplete.loaded} of {incomplete.expected} restaurants
            {incomplete.failedPages > 0 ? ` — ${incomplete.failedPages} page${incomplete.failedPages === 1 ? '' : 's'} failed to load even after retry.` : '.'}
            {' '}Search, sort, and counts below do not reflect the full list — do not rely on this view being complete.
          </span>
          <button onClick={load} disabled={loading}
            style={{ background: '#8A5300', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: loading ? 'wait' : 'pointer', fontFamily: F, whiteSpace: 'nowrap', flexShrink: 0 }}>
            {loading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {/* Grow to fill the remaining viewport height (flex:1) and scroll the rows
          inside this container so the sticky header has a scrolling ancestor to
          pin against. minHeight:0 lets the flex child shrink so its own overflow
          scrolls instead of the page. */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto', flex: 1, minHeight: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 1630 }}>
          {/* Fixed column proportions: narrow toggle column, wide Restaurant + Admin
              (names/locations need room), everything else compact. Order matches the
              <thead> below. */}
          <colgroup>
            <col style={{ width: 76 }} />{/* Disco Cater Marketplace */}
            <col style={{ width: 320 }} />{/* Restaurant */}
            <col style={{ width: 210 }} />{/* Admin */}
            <col style={{ width: 190 }} />{/* Email */}
            <col style={{ width: 112 }} />{/* Registration Date */}
            <col style={{ width: 88 }} />{/* Checkout Page */}
            <col style={{ width: 116 }} />{/* Stripe */}
            <col style={{ width: 130 }} />{/* Online Ordering */}
            <col style={{ width: 92 }} />{/* Third-Party Allowed */}
            <col style={{ width: 92 }} />{/* Hold Payments */}
            <col style={{ width: 82 }} />{/* Shipday */}
            <col style={{ width: 132 }} />{/* Actions */}
          </colgroup>
          <thead>
            <tr>
              <th style={colHead} title="Show on Disco Cater map and marketplace">Map</th>
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
            {!loading && pageRows.map(r => {
              const adminName = r.adminName || `${r.admin?.firstName || ''} ${r.admin?.lastName || ''}`.trim()
              const adminEmail = r.adminEmail || r.admin?.email || ''
              // M4 drop-off guard (report-only): flag an FM-backed row that is
              // visible today but would silently vanish from the marketplace the
              // moment it flips to Disco-native (stricter 3-part rule). isStripeConnected
              // folds stripe_connected + a connected Disco account, matching the feed's
              // native Stripe branch closely enough for a warning.
              const ov = overrideMap[r.reference]
              const readiness = ov ? evaluateMarketplaceReadiness({
                isDiscoNative: ov.isDiscoNative,
                visible: ov.visible,
                stripeConnected: isStripeConnected(r),
                onlineOrderingEnabled: ov.onlineOrderingEnabled,
                hasCompletedNativeStripeAccount: false,
                isArchived: ov.archivedAt != null,
              }) : null
              const dropOff = readiness?.wouldDropOff ? readiness : null
              const drift = ov?.isDiscoNative && ov.menuDriftDetected ? ov.menuDriftDetails : null
              const inviteDead = ov?.isDiscoNative && ov.inviteExpired
              return (
                <tr key={r._rowId}>
                  {/* Disco Cater Marketplace: the single Disco-native map/marketplace
                      visibility toggle (disco_restaurant_overrides.visible). */}
                  <td style={cell}>
                    <Toggle checked={!!overrideMap[r.reference]?.visible} onChange={() => requestVisibleToggle(r)} color="#1D9E75" />
                  </td>
                  <td style={{ ...cell, fontWeight: 600, wordBreak: 'break-word' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {r.businessName}
                      {r.discoOnly ? (
                        <span
                          title={r.fmCreationFailed ? `FamilyMeal record creation failed: ${r.fmCreationError || 'unknown error'}` : 'Live in Disco with no FamilyMeal record'}
                          style={{ fontSize: 10, fontWeight: 600, color: '#B45309', background: '#FEF3C7', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}
                        >Disco-only · no FM record</span>
                      ) : overrideMap[r.reference]?.isDiscoNative ? (
                        <span style={{ fontSize: 10, fontWeight: 400, color: '#6B7280', background: '#F3F4F6', padding: '2px 6px', borderRadius: 4 }}>Disco</span>
                      ) : null}
                      {ov?.archivedAt && (
                        <span
                          title={`Archived ${new Date(ov.archivedAt).toLocaleDateString()} — hidden from the marketplace, admin lists, and portal login. Restore to reverse.`}
                          style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#E53935', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}
                        >Archived</span>
                      )}
                    </span>
                    {(r.address?.city || r.address?.state) && (
                      <div style={{ fontSize: 11, fontWeight: 400, color: '#999', marginTop: 2 }}>
                        {[r.address?.city, r.address?.state].filter(Boolean).join(', ')}
                      </div>
                    )}
                    {dropOff && (
                      <div
                        title={dropOff.blockers.map(b => `• ${b.message}`).join('\n')}
                        style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 5, marginTop: 5, maxWidth: 260, fontSize: 10.5, fontWeight: 600, lineHeight: 1.35, color: '#B45309', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 5, padding: '3px 7px' }}
                      >
                        <span style={{ flexShrink: 0 }}>⚠</span>
                        <span>
                          Would drop off the marketplace if switched to Disco-native
                          <span style={{ display: 'block', fontWeight: 400, marginTop: 1 }}>
                            {dropOff.blockers[0]?.code === 'online-ordering-off' ? 'Online ordering is off — enable it first.'
                              : dropOff.blockers[0]?.code === 'stripe-not-connected' ? 'Stripe not connected for a native account.'
                              : 'Marketplace visibility is off.'}
                          </span>
                        </span>
                      </div>
                    )}
                    {inviteDead && (
                      <div
                        title="The admin's set-password invite expired before anyone accepted it — nobody can log in yet. Use Resend invite (⋯ menu)."
                        style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 5, marginTop: 5, maxWidth: 260, fontSize: 10.5, fontWeight: 600, lineHeight: 1.35, color: '#B45309', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 5, padding: '3px 7px' }}
                      >
                        <span style={{ flexShrink: 0 }}>⚠</span>
                        <span>
                          Admin invite expired, unused
                          <span style={{ display: 'block', fontWeight: 400, marginTop: 1 }}>
                            Nobody has logged in — resend from the ⋯ menu.
                          </span>
                        </span>
                      </div>
                    )}
                    {drift && (
                      <div
                        title={drift.map(d => {
                          if (d.type === 'price_changed') return `• ${d.name}: price $${d.before} → $${d.after} on FM`
                          if (d.type === 'category_changed') return `• ${d.name}: category "${d.before}" → "${d.after}" on FM`
                          if (d.type === 'renamed') return `• renamed "${d.before}" → "${d.after}" on FM`
                          if (d.type === 'added') return `• "${d.name}" added on FM — not in the native menu`
                          return `• "${d.name}" removed on FM — still in the native menu`
                        }).join('\n')}
                        style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 5, marginTop: 5, maxWidth: 260, fontSize: 10.5, fontWeight: 600, lineHeight: 1.35, color: '#B45309', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 5, padding: '3px 7px' }}
                      >
                        <span style={{ flexShrink: 0 }}>⚠</span>
                        <span>
                          FM menu changed since import
                          <span style={{ display: 'block', fontWeight: 400, marginTop: 1 }}>
                            {drift.length} item{drift.length === 1 ? '' : 's'} differ from the native menu — hover for details
                          </span>
                        </span>
                      </div>
                    )}
                  </td>
                  <td style={{ ...cell, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={adminName || undefined}>{adminName || '—'}</td>
                  <td style={{ ...cell, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={adminEmail || undefined}>{adminEmail}</td>
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
                  <td style={cell}><Toggle checked={effectiveMoneyFlow(r, ov) === 'FAMILY_MEAL'} onChange={() => toggleMoneyFlow(r)} color="#EFB84A" /></td>
                  <td style={cell}><Toggle checked={!!r.shipdayEnabled} onChange={() => toggleShipday(r)} /></td>
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap', position: 'sticky', right: 0, zIndex: 1, minWidth: 120, background: '#fff', borderLeft: '1px solid #f0f0f0' }}>
                    <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <button title="Refresh" onClick={() => load()} style={iconBtn}>⟳</button>
                      <button title="Edit restaurant" onClick={() => setEditRef(r.reference)} style={{ ...iconBtn, color: '#6B6EF9', fontWeight: 700 }}>Edit</button>
                      {/* TEXT labels, not bare glyphs. These were a 🗄 / ↺ emoji
                          pair with the action only in the title attribute, sitting
                          immediately beside the text-labelled "Edit" button — the
                          archive action was effectively undiscoverable (reported as
                          "there is no way to archive a restaurant" by someone who
                          had already used it once). Matching Edit's existing
                          treatment rather than inventing a new control: same
                          iconBtn chrome, same weight, colour carrying the meaning. */}
                      {ov?.archivedAt ? (
                        <button title="Restore this restaurant — it reappears on the marketplace, admin lists, and portal login." onClick={() => restoreRestaurant(r)} style={{ ...iconBtn, color: '#1D9E75', fontWeight: 700 }}>Restore</button>
                      ) : ov?.isDiscoNative ? (
                        <button title="Archive (reversible) — hides it from the marketplace, admin lists, and portal login, and stops it accepting online orders." onClick={() => archiveRestaurant(r)} style={{ ...iconBtn, color: '#E53935', fontWeight: 700 }}>Archive</button>
                      ) : (
                        <button
                          title="Archiving isn't available yet for FamilyMeal-backed restaurants — FM's block endpoint has never been confirmed to actually stop its own checkout, so this is deferred pending verification."
                          disabled
                          style={{ ...iconBtn, color: '#ccc', cursor: 'not-allowed' }}
                        >Archive</button>
                      )}
                      {/* Permanent delete — test restaurants/duplicates only.
                          Deliberately far more visually alarming than Archive
                          (solid red fill vs. Archive's red-on-white icon) —
                          the two sit right next to each other and one is
                          reversible, one is not. Only ever shown for
                          Disco-native rows with no FM record (discoOnly) —
                          the only population this can work for durably. */}
                      {r.discoOnly && (
                        <button title="Permanently delete (cannot be undone)" onClick={() => requestPermanentDelete(r)}
                          style={{ ...iconBtn, background: '#E53935', color: '#fff', border: '1px solid #E53935' }}>🗑</button>
                      )}
                      <Kebab
                        menuUrl={overrideMap[r.reference]?.menuUploadUrl || null}
                        showResendInvite={!!overrideMap[r.reference]?.isDiscoNative}
                        onResetPassword={() => resetPassword(r)}
                        onResendInvite={() => resendInvite(r)}
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
        <div style={{ fontSize: 12, color: '#666' }}>{visibleRows.length} restaurant{visibleRows.length === 1 ? '' : 's'}</div>
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
          onCreated={() => { setAddOpen(false); showToast('Restaurant created'); setPage(0); load(); loadDiscoOrphans() }}
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

      {/* Permanent-delete preview/confirm modal — deliberately styled nothing
          like the other confirm modals above (solid red header bar, warning
          icon, an explicit "cannot be undone" line) so it reads as
          categorically more serious than Archive's plain window.confirm(). */}
      {deletePreview && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,15,40,0.55)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>
          <div style={{ background: '#fff', borderRadius: 14, maxWidth: 520, width: '92%', boxShadow: '0 12px 40px rgba(0,0,0,0.25)', overflow: 'hidden' }}>
            <div style={{ background: '#E53935', color: '#fff', padding: '16px 22px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              <span style={{ fontSize: 16, fontWeight: 700 }}>Permanently delete restaurant</span>
            </div>
            <div style={{ padding: '20px 22px' }}>
              {!deletePreview.eligible ? (
                <>
                  <p style={{ fontSize: 13.5, color: '#333', lineHeight: 1.55, margin: '0 0 8px' }}>
                    <strong>{deletePreview.restaurantName || deletePreview.r.businessName}</strong> can&apos;t be permanently deleted:
                  </p>
                  <div style={{ background: '#FFF3F3', border: '1px solid #FFCDD2', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#C62828', lineHeight: 1.5 }}>
                    {deletePreview.reason}
                  </div>
                </>
              ) : (
                <>
                  <p style={{ fontSize: 13.5, color: '#333', lineHeight: 1.55, margin: '0 0 14px' }}>
                    This permanently erases <strong>{deletePreview.restaurantName || deletePreview.r.businessName}</strong> from Neon —
                    every menu item, modifier, override, login, and setting. <strong>This cannot be undone</strong> (unlike Archive).
                  </p>
                  {deletePreview.order && (
                    <div style={{ background: '#FFF8E1', border: '1px solid #FFE082', borderRadius: 8, padding: '12px 14px', marginBottom: 14, fontSize: 13, color: '#7A5C00' }}>
                      <strong>This restaurant has 1 order — review before deleting:</strong>
                      <div style={{ marginTop: 6, lineHeight: 1.6 }}>
                        Total: <strong>${deletePreview.order.total?.toFixed(2) ?? '—'}</strong> · Status: <strong>{deletePreview.order.status || '—'}</strong><br />
                        Customer: <strong>{deletePreview.order.customerName || deletePreview.order.customerEmail || '—'}</strong><br />
                        Date: <strong>{deletePreview.order.placedAt ? new Date(deletePreview.order.placedAt).toLocaleString() : '—'}</strong>
                      </div>
                    </div>
                  )}
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#666', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Rows to be deleted</div>
                  <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #eee', borderRadius: 8, padding: '8px 12px', marginBottom: 18 }}>
                    {Object.entries(deletePreview.rowCounts).filter(([, n]) => n > 0).length === 0 ? (
                      <div style={{ fontSize: 12.5, color: '#999' }}>No related rows found.</div>
                    ) : (
                      Object.entries(deletePreview.rowCounts).filter(([, n]) => n > 0).map(([table, n]) => (
                        <div key={table} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: '#444', padding: '3px 0' }}>
                          <span style={{ fontFamily: 'monospace' }}>{table}</span><span>{n}</span>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => setDeletePreview(null)} disabled={deleteBusy}
                  style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: deleteBusy ? 'default' : 'pointer', fontFamily: F, color: '#555' }}>
                  {deletePreview.eligible ? 'Cancel' : 'Close'}
                </button>
                {deletePreview.eligible && (
                  <button onClick={confirmPermanentDelete} disabled={deleteBusy}
                    style={{ background: '#E53935', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: deleteBusy ? 'wait' : 'pointer', fontFamily: F, opacity: deleteBusy ? 0.7 : 1 }}>
                    {deleteBusy ? 'Deleting…' : 'Permanently Delete'}
                  </button>
                )}
              </div>
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

function Kebab({ menuUrl, showResendInvite, onResetPassword, onResendInvite, onTransferSystemAdmin }: { menuUrl: string | null; showResendInvite: boolean; onResetPassword: () => void; onResendInvite: () => void; onTransferSystemAdmin: () => void }) {
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
          {showResendInvite && (
            <button onClick={() => { setOpen(false); onResendInvite() }} style={{ ...itemStyle, borderTop: '1px solid #f0f0f0' }}>
              Resend invite
            </button>
          )}
          <button onClick={() => { setOpen(false); onTransferSystemAdmin() }} style={{ ...itemStyle, borderTop: '1px solid #f0f0f0' }}>
            Transfer to System Admin
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}

// Density-tuned: headers wrap (whiteSpace normal) so narrow columns can stay narrow
// without their labels forcing extra width; tighter padding fits more rows.
const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '8px 12px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0', whiteSpace: 'normal', lineHeight: 1.25, position: 'sticky', top: 0, zIndex: 2 }
// Tighter vertical padding + slightly smaller font → noticeably more rows on screen
// while staying legible; toggles/buttons keep their own (larger) tap sizing.
const cell: React.CSSProperties = { padding: '7px 12px', fontSize: 12.5, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const selectSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const iconBtn: React.CSSProperties = { background: '#f5f5f8', border: '1px solid #e8e8ee', borderRadius: 6, padding: '4px 8px', fontSize: 13, cursor: 'pointer', color: '#555', fontFamily: F, lineHeight: 1 }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
