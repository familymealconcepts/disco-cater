'use client'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

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
  /** Resolves true only if the switch actually took effect server-side. */
  setRestaurant: (ref: string, name?: string) => Promise<boolean>
  /** Clear selection (DELETE FM current + cookies + localStorage + broadcast). */
  clearRestaurant: () => Promise<void>
  /** Force re-pull of /api/restaurant/profile to refresh the canonical name. */
  refreshName: () => Promise<void>
}

const Ctx = createContext<ContextValue | null>(null)

async function readServerSelection(): Promise<{ ref: string | null; name: string | null } | null> {
  try {
    const res = await fetch('/api/restaurant/selected-restaurant', { credentials: 'include', cache: 'no-store' })
    if (!res.ok) return null
    const d = await res.json() as { ref?: string | null; name?: string | null }
    return { ref: d?.ref || null, name: d?.name || null }
  } catch { return null } // offline — keep what is on screen
}

function reloadForSelection(server: { ref: string | null; name: string | null }) {
  try {
    if (server.ref) {
      localStorage.setItem(STORAGE_REF, server.ref)
      if (server.name) localStorage.setItem(STORAGE_NAME, server.name); else localStorage.removeItem(STORAGE_NAME)
    } else { localStorage.removeItem(STORAGE_REF); localStorage.removeItem(STORAGE_NAME) }
  } catch {}
  window.location.reload()
}

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

  // Hydrate in two steps: localStorage FIRST so the sidebar paints without a
  // flash, then the SERVER, which is the authority and overrides it.
  //
  // localStorage alone was the bug. The cookie is the only store any API scopes
  // by, and iOS Safari evicts localStorage under ITP long before a 30-day cookie
  // expires — so a phone could show "All Locations" in the sidebar while every
  // screen's data was scoped to one, or the reverse. The optimistic read is kept
  // only to avoid a flash; it is never the final word.
  useEffect(() => {
    try {
      const r = localStorage.getItem(STORAGE_REF)
      const n = localStorage.getItem(STORAGE_NAME)
      const v = localStorage.getItem(STORAGE_VIEW)
      if (r) setRef(r)
      if (n) setName(n)
      if (v === 'RESTAURANT_USER' || v === 'SYSTEM_ADMIN') setViewModeState(v)
    } catch { /* storage blocked/evicted — the server read below is what matters */ }

    let alive = true
    ;(async () => {
      const server = await readServerSelection()
      if (!server || !alive) return
      applyServerSelection(server)
    })()
    return () => { alive = false }
  }, [])

  // ── THE LABEL IS THE SERVER'S SELECTION, NAME INCLUDED ────────────────────
  // The name used to come from localStorage and was only refreshed after a
  // switch made in THIS tab. So it went stale three ways, all of which System
  // Admins hit: a name cached from a different location (or a different login
  // in the same browser) survived the hydrate, because only the ref was
  // realigned; a switch in another tab moved the cookie — which every save
  // scopes by — while this tab kept its old label and its old form; and the
  // refresh read a field that named a sibling location (fixed in
  // /api/restaurant/profile). The server now returns the EFFECTIVE selection
  // with that location's own name, and this tab adopts it on load and every
  // time it regains focus.
  const refRef = useRef<string | null>(null)
  const hydratedRef = useRef(false)
  useEffect(() => { refRef.current = ref }, [ref])

  useEffect(() => {
    async function recheck() {
      if (document.visibilityState !== 'visible') return
      const server = await readServerSelection()
      if (!server) return
      if (hydratedRef.current && server.ref !== refRef.current) {
        // The selection changed underneath this tab (another tab, or a location
        // taken off the person's list). Whatever form is on screen was loaded for
        // the old location; saving it now would write to the new one. Reload so
        // the page, the label and the save target are all the same location.
        reloadForSelection(server)
        return
      }
      applyServerSelection(server)
    }
    document.addEventListener('visibilitychange', recheck)
    window.addEventListener('focus', recheck)
    return () => {
      document.removeEventListener('visibilitychange', recheck)
      window.removeEventListener('focus', recheck)
    }
  }, [])

  function applyServerSelection(server: { ref: string | null; name: string | null }) {
    hydratedRef.current = true
    refRef.current = server.ref
    setRef(server.ref)
    setName(server.ref ? (server.name || '') : '')
    try {
      if (server.ref) {
        localStorage.setItem(STORAGE_REF, server.ref)
        if (server.name) localStorage.setItem(STORAGE_NAME, server.name)
      } else {
        localStorage.removeItem(STORAGE_REF); localStorage.removeItem(STORAGE_NAME)
      }
    } catch { /* optimistic copy only — the server read already applied */ }
  }

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
      // Another tab switched location. The cookie moved with it, so this tab's
      // form now belongs to a location the server no longer scopes to — reload
      // rather than relabel (see recheck above).
      if (e.key === STORAGE_REF && (e.newValue || null) !== refRef.current) {
        reloadForSelection({ ref: e.newValue || null, name: null })
        return
      }
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

  /**
   * Switch the selected restaurant. Returns whether the switch actually happened.
   *
   * THE RESPONSE IS CHECKED, AND IT DID NOT USED TO BE. The PUT was fired and
   * ignored, so a REFUSED switch was indistinguishable from a successful one: the
   * ref state, the sidebar name and localStorage were all updated regardless, and
   * the caller navigated. The server meanwhile kept the OLD cookie, which is the
   * only thing any API scopes on — so the portal showed one restaurant's name over
   * another restaurant's data. That is how clicking "Stacks & Cordials - Royal Oak
   * (Copy)" landed on Clawson.
   *
   * refreshName() eventually pulled the real name back from the server, so the
   * LABEL self-corrected after a round trip — but `ref` and the localStorage copy
   * stayed wrong indefinitely, and they are what client-side code reads.
   *
   * On failure nothing is mutated: no ref, no name, no localStorage, no broadcast.
   * The caller gets false and is responsible for not navigating.
   */
  const setRestaurant = useCallback(async (newRef: string, newName?: string): Promise<boolean> => {
    let res: Response
    try {
      res = await fetch(`/api/restaurant/selected-restaurant?restaurantReference=${encodeURIComponent(newRef)}`, {
        method: 'PUT', credentials: 'include',
      })
    } catch {
      return false
    }
    if (!res.ok) return false
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
    return true
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
