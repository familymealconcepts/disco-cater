'use client'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'

const STORAGE_REF = 'selectedRestaurant'
const STORAGE_NAME = 'selectedRestaurantName'
const STORAGE_VIEW = 'disco_view_mode'
const CHANGE_EVENT = 'disco:selected-restaurant-changed'

export type ViewMode = 'SYSTEM_ADMIN' | 'RESTAURANT_USER'

interface ContextValue {
  /** FM restaurant reference UUID, null when no location is picked. */
  ref: string | null
  /** Display name. Prefers the cached name, fills in from /api/restaurant/profile. */
  name: string
  /** Which sidebar nav the SYSTEM_ADMIN is currently viewing. Defaults to
   *  SYSTEM_ADMIN; flipped to RESTAURANT_USER when a location is clicked. */
  viewMode: ViewMode
  /** Set the view mode and persist. */
  setViewMode: (mode: ViewMode) => void
  /** Select a location (PUT FM current + cookie + localStorage + broadcast). */
  setRestaurant: (ref: string, name?: string) => Promise<void>
  /** Clear selection (DELETE FM current + cookies + localStorage + broadcast). */
  clearRestaurant: () => Promise<void>
  /** Force re-pull of /api/restaurant/profile to refresh the canonical name. */
  refreshName: () => Promise<void>
}

const Ctx = createContext<ContextValue | null>(null)

// Broadcast detail — every field is optional so producers only carry
// what they're actually changing. The listener applies fields by
// presence so a "viewMode changed" broadcast can't accidentally roll
// back a freshly-set restaurant ref (race that bit us when location-
// row click ran setRestaurant + setViewMode back-to-back).
interface BroadcastDetail {
  ref?: string | null
  name?: string
  viewMode?: ViewMode
}

/**
 * Owns the single source of truth for the currently-impersonated
 * restaurant in the restaurant portal. Both the sidebar header and the
 * dashboard Restaurant dropdown read + write through this context so
 * they can't drift out of sync.
 *
 * Persistence: cookies on the server (set via /api/restaurant/selected-
 * restaurant) and localStorage for the client. Cross-tab + cross-
 * component sync via a custom 'disco:selected-restaurant-changed' event.
 */
export function SelectedRestaurantProvider({ children }: { children: React.ReactNode }) {
  const [ref, setRef] = useState<string | null>(null)
  const [name, setName] = useState<string>('')
  const [viewMode, setViewModeState] = useState<ViewMode>('SYSTEM_ADMIN')

  // Initial hydrate from localStorage.
  useEffect(() => {
    try {
      const r = localStorage.getItem(STORAGE_REF)
      const n = localStorage.getItem(STORAGE_NAME)
      const v = localStorage.getItem(STORAGE_VIEW)
      if (r) setRef(r)
      if (n) setName(n)
      if (v === 'RESTAURANT_USER' || v === 'SYSTEM_ADMIN') setViewModeState(v)
    } catch {}
  }, [])

  // Same-tab broadcast (so changes in one consumer reach others) +
  // cross-tab via the native storage event.
  useEffect(() => {
    function onCustom(e: Event) {
      const detail = (e as CustomEvent).detail as BroadcastDetail | undefined
      if (!detail) return
      // Only apply fields the broadcaster explicitly set. Older
      // detail shape had ref/name as required, which let a stale
      // closure reset a freshly-picked restaurant.
      if ('ref' in detail) setRef(detail.ref ?? null)
      if (typeof detail.name === 'string') setName(detail.name)
      if (detail.viewMode) setViewModeState(detail.viewMode)
    }
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_REF) setRef(e.newValue || null)
      if (e.key === STORAGE_NAME) setName(e.newValue || '')
      if (e.key === STORAGE_VIEW && (e.newValue === 'RESTAURANT_USER' || e.newValue === 'SYSTEM_ADMIN')) {
        setViewModeState(e.newValue)
      }
    }
    window.addEventListener(CHANGE_EVENT, onCustom as EventListener)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustom as EventListener)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode)
    try { localStorage.setItem(STORAGE_VIEW, mode) } catch {}
    try {
      // Only broadcast the field we're changing. Including ref/name
      // here would carry their stale closure values and clobber a
      // freshly-set restaurant on the listener side.
      window.dispatchEvent(new CustomEvent<BroadcastDetail>(CHANGE_EVENT, { detail: { viewMode: mode } }))
    } catch {}
  }, [])

  // After a successful selection, pull the canonical business name from
  // /api/restaurant/profile so the sidebar header and dropdown agree
  // even if we only had the reference handy (e.g. on first hydrate).
  const refreshName = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/profile', { credentials: 'include' })
      if (!res.ok) return
      const d = await res.json()
      const bn = d?.businessName
      if (typeof bn === 'string' && bn) {
        setName(bn)
        try { localStorage.setItem(STORAGE_NAME, bn) } catch {}
        try {
          window.dispatchEvent(new CustomEvent<BroadcastDetail>(CHANGE_EVENT, { detail: { name: bn } }))
        } catch {}
      }
    } catch {}
  }, [ref])

  const setRestaurant = useCallback(async (newRef: string, newName?: string) => {
    await fetch(`/api/restaurant/selected-restaurant?restaurantReference=${encodeURIComponent(newRef)}`, {
      method: 'PUT', credentials: 'include',
    })
    setRef(newRef)
    try { localStorage.setItem(STORAGE_REF, newRef) } catch {}
    if (newName) {
      setName(newName)
      try { localStorage.setItem(STORAGE_NAME, newName) } catch {}
    }
    try {
      window.dispatchEvent(new CustomEvent<BroadcastDetail>(CHANGE_EVENT, { detail: { ref: newRef, name: newName || name } }))
    } catch {}
    // Always confirm name from the server post-switch so the cached
    // value can't lie about which restaurant we're on.
    refreshName()
  }, [name, refreshName])

  const clearRestaurant = useCallback(async () => {
    await fetch('/api/restaurant/selected-restaurant', { method: 'DELETE', credentials: 'include' })
    setRef(null)
    setName('')
    setViewModeState('SYSTEM_ADMIN')
    try {
      localStorage.removeItem(STORAGE_REF)
      localStorage.removeItem(STORAGE_NAME)
      localStorage.setItem(STORAGE_VIEW, 'SYSTEM_ADMIN')
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent<BroadcastDetail>(CHANGE_EVENT, { detail: { ref: null, name: '', viewMode: 'SYSTEM_ADMIN' } }))
    } catch {}
  }, [])

  return (
    <Ctx.Provider value={{ ref, name, viewMode, setViewMode, setRestaurant, clearRestaurant, refreshName }}>
      {children}
    </Ctx.Provider>
  )
}

export function useSelectedRestaurant(): ContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSelectedRestaurant must be used inside SelectedRestaurantProvider')
  return v
}
