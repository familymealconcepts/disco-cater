'use client'

/**
 * Loads the Google Maps JS API with the Places library ONCE per page, using
 * NEXT_PUBLIC_GOOGLE_MAPS_API_KEY. Resolves true when google.maps.places is
 * usable, false when there is no key, the script fails, or it never becomes
 * ready — callers then keep a plain text input.
 *
 * If another screen already injected the Maps script (the location manager,
 * the diner address book, become-a-partner each have their own tag) it is
 * reused rather than loaded twice.
 */

type W = Window & {
  google?: { maps?: { places?: unknown } }
  __discoPlacesReady?: () => void
  gm_authFailure?: () => void
}

let pending: Promise<boolean> | null = null
const authListeners = new Set<() => void>()
let authFailed = false

const ready = () => !!(window as W).google?.maps?.places

function waitForPlaces(timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const start = Date.now()
    const t = setInterval(() => {
      if (ready()) { clearInterval(t); resolve(true) }
      else if (Date.now() - start > timeoutMs) { clearInterval(t); resolve(false) }
    }, 150)
  })
}

export function loadGooglePlaces(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false)
  if (authFailed) return Promise.resolve(false)
  if (ready()) return Promise.resolve(true)
  if (pending) return pending
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const w = window as W
  // Google calls this when the key is rejected (e.g. a referrer restriction);
  // the widget then disables its input, so every field drops back to plain text.
  const prevAuth = w.gm_authFailure
  w.gm_authFailure = () => {
    authFailed = true
    authListeners.forEach(fn => { try { fn() } catch { /* ignore */ } })
    if (typeof prevAuth === 'function') prevAuth()
  }
  pending = (async () => {
    const existing = document.querySelector<HTMLScriptElement>('script[src*="maps.googleapis.com/maps/api/js"]')
    if (existing) {
      // A tag loaded without the Places library can still fetch it on demand.
      const maps = (w.google?.maps || null) as { importLibrary?: (n: string) => Promise<unknown> } | null
      if (maps?.importLibrary) { try { await maps.importLibrary('places') } catch { /* fall through */ } }
      return waitForPlaces(10000)
    }
    if (!key) return false
    return new Promise<boolean>(resolve => {
      w.__discoPlacesReady = () => resolve(ready())
      const s = document.createElement('script')
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&callback=__discoPlacesReady`
      s.async = true
      s.defer = true
      s.setAttribute('data-google-places', 'true')
      s.onerror = () => resolve(false)
      document.head.appendChild(s)
      setTimeout(() => resolve(ready()), 12000)
    })
  })()
  // A failed load may be retried on a later mount.
  pending.then(ok => { if (!ok) pending = null })
  return pending
}

/** Subscribe to a rejected-key notice. Returns an unsubscribe. */
export function onGooglePlacesAuthFailure(fn: () => void): () => void {
  if (authFailed) { fn(); return () => {} }
  authListeners.add(fn)
  return () => { authListeners.delete(fn) }
}
