'use client'

// The optional-cookies banner: a bar at the bottom of the screen until the visitor chooses.
// Accept or Decline is saved by setConsent() in lib/privacy-choices.ts, which also tells the
// Clarity and RB2B/Apollo loaders, so an Accept takes effect on this page with no reload.
// GPC visitors read as Decline and never see it. /privacy-choices can change the choice later.
//
// One dark bar for every visitor, light or dark system theme (Kevin, 2026-10-23). The site has
// no dark theme, so a bar that followed the system would be the only dark thing on a light page.
//
// It must NEVER cover the restaurant page's fixed mobile order bar (.mobile-order-bar in
// RestaurantClient.tsx, also used by /order/*): it sits directly above it instead. The bar
// mounts after hydration and shows only under 900px, so its height is re-measured whenever the
// DOM or the viewport changes. Its z-index (100) is below ours (150); every modal and the
// full-screen cart are above ours (200+), so the banner never covers those either.

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { consentChoice, setConsent, CONSENT_EVENT } from '../../lib/privacy-choices'

function subscribe(fn: () => void) {
  window.addEventListener(CONSENT_EVENT, fn)
  window.addEventListener('storage', fn)
  return () => { window.removeEventListener(CONSENT_EVENT, fn); window.removeEventListener('storage', fn) }
}
const needsChoice = () => consentChoice() === null
const serverSnapshot = () => false

const ORDER_BAR = '.mobile-order-bar'

function orderBarHeight(): number {
  const bar = document.querySelector<HTMLElement>(ORDER_BAR)
  if (!bar || getComputedStyle(bar).display === 'none') return 0
  return bar.getBoundingClientRect().height
}

const CSS = `
.consent-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 150; background: #1A1028; color: #fff;
  font-family: 'DM Sans', sans-serif; box-shadow: 0 -4px 16px rgba(0,0,0,0.18);
  padding: 12px 16px; padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)); }
.consent-bar.above-order-bar { padding-bottom: 12px; }
.consent-inner { max-width: 1120px; margin: 0 auto; display: flex; align-items: center; gap: 12px 20px; flex-wrap: wrap; }
.consent-text { flex: 1 1 300px; margin: 0; font-size: 14px; line-height: 1.5; color: #fff; }
.consent-text a { color: #fff; text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
.consent-actions { display: flex; gap: 10px; flex: 0 0 auto; }
.consent-btn { font: inherit; font-size: 14px; font-weight: 700; border-radius: 10px; padding: 10px 18px; min-height: 44px; cursor: pointer; }
.consent-decline { background: transparent; color: #fff; border: 1.5px solid #fff; }
.consent-accept { background: #fff; color: #1A1028; border: 1.5px solid #fff; }
.consent-btn:focus-visible, .consent-text a:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
@media (max-width: 600px) {
  .consent-actions { flex: 1 1 100%; }
  .consent-btn { flex: 1 1 0; }
}
`

export default function ConsentBanner() {
  const show = useSyncExternalStore(subscribe, needsChoice, serverSnapshot)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!show) return
    let observed: Element | null = null
    const place = () => {
      const el = ref.current
      if (!el) return
      const h = orderBarHeight()
      el.style.bottom = `${h}px`
      el.classList.toggle('above-order-bar', h > 0)
      const bar = document.querySelector(ORDER_BAR)
      if (bar !== observed) {
        if (observed) resize.unobserve(observed)
        if (bar) resize.observe(bar)
        observed = bar
      }
    }
    const resize = new ResizeObserver(place)
    const mutations = new MutationObserver(place)
    mutations.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', place)
    place()
    return () => { mutations.disconnect(); resize.disconnect(); window.removeEventListener('resize', place) }
  }, [show])

  if (!show) return null
  return (
    <div ref={ref} className="consent-bar" role="region" aria-label="Cookie choice">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="consent-inner">
        <p className="consent-text">
          We&rsquo;d like to use cookies to record how you use our pages and to identify the business you&rsquo;re visiting from.{' '}
          <a href="/privacy">Privacy Policy</a>
        </p>
        <div className="consent-actions">
          <button type="button" className="consent-btn consent-decline" onClick={() => setConsent('declined')}>Decline</button>
          <button type="button" className="consent-btn consent-accept" onClick={() => setConsent('accepted')}>Accept</button>
        </div>
      </div>
    </div>
  )
}
