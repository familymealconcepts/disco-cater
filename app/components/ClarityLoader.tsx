'use client'

// Loads Microsoft Clarity, only after the visitor accepts optional cookies (the consent banner,
// or the switch on /privacy-choices). GPC reads as Decline. The rule is
// optionalCookiesAllowed() in lib/privacy-choices.ts. Clarity follows the banner ALONE: the
// advertising opt-out switch does not touch it (Kevin, 2026-10-23).
//
// An Accept fires CONSENT_EVENT, so Clarity loads on the page where it happens, with no reload.
// The loader is Clarity's own snippet, unchanged apart from being called from here instead of an
// inline <Script> in app/layout.tsx. It loads at most once per page load.

import { useEffect } from 'react'
import { optionalCookiesAllowed, CONSENT_EVENT } from '../../lib/privacy-choices'

declare global {
  interface Window { __discoClarityLoaded?: boolean }
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

export default function ClarityLoader() {
  useEffect(() => {
    const load = () => {
      if (!optionalCookiesAllowed()) return
      try { loadClarity('vv8ibgkwby') } catch { /* a vendor must never break the page */ }
    }
    load()
    window.addEventListener(CONSENT_EVENT, load)
    return () => window.removeEventListener(CONSENT_EVENT, load)
  }, [])

  return null
}
