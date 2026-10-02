import { stateFullName } from './us-states'

// Display-only formatting for a cached restaurant address.
//
// WHY THIS EXISTS. disco_restaurant_cache.address is assembled by
// lib/restaurant-cache.ts as [addressLine1, city, state, zipcode].join(', '),
// but FM's addressLine1 is ITSELF an already-formatted address ending ", USA".
// So the stored column repeats its own tail:
//
//   "6115 Peachtree Dunwoody Rd NE, Sandy Springs, GA 30328, USA, Sandy Springs, GA, 30328"
//
// The stored value is NOT changed — other consumers read that column, and the
// grouping/parse path depends on the tail still being there. This is the render
// step only.
//
// APPROACH. addressLine1 is the authoritative single copy: measured across all
// 86 native multi-unit members, every one carries a complete "street, city,
// ST zip" and 85 of 86 end in a country field. So the display is line1 (+line2)
// with country fields dropped. The structured city/state/zip columns are used
// ONLY to fill a gap when line1 is absent or has no state/zip tail — never
// appended on top of a line1 that already carries them, which is the bug.
//
// This also beats composing from the columns outright: ~20 cache rows hold a
// NYC borough in `state` ("QUEENS", "Brooklyn"), so a composed string would
// read "Queens, QUEENS, 11375". Binge Biryani's line1 says "Flushing, NY 11375"
// — correct, and already there.

const COUNTRY_RE = /^(?:usa?|u\.s\.a?\.?|united states(?: of america)?)$/i
const STATE_ZIP_RE = /^([A-Za-z]{2})\s+\d{5}(?:-\d{4})?$/

// Comma fields, trimmed, blanks and country markers removed.
function fieldsOf(value: string | null | undefined): string[] {
  return (value || '')
    .split(',')
    .map(f => f.trim())
    .filter(Boolean)
    .filter(f => !COUNTRY_RE.test(f))
}

export interface AddressParts {
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  state?: string | null
  zipcode?: string | null
}

export function formatDisplayAddress(p: AddressParts): string {
  const line1Fields = fieldsOf(p.addressLine1)
  const fields = [...line1Fields, ...fieldsOf(p.addressLine2)]

  // ── COMPLETENESS IS A PROPERTY OF LINE 1, NOT OF THE JOINED STRING ────────
  // This used to test the LAST field of line1+line2 together. A unit number in
  // address_line2 ("#1158", "STE 1015", "na") then sat after line1's own
  // "NC 27520", so the tail was no longer last, the address read as incomplete,
  // and the state and zip were appended a second time:
  //
  //   "921 Town Centre Blvd, Clayton, NC 27520, #1158, NC 27520"
  //
  // Five rows did this. Line1 is the field that either carries its own tail or
  // does not, so that is what is tested.
  // ANY field, not just the last. Checking only the final field made the
  // function sensitive to what came after the tail — a unit number in line2, or
  // a previously-composed address fed back in as line1 — and in both cases it
  // concluded "incomplete" and appended the state and zip a second time.
  // Matching on whole comma fields (never substrings) and requiring a real US
  // state abbreviation keeps this from firing on a street.
  const complete = line1Fields.some(f => {
    const m = STATE_ZIP_RE.exec(f)
    return !!m && !!stateFullName(m[1])
  })

  if (!complete) {
    const lower = fields.map(f => f.toLowerCase())
    const city = (p.city || '').trim()
    if (city && !lower.includes(city.toLowerCase())) fields.push(city)

    // A borough in `state` is not a state and must not be printed as one.
    const raw = (p.state || '').trim()
    const full = stateFullName(raw)
    const st = full ? (raw.length === 2 ? raw.toUpperCase() : full) : ''
    const zip = (p.zipcode || '').trim()
    const tail = [st, zip].filter(v => v && !lower.includes(v.toLowerCase()))
    if (tail.length) fields.push(tail.join(' '))
  }

  return fields.join(', ')
}

/**
 * De-duplicate an already-composed address string.
 *
 * ── WHY THIS EXISTS ALONGSIDE formatDisplayAddress ──────────────────────────
 * formatDisplayAddress rebuilds the address from addressLine1 + the structured
 * columns, which is the right answer when line1 carries the street. For 121
 * cached rows it does not — line1 is null or holds only a locality — so
 * recomposing would DROP the street that the stored `address` still has
 * ("719 Central Avenue, Westfield, NJ, 07090" -> "Westfield, NJ").
 *
 * For those, the stored string is the only complete copy, and the repair is to
 * remove the repetition rather than rebuild. A field is dropped when an earlier
 * field already said it:
 *
 *   "200 Clinton St, Brooklyn, NY 11201, USA, Brooklyn, Brooklyn, 11201"
 *     -> "200 Clinton St, Brooklyn, NY 11201"
 *
 * ORDER IS PRESERVED and the FIRST occurrence always wins, so the street can
 * never be the thing removed. A field is a duplicate when its own words are
 * already covered by the fields before it — which catches "Brooklyn" against
 * "Brooklyn", "NY" and "11201" against "NY 11201", and "New Jersey" against a
 * preceding "NJ" only when spelled the same (a state NAME following its own
 * abbreviation is left alone rather than guessed at).
 */
export function dedupeAddressString(value: string | null | undefined): string {
  const fields = (value || '').split(',').map(f => f.trim()).filter(Boolean)
  const kept: string[] = []
  const seenWords = new Set<string>()
  for (const f of fields) {
    if (COUNTRY_RE.test(f)) continue
    const words = f.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
    if (!words.length) continue
    // Every word of this field already said earlier → it adds nothing.
    if (words.every(w => seenWords.has(w))) continue
    kept.push(f)
    words.forEach(w => seenWords.add(w))
  }
  return kept.join(', ')
}
