// Where a diner stays after logging in or signing up from the header with nothing pending (AuthModal.tsx).
// Client-safe (no server imports) so the modal and its guard test share exactly one list.
//
// FM lands every diner login on the account area, and so does Disco, except on the pages a diner is
// browsing or ordering from. There, sending them to /account/orders loses the page they came on:
//   /restaurants/  the marketplace restaurant page
//   /order/        the restaurant's OWN link (1P). Added 2026-10-22 (Peter, d9f5967e): diners pushed to
//                  their account came back through the marketplace and ordered as 3P.
//   /fullmap       the catering map
//   /locations/    a restaurant group's own shareable links page, whose buttons go to each location's
//                  /order/ page (1P). Added 2026-10-23 (Kevin, item #36) for the same reason as /order/.
// One list for the sign-up and the log-in handlers, so a path cannot be added to one and missed in the other
// (they were two copies of the same three-way check).
export const STAY_PUT_PREFIXES = ['/restaurants/', '/order/', '/fullmap', '/locations/'] as const

export function staysPutAfterAuth(pathname: string | null | undefined): boolean {
  return !!pathname && STAY_PUT_PREFIXES.some((p) => pathname.startsWith(p))
}
