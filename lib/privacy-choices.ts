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
}
