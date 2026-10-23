// The advertising opt-out: ONE rule, read by every loader it governs.
//
// A visitor is opted out when their browser sends Global Privacy Control
// (navigator.globalPrivacyControl === true) OR they turned on the switch on
// /privacy-choices, which is remembered in this browser's localStorage.
//
// When opted out:
//   - the Meta Pixel and the LinkedIn Insight Tag do not load (app/layout.tsx)
//   - RB2B and Apollo's website tracker do not load (app/components/VisitorIdentification.tsx)
//   - Google consent defaults ad_storage, ad_user_data and ad_personalization to
//     'denied' before GA4 is configured (app/layout.tsx)
// GA4 analytics and Microsoft Clarity are NOT governed by this, by decision (Kevin, 2026-10-23).
//
// A SECOND, separate choice: optional cookies, asked by the banner (app/components/ConsentBanner.tsx)
// and changeable on /privacy-choices. Until the visitor accepts, Microsoft Clarity, RB2B and
// Apollo's website tracker do not load; on Accept they load at once, with no reload, because
// setConsent() fires CONSENT_EVENT and both loaders listen for it. GPC reads as Decline, and its
// visitors never see the banner. The opt-out above still wins: an opted-out visitor who accepts
// gets Clarity but not RB2B or Apollo. GA4, Google ad consent, Meta and LinkedIn ignore this
// choice entirely (Kevin, 2026-10-23).
//
// The layout's tags are inline scripts and cannot import this module at runtime, so the same
// rule is also exported as a JS expression (OPT_OUT_EXPR) that the layout interpolates. Both
// read the same key; scripts/tests/privacy-choices-guard.test.ts checks every loader uses one.

export const PRIVACY_OPT_OUT_KEY = 'disco_privacy_opt_out'

/** The rule as a self-contained JS expression, for the layout's inline scripts. */
export const OPT_OUT_EXPR =
  `(navigator.globalPrivacyControl === true || (function(){try{return localStorage.getItem('${PRIVACY_OPT_OUT_KEY}')==='1'}catch(e){return false}})())`

export function gpcEnabled(): boolean {
  try { return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true } catch { return false }
}

export function switchOptedOut(): boolean {
  try { return localStorage.getItem(PRIVACY_OPT_OUT_KEY) === '1' } catch { return false }
}

export function adTrackingOptedOut(): boolean {
  return gpcEnabled() || switchOptedOut()
}

/** Saves the switch. Turning it on also denies Google's ad consent on the current page. */
export function setSwitchOptedOut(on: boolean): void {
  try {
    if (on) localStorage.setItem(PRIVACY_OPT_OUT_KEY, '1')
    else localStorage.removeItem(PRIVACY_OPT_OUT_KEY)
  } catch { /* storage blocked: the choice cannot be remembered */ }
  if (on) {
    const gtag = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag
    try { gtag?.('consent', 'update', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }) } catch { /* never break the page */ }
  }
  notify()
}

export const CONSENT_KEY = 'disco_consent'
export const CONSENT_EVENT = 'disco-consent-change'
export type ConsentChoice = 'accepted' | 'declined'

function notify() {
  try { window.dispatchEvent(new Event(CONSENT_EVENT)) } catch { /* no window (SSR) */ }
}

/** The visitor's optional-cookies choice, or null if they have not chosen. GPC reads as declined. */
export function consentChoice(): ConsentChoice | null {
  if (gpcEnabled()) return 'declined'
  try {
    const v = localStorage.getItem(CONSENT_KEY)
    return v === 'accepted' || v === 'declined' ? v : null
  } catch { return null }
}

/** True only after an explicit Accept, and never under GPC. */
export function optionalCookiesAllowed(): boolean {
  return consentChoice() === 'accepted'
}

/** Saves the choice and tells the loaders, so an Accept takes effect on this page. */
export function setConsent(choice: ConsentChoice): void {
  try { localStorage.setItem(CONSENT_KEY, choice) } catch { /* storage blocked: the choice cannot be remembered */ }
  notify()
}
