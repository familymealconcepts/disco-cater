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
  if (FULL_NAMES.has(v.toLowerCase())) return v.replace(/\b\w/g, c => c.toUpperCase())
  return ''
}

// Best-effort extract the state from a US address string. Handles the common
// "line1, City, ST 12345" and "City, ST" shapes; returns the full state name.
export function stateFromAddress(address: string | null | undefined): string {
  const a = (address || '').trim()
  if (!a) return ''
  // "..., ST 12345" or "..., ST" near the end.
  const m = a.match(/,\s*([A-Za-z]{2})\s*(?:\d{5}(?:-\d{4})?)?\s*(?:,\s*USA?)?\s*$/)
  if (m) { const full = stateFullName(m[1]); if (full) return full }
  // Fallback: any token that is a known 2-letter state, or a full state name substring.
  for (const tok of a.split(/[\s,]+/)) { const full = stateFullName(tok); if (full && tok.length === 2) return full }
  for (const name of Object.values(STATE_NAMES)) { if (a.toLowerCase().includes(name.toLowerCase())) return name }
  return ''
}
