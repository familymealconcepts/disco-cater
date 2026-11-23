'use client'

// Loads Microsoft Clarity, only after the visitor accepts optional cookies (the consent banner,
// or the switch on /privacy-choices). GPC reads as Decline. The rule is
// optionalCookiesAllowed() in lib/privacy-choices.ts. Clarity follows the banner ALONE: the
// advertising opt-out switch does not touch it (Kevin, 2026-10-23).
//
// Team browsers (disco_internal=true) never load it, like RB2B and Apollo (Kevin, 2026-10-24).
//
// Public marketing and ordering pages only (Peter, 2026-11-23): never the restaurant portal, Super
// Admin, a diner's account or an order confirmation. The rule is lib/clarity-scope.ts.
//
// An Accept fires CONSENT_EVENT, so Clarity loads on the page where it happens, with no reload.
// The loader is Clarity's own snippet, unchanged apart from being called from here instead of an
// inline <Script> in app/layout.tsx. It loads at most once per page load.

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { optionalCookiesAllowed, CONSENT_EVENT } from '../../lib/privacy-choices'
import { clarityAllowedOn } from '../../lib/clarity-scope'

declare global {
  interface Window { __discoClarityLoaded?: boolean }
}

// The same test VisitorIdentification and acquisition use; a blocked cookie jar reads as internal.
function isInternalBrowser(): boolean {
  try { return document.cookie.includes('disco_internal=true') } catch { return true }
}

function loadClarity(id: string) {
  if (window.__discoClarityLoaded) return
  window.__discoClarityLoaded = true
  type ClarityFn = ((...a: unknown[]) => void) & { q?: unknown[] }
  ;(function (c: Record<string, ClarityFn>, l: Document, a: string, r: string, i: string) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments) } // eslint-disable-line prefer-rest-params
    const t = l.createElement(r) as HTMLScriptElement
    t.async = true
    t.src = 'https://www.clarity.ms/tag/' + i
    const y = l.getElementsByTagName(r)[0]
    if (y?.parentNode) y.parentNode.insertBefore(t, y)
    else l.head.appendChild(t)
  })(window as unknown as Record<string, ClarityFn>, document, 'clarity', 'script', id)
}

// Clarity's own command queue (pause/resume are part of its public API). Safe before the script
// has finished loading: the snippet's stub queues the call.
function clarityCommand(cmd: 'pause' | 'resume') {
  try { (window as unknown as { clarity?: (c: string) => void }).clarity?.(cmd) } catch { /* never break the page */ }
}

export default function ClarityLoader() {
  // Public marketing and ordering pages only (lib/clarity-scope.ts). The site is one app, so a
  // visitor can move from a public page into an excluded one without a reload: there Clarity is
  // paused, and resumed when they come back.
  const pathname = usePathname()
  const allowed = clarityAllowedOn(pathname)

  useEffect(() => {
    if (!allowed) {
      if (window.__discoClarityLoaded) clarityCommand('pause')
      return
    }
    if (window.__discoClarityLoaded) clarityCommand('resume')
    const load = () => {
      if (isInternalBrowser()) return
      if (!optionalCookiesAllowed()) return
      try { loadClarity('vv8ibgkwby') } catch { /* a vendor must never break the page */ }
    }
    load()
    window.addEventListener(CONSENT_EVENT, load)
    return () => window.removeEventListener(CONSENT_EVENT, load)
  }, [allowed])

  return null
}
