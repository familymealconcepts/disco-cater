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

async function resolveScopeFromCookie(): Promise<string | null> {
  if (typeof window === 'undefined') return null
  try {
    const res = await fetch('/api/fm-user', { credentials: 'include' })
    if (!res.ok) {
      // Clear stale cache so a logged-out user isn't pinned to the
      // previous user's bucket.
      try { window.localStorage.removeItem(CACHED_AUTH_SCOPE_KEY) } catch {}
      return null
    }
    const data = await res.json()
    const k: string | undefined = data?.reference || data?.email
    if (!k) return null
    try { window.localStorage.setItem(CACHED_AUTH_SCOPE_KEY, k) } catch {}
    return k
  } catch { return null }
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
  const refresh = useCallback(async (opts?: { background?: boolean }) => {
    if (!opts?.background) setLoading(true)
    setError(false)
    const localScope = readUserScope()
    let netFailed = false
    try {
      const res = await fetch('/api/customer/favorites', { credentials: 'include' })
      if (!res.ok) netFailed = true
      if (res.ok) {
        const data = await res.json()
        if (data?.authenticated && data?.email) {
          const scope = String(data.email)
          setUserScope(scope)
          userScopeRef.current = scope
          const serverRefs: string[] = Array.isArray(data.favorites) ? data.favorites : []
          const serverSet = new Set(serverRefs)

          // Pre-login adds (guest bucket) not yet on the server → upload once.
          const guestFavs = readLocal('guest')
          const guestOnly = guestFavs.filter(f => { const ref = f.reference || f.key; return ref && !serverSet.has(ref) })

          // Display metadata for server refs comes from the user cache + guest bucket.
          const byKey = new Map<string, FavoriteRestaurant>()
          for (const f of [...readLocal(scope), ...guestFavs]) {
            if (f.key) byKey.set(f.key, f)
            if (f.reference) byKey.set(f.reference, f)
          }
          const merged: FavoriteRestaurant[] = []
          const seen = new Set<string>()
          for (const ref of serverRefs) {
            const fav = byKey.get(ref) || { key: ref, reference: ref }
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
            for (const f of guestOnly) {
              const ref = f.reference || f.key
              if (ref) fetch('/api/customer/favorites', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ restaurant_reference: ref }),
              }).catch(() => {})
            }
            writeLocal('guest', []) // merged up — don't let them resurrect a delete
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
    setFavorites(readLocal(scope))
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
        setUserScope(readUserScope())
        refresh() // cross-tab login/logout — re-fetch the right user's list
      }
    }
    function onAuthChange() {
      // A 'disco-user-changed' event is an auth transition. Check the Neon
      // favorites endpoint: authenticated → reconcile; not authenticated (logout)
      // → clear localStorage favorites and reset to an empty guest state.
      fetch('/api/customer/favorites', { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
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
        p.then(res => { if (!res.ok) refresh({ background: true }) }).catch(() => {})
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
