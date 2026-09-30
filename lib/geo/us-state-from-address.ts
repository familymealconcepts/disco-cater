// Recover a US state from a free-text address line, and normalise the label a
// restaurant shows on the marketplace.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The marketplace sidebar labels each restaurant with
// `[city, state].filter(Boolean).join(', ')`, so a row with no state renders as
// a bare "Dallas" beside a neighbouring "New York, NY". That is the
// inconsistency, and it is NOT a Disco bug: FamilyMeal's tbl_address.state is
// NULL for 3,892 of its 5,305 addresses, and lib/restaurant-cache.ts mirrors FM
// faithfully.
//
// The state is not missing, only misfiled — FM's address_line_1 carries the
// whole address ("477 E Calaveras Blvd, Milpitas, CA"), so the state is the last
// meaningful token. This reads it back out.
//
// Deliberately conservative: it returns a state ONLY when the tail is
// unambiguous, and null otherwise, so a row it cannot read keeps what it has
// rather than being guessed at.

export const US_STATE_ABBR = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
  'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND',
  'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
])

export const US_STATE_NAME_TO_ABBR: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO',
  CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID',
  ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA',
  MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR',
  PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
}

/** Normalise anything that names a US state to its two-letter abbreviation, or null. */
export function toStateAbbr(raw: string | null | undefined): string | null {
  const t = String(raw ?? '').trim()
  if (!t) return null
  const up = t.toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ')
  if (US_STATE_ABBR.has(up)) return up
  return US_STATE_NAME_TO_ABBR[up] ?? null
}

/**
 * The state named at the end of an address line, or null when it cannot be read
 * unambiguously.
 *
 * Handles the shapes FM actually stores, verified against live data:
 *   "477 E Calaveras Blvd, Milpitas, CA"            -> CA
 *   "144 Brighton Ave, Long Branch, NJ 07740, USA"  -> NJ   (country suffix)
 *   "700 N Sheppard St, Richmond, Virginia"         -> VA   (spelled out)
 */
export function stateFromAddressLine(line: string | null | undefined): string | null {
  let t = String(line ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return null
  // Drop a trailing country, which otherwise hides the state behind it.
  t = t.replace(/,\s*(USA|U\.S\.A\.|United States(\s+of\s+America)?)\s*$/i, '').trim()
  // Drop a trailing ZIP so "NJ 07740" reduces to "NJ".
  t = t.replace(/\s+\d{5}(-\d{4})?\s*$/, '').trim()
  const parts = t.split(',').map(p => p.trim()).filter(Boolean)
  if (!parts.length) return null
  return toStateAbbr(parts[parts.length - 1])
}

/**
 * The city named just before the state in an address line, or null.
 * Used only to repair a city field that holds something that is not a city.
 */
export function cityFromAddressLine(line: string | null | undefined): string | null {
  let t = String(line ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return null
  t = t.replace(/,\s*(USA|U\.S\.A\.|United States(\s+of\s+America)?)\s*$/i, '').trim()
  t = t.replace(/\s+\d{5}(-\d{4})?\s*$/, '').trim()
  const parts = t.split(',').map(p => p.trim()).filter(Boolean)
  if (parts.length < 2) return null
  // Only when the final token really is a state does the one before it read as
  // the city; otherwise the shape is unknown and this returns nothing.
  if (!toStateAbbr(parts[parts.length - 1])) return null
  const city = parts[parts.length - 2]
  return city && !/^\d/.test(city) ? tidyCityName(city) : null
}

/**
 * Cosmetic tidy-up of a city name: collapse whitespace and fix casing that is
 * obviously wrong ("boise", "Mckinney"). It does NOT rewrite one city's name to
 * another — "Brooklyn" stays "Brooklyn", because a borough is a real place and
 * folding it into "New York" would be a judgement about geography, not spelling.
 */
export function tidyCityName(raw: string | null | undefined): string | null {
  const t = String(raw ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return null
  // A short all-caps token is an initialism, not a mis-cased word — "SF" must
  // not become "Sf". Left exactly as found.
  if (t.length <= 3 && t === t.toUpperCase()) return t
  // Leave a name alone unless its casing is clearly off (all-lower or all-upper);
  // mixed case is assumed to be deliberate, which preserves "McKinney", "DeKalb".
  const isAllLower = t === t.toLowerCase()
  const isAllUpper = t === t.toUpperCase() && /[A-Z]{2,}/.test(t)
  if (!isAllLower && !isAllUpper) return t
  return t
    .toLowerCase()
    .split(' ')
    .map(w => (w.length > 2 && w.startsWith('mc') ? 'Mc' + w[2].toUpperCase() + w.slice(3) : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

export interface ResolvedPlace { city: string | null; state: string | null; location: string | null }

/**
 * The city/state/location a restaurant should display, given what FamilyMeal
 * holds. Pure — no I/O — so lib/restaurant-cache.ts can apply it on every sync
 * and a one-off backfill can apply the identical rule to existing rows.
 *
 * THE RULE, in order:
 *   1. state: the stored state if it names a US state, else read it off the
 *      address line. Anything else (a borough such as "Manhattan", a stray word)
 *      is discarded rather than displayed as a state.
 *   2. city: the stored city, tidied. If the stored city is itself a state
 *      abbreviation ("NY"), it is not a city at all — take the real city from
 *      the address line instead.
 *   3. location: "City, ST" when both are known, otherwise whichever exists.
 */
export function resolvePlace(input: {
  city?: string | null
  state?: string | null
  addressLine1?: string | null
  /** The label already on the row, used only so this can never LOSE one. */
  location?: string | null
}): ResolvedPlace {
  // The existing label is a last-resort source: 13 rows carry a populated
  // location with city and state both NULL, and without reading it back those
  // rows would normalise to nothing at all.
  const prior = splitLocation(input.location)

  const state = toStateAbbr(input.state)
    ?? stateFromAddressLine(input.addressLine1)
    ?? toStateAbbr(prior.state)

  let city = tidyCityName(input.city)
  // A city field holding "NY" is a state abbreviation filed in the wrong
  // column — 31 New York restaurants render as "NY, NY" purely because of it.
  //
  // ONLY a two-letter abbreviation counts. "New York" is both a city and a
  // state name, so testing it as a state would discard the correct city and
  // turn "New York, NY" into "NY" — which is exactly what an earlier version of
  // this rule did to 80 rows.
  if (city && city.length === 2 && US_STATE_ABBR.has(city.toUpperCase())) {
    city = cityFromAddressLine(input.addressLine1) ?? null
  }
  // A city beginning with a digit is a street address in the city column —
  // "5-43 48th Ave" rendered as the label for Little Chef Little Cafe, whose
  // address names Long Island City. Only a LEADING DIGIT counts as the signal:
  // matching street words instead would catch "Port St. Lucie", where "St." is
  // Saint and the city is perfectly correct.
  if (city && /^\d/.test(city)) {
    city = cityFromAddressLine(input.addressLine1) ?? city
  }
  if (!city) city = cityFromAddressLine(input.addressLine1) ?? tidyCityName(prior.city)

  const location = [city, state].filter(Boolean).join(', ') || null
  // Never return less than the row already had.
  if (!location && input.location) return { city: prior.city, state: prior.state, location: input.location }
  return { city: city ?? null, state: state ?? null, location }
}

/** Split an existing "City, ST" label back into parts. */
function splitLocation(loc: string | null | undefined): { city: string | null; state: string | null } {
  const t = String(loc ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return { city: null, state: null }
  const parts = t.split(',').map(p => p.trim()).filter(Boolean)
  if (parts.length >= 2) return { city: parts[0] || null, state: parts[parts.length - 1] || null }
  return { city: parts[0] || null, state: null }
}
