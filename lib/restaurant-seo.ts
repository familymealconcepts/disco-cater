// The <title> and meta description of a restaurant menu page (/restaurants/<slug>, and /order/<slug>,
// which reuses it). ONE rule for every restaurant, never per-page copy. Wording approved word for
// word by Kevin, 2026-10-23 (NM OS QUEUE line 14, item #43).
//
// WHY: nearly all of these pages' non-brand Search Console impressions are searches for
// "<restaurant> menu", at an average position of 6-11, and about 0.1% became clicks. The old title,
// "{name} — Catering in {location} | Disco Cater", never said "menu", repeated the city when the
// name already held it, and often ran past the ~60 characters Google shows. The old description
// was only the restaurant's own blurb.
//
// Read by buildRestaurantMetadata (app/(customer)/restaurants/[slug]/shared.tsx). Its no-data
// fallback ("Catering | Disco Cater") is unchanged, by decision. Fixtures:
// scripts/tests/menu-page-meta.test.ts.

export const MAX_TITLE = 60
export const MAX_DESCRIPTION = 155

/** The city part of a location like "Fort Wayne, IN". */
function cityOf(location: string): string {
  return location.split(',')[0].trim()
}

/**
 * `{name} Catering Menu – {location} | Disco Cater`. The location is left out when the name already
 * contains the city. Over 60 characters, ` | Disco Cater` is dropped; still over, it is just
 * `{name} Catering Menu`.
 */
export function menuPageTitle(name: string, location: string): string {
  const loc = location.trim()
  const city = cityOf(loc)
  const where = loc && !(city && name.toLowerCase().includes(city.toLowerCase())) ? ` – ${loc}` : ''
  const full = `${name} Catering Menu${where} | Disco Cater`
  if (full.length <= MAX_TITLE) return full
  const withoutBrand = `${name} Catering Menu${where}`
  return withoutBrand.length <= MAX_TITLE ? withoutBrand : `${name} Catering Menu`
}

/** Cut to `max` characters at a word boundary, ending with "…". */
export function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s
  const head = s.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return (space > 0 ? head.slice(0, space) : head).replace(/[\s,.;:–-]+$/, '') + '…'
}

/** The restaurant's blurb as a sentence: a capital first letter and a final full stop. */
function asSentence(blurb: string): string {
  const b = blurb.trim().replace(/^./, (ch) => ch.toUpperCase())
  return /[.!?…]$/.test(b) ? b : `${b}.`
}

/**
 * The lead promises online ordering ONLY when the restaurant can take an order right now
 * (`assertRestaurantOrderable(...).reason === 'ok'`). Otherwise, for example with no Stripe account
 * yet, it says only that the menu is on Disco Cater, so search never promises what the page refuses.
 */
export function menuPageDescription(name: string, location: string, blurb: string | null, orderable: boolean): string {
  const loc = location.trim()
  const b = (blurb ?? '').trim()
  if (b) {
    const lead = orderable
      ? `See the ${name} catering menu and order online for your office, event or party.`
      : `See the ${name} catering menu on Disco Cater.`
    return cutAtWord(`${lead} ${asSentence(b)}`, MAX_DESCRIPTION)
  }
  const text = orderable
    ? `See the ${name} catering menu and order online for your office, event or party${loc ? ` in ${loc}` : ''}, with Disco Cater.`
    : `See the ${name} catering menu on Disco Cater${loc ? ` in ${loc}` : ''}.`
  return cutAtWord(text, MAX_DESCRIPTION)
}
