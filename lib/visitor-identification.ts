// Which pages may load the paid visitor-identification vendors (RB2B and Apollo's website
// tracker). ONE rule for both, read by app/components/VisitorIdentification.tsx, so the two
// vendors cannot drift apart. Both bill per identified visitor, and they exist to find 3P
// diners and restaurant prospects — not people we already have.
//
// Excluded, and why:
//   /order/*               1P direct ordering (isFirstParty → FAMILYMEAL). The restaurant's own
//                          customer, reached through the restaurant's own link.
//   /locations/*           a restaurant's multi-unit link page; every card on it goes to /order/.
//   /order-confirmation/*  shared by 1P and 3P, but anyone here just ordered and we have them.
//   /account/*             logged-in diners, already known.
//   /restaurant/*          the logged-in restaurant portal: existing partners. EXCEPT the pages a
//                          not-yet-live restaurant hits before it has a session (KEPT_RESTAURANT_PATHS).
//
// Matching is by whole path segment, so /order excludes /order/x but not /order-confirmation,
// and /restaurant does not touch /restaurants (the 3P marketplace page).
//
// Client-side navigation: the vendor scripts cannot be unloaded once running. A visitor who
// lands on an allowed page and then navigates client-side into an excluded one keeps the
// scripts for the rest of that page load. Accepted (2026-10-21): no 3P page links into /order/
// or /locations/, so in practice that only happens through Back/Forward.

const EXCLUDED_PREFIXES = ['/order', '/locations', '/order-confirmation', '/account', '/restaurant']

// The pre-session restaurant pages: sign in, accept an emailed invite, reset a password. These
// mirror the middleware's PUBLIC_RESTAURANT_PATHS. A restaurant signs up through
// /become-a-partner, which is outside /restaurant and allowed by default.
export const KEPT_RESTAURANT_PATHS = ['/restaurant/login', '/restaurant/accept-invite', '/restaurant/forgot-password']

// restaurant.discocater.com is rewritten onto /restaurant/* (vercel.json), so its paths arrive
// without the prefix. Put it back so the portal is judged as the portal on either host.
function effectivePath(pathname: string, hostname: string): string {
  let p = (pathname || '/').toLowerCase().split(/[?#]/)[0]
  if (p.length > 1) p = p.replace(/\/+$/, '')
  if (hostname.toLowerCase().startsWith('restaurant.') && p !== '/restaurant' && !p.startsWith('/restaurant/')) {
    p = p === '/' ? '/restaurant' : `/restaurant${p}`
  }
  return p
}

export function visitorIdentificationAllowed(pathname: string, hostname = ''): boolean {
  const p = effectivePath(pathname, hostname)
  if (KEPT_RESTAURANT_PATHS.includes(p)) return true
  return !EXCLUDED_PREFIXES.some(prefix => p === prefix || p.startsWith(`${prefix}/`))
}
