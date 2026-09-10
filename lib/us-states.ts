// US state abbreviation → full name, matching FM's StateUtil.getNameByAbbreviation
// (multi-unit "locations" pages group + sort by full state name). Also parses the
// 2-letter state out of a cached address string ("…, City, ST 12345").

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}
const FULL_NAMES = new Set(Object.values(STATE_NAMES).map(s => s.toLowerCase()))

// Full state name from an abbreviation OR an already-full name; '' when unknown.
export function stateFullName(input: string | null | undefined): string {
  const v = (input || '').trim()
  if (!v) return ''
  const up = v.toUpperCase()
  if (STATE_NAMES[up]) return STATE_NAMES[up]
  // Lower-case FIRST. Without it "NEW JERSEY" came back "NEW JERSEY" (the
  // \b\w pass only re-uppercases letters that are already capital), so a
  // shouty row formed its OWN heading alongside the "New Jersey" rows — the
  // same state rendered twice on one page.
  if (FULL_NAMES.has(v.toLowerCase())) return v.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
  return ''
}

// Extract the state from a US address string, POSITIONALLY.
//
// This must never scan free text. The cache's `address` is built by
// lib/restaurant-cache.ts as [addressLine1, city, state, zipcode].join(', '),
// and FM's addressLine1 is itself already a full formatted address ending in
// ", USA" — so a real row looks like:
//
//   "1 W Ct Square, Decatur, GA 30030, USA, Decatur, GA, 30030"
//
// It ends in a bare ZIP, so an anchored ", ST 12345$" match fails and the old
// implementation fell through to scanning every whitespace/comma token for
// anything two letters long. That read "Ct" out of "W Ct Square" as Connecticut
// and "NE" out of "Dunwoody Rd NE" as Nebraska, and put two Georgia bakeries
// under CONNECTICUT and NEBRASKA on a customer-facing page.
//
// So: split on commas and walk the fields from the END, accepting a field only
// when the WHOLE field is a state ("GA"), a state plus its ZIP ("GA 30030"), or
// a full state name ("Georgia"). ZIP-only and country fields are stepped over;
// anything else (street lines, city names, suite numbers) can never match,
// because a state abbreviation buried inside a longer field is not a state.
const ZIP_RE = /^\d{5}(?:-\d{4})?$/
const COUNTRY_RE = /^(?:usa?|u\.s\.a?\.?|united states(?: of america)?)$/i

export function stateFromAddress(address: string | null | undefined): string {
  const a = (address || '').trim()
  if (!a) return ''
  const fields = a.split(',').map(f => f.trim()).filter(Boolean)
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i]
    if (ZIP_RE.test(f) || COUNTRY_RE.test(f)) continue // trailing "…, USA, …, 30030"
    const withZip = f.match(/^([A-Za-z]{2})\s+\d{5}(?:-\d{4})?$/) // "GA 30030"
    if (withZip) { const full = stateFullName(withZip[1]); if (full) return full }
    const bare = stateFullName(f) // "GA" or "Georgia" — whole field only
    if (bare) return bare
  }
  return ''
}
