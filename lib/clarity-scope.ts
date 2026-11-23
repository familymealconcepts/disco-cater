// Where Microsoft Clarity may run (Peter, 2026-11-23): public marketing and ordering pages only.
//
// NEVER on the restaurant portal (/restaurant/*, its login pages included), Super Admin (/admin/*),
// a diner's account (/account/*, the legacy /portal redirect into it, /reset-password) or an order
// confirmation (/order-confirmation/*). Everything else — the home page, city and marketing pages,
// the marketplace (/restaurants), restaurant order pages (/restaurants/[slug], /order/[slug]) and
// their checkout drawer — stays covered, still only after the visitor accepts (ClarityLoader).
//
// Note /restaurant (the portal) vs /restaurants (the public marketplace): matched on a whole path
// segment, so the one never catches the other.
const EXCLUDED = ['/restaurant', '/admin', '/account', '/portal', '/reset-password', '/order-confirmation']

export function clarityAllowedOn(pathname: string | null | undefined): boolean {
  const p = String(pathname || '/').split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  return !EXCLUDED.some(prefix => p === prefix || p.startsWith(prefix + '/'))
}
