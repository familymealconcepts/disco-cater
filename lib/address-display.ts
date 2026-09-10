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
  const fields = [...fieldsOf(p.addressLine1), ...fieldsOf(p.addressLine2)]

  // Does line1 already end in its own "ST 12345"? If so it is complete and
  // nothing from the columns may be appended.
  const last = fields[fields.length - 1] || ''
  const m = STATE_ZIP_RE.exec(last)
  const complete = !!m && !!stateFullName(m[1])

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
