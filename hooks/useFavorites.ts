'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

// Per-user storage key prefix. The trailing segment is the FM user
// reference (UUID) when signed in, falling back to email, or "guest"
// for unauthenticated browsers. Pre-Aug-2025 this was a single shared
// "disco_favorites" key — readLegacyLocal() migrates that into the
// guest bucket once, so existing favorites aren't lost on upgrade.
const STORAGE_KEY_PREFIX = 'disco_favorites_'
const LEGACY_STORAGE_KEY = 'disco_favorites'
const AUTH_STORAGE_KEY = 'disco_user'

export interface FavoriteRestaurant {
  // Primary key — always present. Prefer FM reference (UUID), fall back
  // to Sanity slug. Used to dedupe + key the toggle.
  key: string
  // Optional metadata that lets the favorites page render a card without
  // re-fetching anything.
  reference?: string
  slug?: string
  name?: string
  image?: string
  cuisine?: string
  city?: string
  state?: string
  location?: string
}

interface FavoritesState {
  loading: boolean
  error: boolean
  source: 'api' | 'local'
  favorites: FavoriteRestaurant[]
  isFavorited: (key: string) => boolean
  toggleFavorite: (r: FavoriteRestaurant) => Promise<void>
  refresh: () => Promise<void>
}

interface StoredUser {
  reference?: string
  email?: string
}

// Cached scope from the cookie-auth path. Populated by resolveScopeFromCookie()
// on first hook mount, then re-read by all subsequent mounts so we don't
// re-hit /api/fm-user on every page change.
const CACHED_AUTH_SCOPE_KEY = 'disco_favorites_scope'

function readUserScope(): string {
  if (typeof window === 'undefined') return 'guest'
  try {
    // Legacy localStorage-based auth (fullmap header, restaurant/admin).
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY)
    if (raw) {
      const u = JSON.parse(raw) as StoredUser
      const k = u?.reference || u?.email
      if (k) return k
    }
    // Cookie-based auth (AuthContext) — resolved server-side, cached here.
    const cached = window.localStorage.getItem(CACHED_AUTH_SCOPE_KEY)
    if (cached) return cached
  } catch {}
  return 'guest'
}

// Freshness marker for CACHED_AUTH_SCOPE_KEY. Without this the cache could only
// answer "what scope" and never "is it still true", so every mount re-hit
// /api/fm-user to confirm — N restaurant cards meant N identical calls.
const CACHED_AUTH_SCOPE_TS_KEY = 'disco_favorites_scope_ts'
const SCOPE_TTL_MS = 5 * 60 * 1000

// ── SHARED REQUEST LAYER ──────────────────────────────────────────────────────
// Every hook instance shares these module-level slots, so a page that mounts 40
// FavoriteHeart components issues ONE /api/customer/favorites and (at most) ONE
// /api/fm-user instead of 40 of each. Two mechanisms, both needed:
//   • in-flight promise — collapses the simultaneous mount storm
//   • short TTL cache   — collapses staggered mounts (lazy grids, route changes)
// Mutations (toggle, login/logout) pass force:true to bypass both.
const FAVORITES_TTL_MS = 30 * 1000

interface SharedSlot<T> {
  promise: Promise<T> | null
  value: T | null
  ts: number
}

// { ok } mirrors res.ok so callers keep the original "HTTP failure vs network
// failure vs logged-out" distinctions the un-deduped code got straight from fetch.
interface FavoritesResult { ok: boolean; data: any }

const favoritesSlot: SharedSlot<FavoritesResult> = { promise: null, value: null, ts: 0 }
const scopeSlot: SharedSlot<string | null> = { promise: null, value: null, ts: 0 }

function readCachedScope(): { scope: string; fresh: boolean } | null {
  if (typeof window === 'undefined') return null
  try {
    const cached = window.localStorage.getItem(CACHED_AUTH_SCOPE_KEY)
    if (!cached) return null
    const ts = Number(window.localStorage.getItem(CACHED_AUTH_SCOPE_TS_KEY) || 0)
    return { scope: cached, fresh: Date.now() - ts < SCOPE_TTL_MS }
  } catch { return null }
}

function writeCachedScope(scope: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CACHED_AUTH_SCOPE_KEY, scope)
    window.localStorage.setItem(CACHED_AUTH_SCOPE_TS_KEY, String(Date.now()))
  } catch {}
}

function clearCachedScope() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(CACHED_AUTH_SCOPE_KEY)
    window.localStorage.removeItem(CACHED_AUTH_SCOPE_TS_KEY)
  } catch {}
}

// Invalidate everything shared. Called on any auth transition so a new user
// never reads the previous user's cached response. Debounced because the auth
// events fire once PER hook instance — without the window, instance 2's bust
// would cancel instance 1's in-flight request and we'd be back to N fetches.
let lastBust = 0
function bustShared() {
  if (Date.now() - lastBust < 250) return
  lastBust = Date.now()
  favoritesSlot.promise = null; favoritesSlot.value = null; favoritesSlot.ts = 0
  scopeSlot.promise = null; scopeSlot.value = null; scopeSlot.ts = 0
  syncedUploads.clear()
}

// A local mutation makes any cached server response stale — drop it so the next
// refresh re-reads, instead of a later mount reverting the optimistic toggle.
function invalidateFavoritesCache() {
  favoritesSlot.value = null; favoritesSlot.ts = 0
}

// GET /api/customer/favorites, deduped. Rejects only on a genuine network
// error — an HTTP failure resolves with ok:false, as the raw fetch did.
function fetchFavoritesShared(force = false): Promise<FavoritesResult> {
  if (typeof window === 'undefined') return Promise.resolve({ ok: false, data: null })
  if (!force) {
    if (favoritesSlot.promise) return favoritesSlot.promise
    if (favoritesSlot.value !== null && Date.now() - favoritesSlot.ts < FAVORITES_TTL_MS) {
      return Promise.resolve(favoritesSlot.value)
    }
  }
  const p = fetch('/api/customer/favorites', { credentials: 'include' })
    .then(async res => {
      const result: FavoritesResult = {
        ok: res.ok,
        data: res.ok ? await res.json().catch(() => null) : null,
      }
      favoritesSlot.value = result
      favoritesSlot.ts = Date.now()
      // The favorites response already identifies the account, so an
      // authenticated user never needs the /api/fm-user round-trip at all.
      if (result.data?.authenticated && result.data?.email) writeCachedScope(String(result.data.email))
      return result
    })
    .finally(() => { if (favoritesSlot.promise === p) favoritesSlot.promise = null })
  favoritesSlot.promise = p
  return p
}

// Resolve the cookie-auth scope. Skips the network entirely when the cached
// scope is still fresh; otherwise dedupes concurrent callers onto one request.
async function resolveScopeFromCookie(): Promise<string | null> {
  if (typeof window === 'undefined') return null
  const cached = readCachedScope()
  if (cached?.fresh) return cached.scope
  if (scopeSlot.promise) return scopeSlot.promise
  if (scopeSlot.value !== null && Date.now() - scopeSlot.ts < SCOPE_TTL_MS) return scopeSlot.value

  // NOTE: everything below must live inside `p`, which is assigned to
  // scopeSlot.promise with NO await in between. Awaiting before the slot is
  // populated lets all N callers suspend past the dedup check above and each
  // start its own request — which is the exact fan-out this is here to stop.
  const p = (async () => {
    // A favorites request may already be in flight, and its response identifies
    // the account — ride on it rather than racing a redundant /api/fm-user.
    // This is what takes fm-user to ZERO calls for a signed-in user.
    if (favoritesSlot.promise) {
      try {
        const { data } = await favoritesSlot.promise
        if (data?.authenticated && data?.email) return String(data.email)
      } catch {}
    }
    try {
      const res = await fetch('/api/fm-user', { credentials: 'include' })
      if (!res.ok) {
        // Clear stale cache so a logged-out user isn't pinned to the
        // previous user's bucket.
        clearCachedScope()
        return null
      }
      const data = await res.json()
      const k: string | undefined = data?.reference || data?.email
      if (!k) return null
      writeCachedScope(k)
      return k
    } catch { return null }
  })()
    .then(v => { scopeSlot.value = v; scopeSlot.ts = Date.now(); return v })
    .finally(() => { if (scopeSlot.promise === p) scopeSlot.promise = null })
  scopeSlot.promise = p
  return p
}

// Guards the local→server write-back so N hook instances processing the SAME
// shared response don't each POST the same uploads. Keyed by scope + refs, so a
// genuinely new local favorite added later still syncs.
const syncedUploads = new Set<string>()
function claimUpload(scope: string, refs: string[]): boolean {
  const key = `${scope}|${[...refs].sort().join(',')}`
  if (syncedUploads.has(key)) return false
  syncedUploads.add(key)
  return true
}

function storageKey(scope: string): string {
  return `${STORAGE_KEY_PREFIX}${scope}`
}

function readLocal(scope: string): FavoriteRestaurant[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(storageKey(scope))
    if (raw) {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    }
    // One-time migration of the legacy un-scoped list into the guest
    // bucket. We don't migrate it into a signed-in user's bucket
    // because we can't know which historical user it belonged to.
    if (scope === 'guest') {
      const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY)
      if (legacy) {
        const parsed = JSON.parse(legacy)
        if (Array.isArray(parsed) && parsed.length > 0) {
          window.localStorage.setItem(storageKey('guest'), legacy)
          window.localStorage.removeItem(LEGACY_STORAGE_KEY)
          return parsed
        }
      }
    }
    return []
  } catch { return [] }
}

function writeLocal(scope: string, favs: FavoriteRestaurant[]) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(storageKey(scope), JSON.stringify(favs)) } catch {}
}

// Per-scope "last refreshed" timestamp marker (also cleared on logout).
const TS_PREFIX = 'disco_favorites_ts_'
function writeTs(scope: string) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(`${TS_PREFIX}${scope}`, String(Date.now())) } catch {}
}

// Broadcast changes across hook instances on the same page (e.g. heart on
// fullmap card + heart in OrderDetailPanel + favorites page grid). Uses a
// custom event so we don't fight the 'storage' event's same-tab gap.
const EVENT_NAME = 'disco-favorites-changed'
function broadcast(favs: FavoriteRestaurant[]) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: favs }))
}

export function useFavorites(): FavoritesState {
  const [favorites, setFavorites] = useState<FavoriteRestaurant[]>([])
  const [loading, setLoading] = useState(true)
  // True only when a network refresh genuinely failed (so the UI can show a
  // retry state). The legitimate guest/local fallback path does NOT set this.
  const [error, setError] = useState(false)
  const [source, setSource] = useState<'api' | 'local'>('local')
  const [userScope, setUserScope] = useState<string>('guest')
  // Latest scope, readable inside the stable refresh() without making refresh
  // depend on userScope (which caused a second /api/fm-favorites fetch — and a
  // loading flash — every time the cookie scope resolved after mount).
  const userScopeRef = useRef('guest')
  useEffect(() => { userScopeRef.current = userScope }, [userScope])

  // Network refresh against the Neon-backed favorites API. `background` skips the
  // loading flag so the cache-first paint stays on screen while we reconcile.
  //
  // Logged in → server membership is AUTHORITATIVE (so a delete on another device
  // propagates here). Pre-login favorites in the guest bucket are merged up to the
  // server ONCE, then the guest bucket is cleared so they can't resurrect a
  // server-side delete. Local metadata is reused to render server refs.
  const refresh = useCallback(async (opts?: { background?: boolean; force?: boolean }) => {
    if (!opts?.background) setLoading(true)
    setError(false)
    const localScope = readUserScope()
    let netFailed = false
    try {
      // Shared/deduped — the mount storm collapses into one request.
      const res = await fetchFavoritesShared(opts?.force)
      if (!res.ok) netFailed = true
      if (res.ok) {
        const data = res.data
        if (data?.authenticated && data?.email) {
          const scope = String(data.email)
          setUserScope(scope)
          userScopeRef.current = scope
          // The API now returns ENRICHED favorite objects ({reference,name,image,
          // slug,cuisine,location,...}). Stay backward-compatible with the old
          // bare-string shape. serverMeta holds the cache-enriched display fields
          // so a favorite renders correctly even if it was never viewed on this
          // device (the old "Restaurant" + 🪩 placeholder bug).
          const rawServer: unknown[] = Array.isArray(data.favorites) ? data.favorites : []
          const serverMeta = new Map<string, FavoriteRestaurant>()
          const serverRefs: string[] = []
          for (const item of rawServer) {
            if (typeof item === 'string') {
              if (item) serverRefs.push(item)
              continue
            }
            const o = item as Partial<FavoriteRestaurant>
            const ref = String(o.reference || o.key || '')
            if (!ref) continue
            serverRefs.push(ref)
            // Keep only the fields the cache actually provided (truthy) so this
            // never blanks out a richer local value when spread.
            const meta: FavoriteRestaurant = { key: ref, reference: ref }
            if (o.name) meta.name = o.name
            if (o.image) meta.image = o.image
            if (o.slug) meta.slug = o.slug
            if (o.cuisine) meta.cuisine = o.cuisine
            if (o.location) meta.location = o.location
            if (o.city) meta.city = o.city
            if (o.state) meta.state = o.state
            serverMeta.set(ref, meta)
          }
          const serverSet = new Set(serverRefs)

          const guestFavs = readLocal('guest')
          const scopedFavs = readLocal(scope)

          // ── EMPTY-SERVER GUARD ──────────────────────────────────────────────
          // The server has NO favorites for this account. NEVER let that wipe a
          // populated local cache (the flash-then-disappear bug) — that only ever
          // means the local list hasn't been synced up yet. Keep the local
          // favorites on screen and push them to the server so it catches up.
          if (serverRefs.length === 0) {
            const localFavs: FavoriteRestaurant[] = []
            const seenLocal = new Set<string>()
            for (const f of [...scopedFavs, ...guestFavs]) {
              if (f.key && !seenLocal.has(f.key)) { localFavs.push(f); seenLocal.add(f.key) }
            }
            setSource('api')
            setError(false)
            setLoading(false)
            if (localFavs.length > 0) {
              setFavorites(localFavs)
              writeLocal(scope, localFavs)
              writeTs(scope)
              // Background sync local → server so cross-device picks them up.
              // claimUpload() ensures only the first hook instance to process
              // this shared response actually POSTs.
              const refs = localFavs.map(f => f.reference || f.key).filter(Boolean) as string[]
              if (claimUpload(scope, refs)) {
                for (const ref of refs) {
                  fetch('/api/customer/favorites', {
                    method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ restaurant_reference: ref }),
                  }).catch(() => {})
                }
                if (guestFavs.length) writeLocal('guest', []) // merged up to the user scope
              }
            } else {
              // Genuinely empty everywhere — safe to show the empty state.
              setFavorites([])
              writeTs(scope)
            }
            return
          }
          // ────────────────────────────────────────────────────────────────────

          // Server has ≥1 favorite → it's authoritative. Pre-login adds (guest
          // bucket) not yet on the server are uploaded once.
          const guestOnly = guestFavs.filter(f => { const ref = f.reference || f.key; return ref && !serverSet.has(ref) })

          // Display metadata for server refs comes from the user cache + guest bucket.
          const byKey = new Map<string, FavoriteRestaurant>()
          for (const f of [...scopedFavs, ...guestFavs]) {
            if (f.key) byKey.set(f.key, f)
            if (f.reference) byKey.set(f.reference, f)
          }
          const merged: FavoriteRestaurant[] = []
          const seen = new Set<string>()
          for (const ref of serverRefs) {
            const local = byKey.get(ref)
            const server = serverMeta.get(ref)
            // Server (cache-enriched) metadata wins; local fills any gaps.
            const fav: FavoriteRestaurant = { ...(local || {}), ...(server || {}), key: ref, reference: ref }
            if (!seen.has(fav.key)) { merged.push(fav); seen.add(fav.key) }
          }
          for (const f of guestOnly) { if (!seen.has(f.key)) { merged.push(f); seen.add(f.key) } }

          setFavorites(merged)
          setSource('api')
          setError(false)
          setLoading(false)
          writeLocal(scope, merged)
          writeTs(scope)

          if (guestOnly.length) {
            const refs = guestOnly.map(f => f.reference || f.key).filter(Boolean) as string[]
            if (claimUpload(scope, refs)) {
              for (const ref of refs) {
                fetch('/api/customer/favorites', {
                  method: 'POST', credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ restaurant_reference: ref }),
                }).catch(() => {})
              }
              writeLocal('guest', []) // merged up — don't let them resurrect a delete
            }
          }
          return
        }
      }
    } catch {
      // network — fall through to local
      netFailed = true
    }
    // Not authenticated → localStorage only (guest / logged-out).
    let scope = localScope
    if (scope === 'guest') {
      const cookieScope = await resolveScopeFromCookie()
      if (cookieScope) scope = cookieScope
    }
    setUserScope(scope)
    userScopeRef.current = scope
    const localFavs = readLocal(scope)
    // Never let a background reconcile or a failed request flip a populated list
    // to empty. An explicit (non-background, non-error) refresh — e.g. logout —
    // still clears, since that's an intentional transition.
    setFavorites(prev =>
      (localFavs.length === 0 && prev.length > 0 && (opts?.background || netFailed)) ? prev : localFavs
    )
    setSource('local')
    // Only flag an error when the network actually failed (not the legitimate
    // guest/logged-out local path). The UI only surfaces it when there's also
    // no cached data to show.
    setError(netFailed)
    setLoading(false)
    writeTs(scope)
  }, [])

  // Remove every favorites-related localStorage key (used on logout).
  function clearAllLocalFavorites() {
    if (typeof window === 'undefined') return
    try {
      const toRemove: string[] = []
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i)
        if (k && (k.startsWith(STORAGE_KEY_PREFIX) || k.startsWith(TS_PREFIX) || k === CACHED_AUTH_SCOPE_KEY || k === LEGACY_STORAGE_KEY)) toRemove.push(k)
      }
      toRemove.forEach(k => window.localStorage.removeItem(k))
    } catch {}
    bustShared() // don't let the shared slots re-seed the cleared buckets
  }

  // Initial load — paint INSTANTLY from localStorage (no network on the critical
  // path), then reconcile in the background only when the cache is empty or stale
  // (>1h). Previously every mount awaited /api/fm-favorites (a guaranteed 501) and
  // sometimes /api/fm-user before showing anything — that was the slow load.
  useEffect(() => {
    const scope = readUserScope()
    setUserScope(scope)
    userScopeRef.current = scope
    const cached = readLocal(scope)
    setFavorites(cached)
    setSource('local')
    setLoading(false)
    // Always reconcile with the server in the background so a logged-in customer's
    // favorites stay in sync across devices (the cache-first paint above keeps it
    // instant). For logged-out guests this just confirms the local list.
    refresh({ background: true })
  }, [refresh])

  // Local fallback only: when the scope changes (login/logout) re-read the right
  // bucket without an API call or a loading flash. API mode is scoped by JWT, so
  // it needs no per-scope re-read.
  useEffect(() => {
    if (source === 'local') setFavorites(readLocal(userScope))
  }, [userScope, source])

  // Resolve scope on mount + whenever the auth payload changes. Pure scope
  // resolution (mount) does NOT re-fetch the API (avoids the double fetch +
  // loading flash); explicit login/logout events DO re-fetch.
  useEffect(() => {
    setUserScope(readUserScope())
    // Async-confirm against the cookie auth so AuthContext users (no
    // localStorage shadow) still get scoped favorites.
    let cancelled = false
    resolveScopeFromCookie().then(s => {
      if (cancelled) return
      if (s) setUserScope(s)
      else setUserScope(readUserScope())
    })
    function onStorage(e: StorageEvent) {
      if (e.key === AUTH_STORAGE_KEY || e.key === CACHED_AUTH_SCOPE_KEY) {
        bustShared() // cross-tab login/logout — the cached response is another user's
        setUserScope(readUserScope())
        refresh() // re-fetch the right user's list (deduped across instances)
      }
    }
    function onAuthChange() {
      // A 'disco-user-changed' event is an auth transition. Check the Neon
      // favorites endpoint: authenticated → reconcile; not authenticated (logout)
      // → clear localStorage favorites and reset to an empty guest state.
      // Fires once per hook instance, so both the bust and the fetch dedupe.
      bustShared()
      fetchFavoritesShared()
        .then(({ ok, data }) => {
          const d = ok ? data : null
          if (d?.authenticated) { refresh() }
          else {
            clearAllLocalFavorites()
            setFavorites([])
            setSource('local')
            setUserScope('guest')
            userScopeRef.current = 'guest'
          }
        })
        .catch(() => refresh())
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('disco-user-changed', onAuthChange as EventListener)
    return () => {
      cancelled = true
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('disco-user-changed', onAuthChange as EventListener)
    }
  }, [refresh])

  // Listen for cross-component favorite updates on this page
  useEffect(() => {
    function onChange(e: Event) {
      const detail = (e as CustomEvent).detail as FavoriteRestaurant[] | undefined
      if (Array.isArray(detail)) setFavorites(detail)
    }
    window.addEventListener(EVENT_NAME, onChange as EventListener)
    return () => window.removeEventListener(EVENT_NAME, onChange as EventListener)
  }, [])

  const isFavorited = useCallback((key: string) => {
    if (!key) return false
    return favorites.some(f => f.key === key || f.reference === key || f.slug === key)
  }, [favorites])

  const toggleFavorite = useCallback(async (r: FavoriteRestaurant) => {
    if (!r.key) return
    const wasFavorited = favorites.some(f => f.key === r.key)
    const next = wasFavorited
      ? favorites.filter(f => f.key !== r.key)
      : [...favorites, r]

    // Optimistic update everywhere (write the cache in both modes).
    setFavorites(next)
    writeLocal(userScope, next)
    broadcast(next)
    // The shared server response no longer reflects reality — drop it so a
    // component mounting inside the TTL window can't revert this toggle.
    invalidateFavoritesCache()

    // Logged-in (api) → persist to Neon in the background. On failure, reconcile.
    if (source === 'api') {
      const ref = r.reference || r.key
      if (ref) {
        const p = wasFavorited
          ? fetch(`/api/customer/favorites/${encodeURIComponent(ref)}`, { method: 'DELETE', credentials: 'include' })
          : fetch('/api/customer/favorites', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ restaurant_reference: ref }),
            })
        // force: the write just failed, so we need the true server state — not
        // whatever the shared cache last saw.
        p.then(res => { if (!res.ok) refresh({ background: true, force: true }) }).catch(() => {})
      }
    }
  }, [favorites, source, userScope, refresh])

  return { favorites, loading, error, source, isFavorited, toggleFavorite, refresh }
}

// Convenience: derive a stable key for a restaurant from common shapes
// (Sanity record, FM order detail, fullmap card item).
export function favoriteKey(r: { reference?: string; slug?: string | { current?: string }; _id?: string }): string {
  if (r.reference) return r.reference
  const slug = typeof r.slug === 'string' ? r.slug : r.slug?.current
  if (slug) return slug
  return r._id || ''
}
