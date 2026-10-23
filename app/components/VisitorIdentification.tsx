'use client'

// Loads RB2B and Apollo's website tracker, on allowed pages only. The page rule lives in
// lib/visitor-identification.ts and is the only thing that decides; both vendors go through it.
//
// Loading on the PATH rather than once per document is what makes this correct in the other
// direction too: a visitor who lands on /order/ gets neither script, and gets both the moment
// they navigate client-side to an allowed page. Each vendor loads at most once per page load.
//
// Both skip the disco_internal=true cookie, so the team is never identified (RB2B always did;
// Apollo did not until this component).
//
// Both also skip a visitor who has opted out — Global Privacy Control or the /privacy-choices
// switch, decided by lib/privacy-choices.ts.
//
// The two loaders are the vendors' own snippets, unchanged apart from being called from here
// instead of inline <Script> tags in app/layout.tsx.

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { visitorIdentificationAllowed } from '../../lib/visitor-identification'
import { adTrackingOptedOut } from '../../lib/privacy-choices'

declare global {
  interface Window {
    reb2b?: { loaded: boolean }
    __discoApolloLoaded?: boolean
    trackingFunctions?: { onLoad: (opts: { appId: string }) => void }
  }
}

function isInternal(): boolean {
  try { return document.cookie.includes('disco_internal=true') } catch { return true }
}

function loadRb2b(key: string) {
  if (window.reb2b) return
  window.reb2b = { loaded: true }
  const s = document.createElement('script')
  s.async = true
  s.src = 'https://ddwl4m2hdecbv.cloudfront.net/b/' + key + '/' + key + '.js.gz'
  const first = document.getElementsByTagName('script')[0]
  if (first?.parentNode) first.parentNode.insertBefore(s, first)
  else document.head.appendChild(s)
}

function loadApollo(appId: string) {
  if (window.__discoApolloLoaded) return
  window.__discoApolloLoaded = true
  const n = Math.random().toString(36).substring(7)
  const o = document.createElement('script')
  o.src = 'https://assets.apollo.io/micro/website-tracker/tracker.iife.js?nocache=' + n
  o.async = true
  o.defer = true
  o.onload = function () { window.trackingFunctions?.onLoad({ appId }) }
  document.head.appendChild(o)
}

export default function VisitorIdentification() {
  const pathname = usePathname()

  useEffect(() => {
    if (!pathname) return
    if (!visitorIdentificationAllowed(pathname, window.location.hostname)) return
    if (isInternal()) return
    if (adTrackingOptedOut()) return
    try { loadRb2b('GNLKQH7D136Q') } catch { /* a vendor must never break the page */ }
    try { loadApollo('698b7a4f08b116001d87b092') } catch { /* same */ }
  }, [pathname])

  return null
}
