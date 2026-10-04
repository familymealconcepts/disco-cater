'use client'

// Browser side of acquisition capture. Writes the first-party `disco_acq`
// cookie that lib/attribution.ts reads server-side at placement.
//
// Zero imports beyond the shared constants, and every operation is wrapped —
// this runs on the first paint of every customer page and on the click that
// leaves the map. It must never be able to throw into a customer's path.

import {
  ACQUISITION_COOKIE,
  ACQUISITION_COOKIE_MAX_AGE_SECONDS,
  CLICK_ID_PARAMS,
  MAX_FIELD_LENGTH,
  type AcquisitionSource,
} from '../attribution'

/** Same internal-traffic switch the GA/Clarity/RB2B/LinkedIn/Meta tags use in
 *  app/layout.tsx. Staff browsing must not look like customer acquisition. */
function isInternal(): boolean {
  try { return document.cookie.includes('disco_internal=true') } catch { return true }
}

function readRaw(): string | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${ACQUISITION_COOKIE}=([^;]*)`))
    return m ? m[1] : null
  } catch { return null }
}

function readCookie(): Record<string, unknown> {
  const raw = readRaw()
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function writeCookie(obj: Record<string, unknown>): void {
  try {
    const value = encodeURIComponent(JSON.stringify(obj))
    // A cookie over ~4KB is silently dropped by the browser. Every field is
    // already bounded to MAX_FIELD_LENGTH, so this is a backstop, not the
    // primary guard — if it ever trips, drop the longest field rather than
    // writing nothing.
    if (value.length > 3500) {
      delete obj.r
      writeCookieRaw(encodeURIComponent(JSON.stringify(obj)))
      return
    }
    writeCookieRaw(value)
  } catch { /* capture is best-effort, always */ }
}

function writeCookieRaw(value: string): void {
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${ACQUISITION_COOKIE}=${value}; Path=/; Max-Age=${ACQUISITION_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`
}

function bound(v: string | null | undefined): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t.slice(0, MAX_FIELD_LENGTH) : undefined
}

/**
 * First-load capture. Records referrer, UTM parameters, a paid click id and the
 * landing path — ONCE. Re-running on a later page is a no-op for those fields,
 * which is the whole point: the landing page must stay the page they landed on.
 *
 * Safe to call on every render; it returns immediately when a first touch
 * already exists.
 */
export function captureAcquisitionOnLoad(): void {
  if (typeof document === 'undefined' || typeof location === 'undefined') return
  if (isInternal()) return

  const existing = readCookie()
  // First touch already recorded — never overwrite it.
  if (existing.t) return

  const params = new URLSearchParams(location.search)
  const next: Record<string, unknown> = { ...existing }

  // document.referrer is '' for a typed URL, a bookmark, most app webviews, and
  // browsers that strip it. That is the "direct"/unknown bucket, and it is
  // stored as absent rather than as an empty string.
  const ref = bound(document.referrer)
  if (ref) next.r = ref

  next.lp = bound(location.pathname) ?? '/'

  const utm = {
    us: bound(params.get('utm_source')),
    um: bound(params.get('utm_medium')),
    uc: bound(params.get('utm_campaign')),
    ut: bound(params.get('utm_term')),
    un: bound(params.get('utm_content')),
  }
  for (const [k, v] of Object.entries(utm)) if (v) next[k] = v

  for (const p of CLICK_ID_PARAMS) {
    const v = bound(params.get(p))
    if (v) { next.ci = v; next.cit = p; break }
  }

  next.t = new Date().toISOString()
  writeCookie(next)
}

/**
 * Mark which internal marketplace path the customer took to reach a restaurant.
 * Last-touch by design — moving from the map to a search and then to the chat
 * should end up attributed to the chat, because that is the click that actually
 * produced the visit.
 *
 * Called from the navigation sites on /fullmap and /dinova-demo. Writes even
 * when no first touch exists yet (a customer who landed straight on /fullmap
 * still has a real internal path) and seeds `t` so the row is never orphaned.
 */
export function markAcquisitionSource(source: AcquisitionSource): void {
  if (typeof document === 'undefined') return
  if (isInternal()) return
  const next = readCookie()
  next.s = source
  if (!next.t) {
    next.t = new Date().toISOString()
    try { if (!next.lp) next.lp = bound(location.pathname) ?? '/' } catch { /* ignore */ }
  }
  // The AI discovery intake is handed to the restaurant page through
  // sessionStorage['disco_intake'] (written by the fullmap intake flow, read by
  // RestaurantClient). Its presence is a real signal that this journey went
  // through the AI flow, and it was previously thrown away entirely.
  try { if (sessionStorage.getItem('disco_intake')) next.ai = true } catch { /* ignore */ }
  writeCookie(next)
}

/** Record that the customer completed the AI discovery intake, independently of
 *  which restaurant they later click. */
export function markAiAssisted(): void {
  if (typeof document === 'undefined') return
  if (isInternal()) return
  const next = readCookie()
  next.ai = true
  if (!next.t) next.t = new Date().toISOString()
  writeCookie(next)
}
