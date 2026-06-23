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
  const [source, setSource] = useState<'api' | 'local'>('local')
  const [userScope, setUserScope] = useState<string>('guest')
  // Latest scope, readable inside the stable refresh() without making refresh
  // depend on userScope (which caused a second /api/fm-favorites fetch — and a
  // loading flash — every time the cookie scope resolved after mount).
  const userScopeRef = useRef('guest')
  useEffect(() => { userScopeRef.current = userScope }, [userScope])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/fm-favorites', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        const list: FavoriteRestaurant[] = Array.isArray(data) ? data : (data.content || data.data || [])
        setFavorites(list)
        setSource('api')
        setLoading(false)
        return
      }
      // 501/401 → FM hasn't shipped favorites; fall through to localStorage.
    } catch {
      // network — fall through
    }
    // Local fallback. Resolve the user scope FIRST so we read the right bucket —
    // reading with the stale default 'guest' scope here was the race that made a
    // logged-in user's favorites briefly flash and then vanish (the guest bucket
    // is empty, so they got overwritten with []). When disco_user isn't present
    // (cookie-only auth), confirm the scope from the cookie before reading.
    let scope = readUserScope()
    if (scope === 'guest') {
      const cookieScope = await resolveScopeFromCookie()
      if (cookieScope) scope = cookieScope
    }
    setUserScope(scope)
    userScopeRef.current = scope
    setFavorites(readLocal(scope))
    setSource('local')
    setLoading(false)
  }, [])

  // Initial load — runs once (refresh is stable). Auth changes re-fetch via the
  // scope effect below; pure scope resolution does NOT re-hit the API.
  useEffect(() => { refresh() }, [refresh])

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
      // Re-resolve from the cookie so a fresh login picks up the right
      // user, then re-fetch (handles both login and logout — logout 401s
      // back to the guest local bucket).
      resolveScopeFromCookie().then(s => { setUserScope(s || readUserScope()); refresh() })
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

    // Optimistic update everywhere
    setFavorites(next)
    if (source === 'local') writeLocal(userScope, next)
    broadcast(next)

    // Fire-and-forget API call when source is 'api'. If it fails, refresh
    // from the server to reconcile. (FM's eventual favorites endpoint
    // is scoped by the authenticated user via JWT, so no client-side
    // scope key is needed in API mode.)
    if (source === 'api') {
      const ok = wasFavorited
        ? await fetch(`/api/fm-favorites/${encodeURIComponent(r.key)}`, { method: 'DELETE', credentials: 'include' })
        : await fetch('/api/fm-favorites', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(r),
          })
      if (!ok.ok) {
        // Refresh to bring local state back in line with server truth
        refresh()
      }
    }
  }, [favorites, source, userScope, refresh])

  return { favorites, loading, source, isFavorited, toggleFavorite, refresh }
}

// Convenience: derive a stable key for a restaurant from common shapes
// (Sanity record, FM order detail, fullmap card item).
export function favoriteKey(r: { reference?: string; slug?: string | { current?: string }; _id?: string }): string {
  if (r.reference) return r.reference
  const slug = typeof r.slug === 'string' ? r.slug : r.slug?.current
  if (slug) return slug
  return r._id || ''
}
