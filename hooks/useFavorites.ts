'use client'
import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'disco_favorites'

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

function readLocal(): FavoriteRestaurant[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function writeLocal(favs: FavoriteRestaurant[]) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favs)) } catch {}
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
      // 501 → FM hasn't shipped favorites; fall through to localStorage.
    } catch {
      // network — fall through
    }
    setFavorites(readLocal())
    setSource('local')
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

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
    if (source === 'local') writeLocal(next)
    broadcast(next)

    // Fire-and-forget API call when source is 'api'. If it fails, refresh
    // from the server to reconcile.
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
  }, [favorites, source, refresh])

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
