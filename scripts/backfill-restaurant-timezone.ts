/**
 * Fills disco_restaurant_cache.timezone where it is NULL.
 *
 * WHY IT MATTERS. Every scheduling rule is now evaluated on the restaurant's own
 * clock (17a7e31). A NULL timezone falls back to the RUNTIME's zone — the
 * customer's browser for the picker, UTC on Vercel for the placement gate —
 * which is exactly the defect that fix removed. These restaurants are still
 * living with it.
 *
 * THREE SOURCES, IN ORDER OF AUTHORITY. Nothing is guessed; anything that cannot
 * be resolved is reported for a human rather than filled with a default.
 *
 *  1. FM. `GET /public-api/restaurants/{ref}` carries a `timezone` field and it
 *     is the source lib/restaurant-cache.ts already uses. An FM-backed
 *     restaurant with a NULL here usually just has a stale cache row — De Nada
 *     is live, FM says America/Chicago, the cache said nothing.
 *
 *  2. The address's US state, for states that lie ENTIRELY in one zone. Exact
 *     for those; refused outright for the 15 that straddle (FL, ID, IN, KS, KY,
 *     MI, NE, ND, OR, SD, TN, TX, AK, NV, plus AZ's DST exception is noted but
 *     America/Phoenix is correct state-wide).
 *
 *  3. Nothing. Reported, not defaulted. A wrong timezone is worse than a missing
 *     one: it silently shifts a restaurant's whole booking calendar.
 *
 * Google was the obvious candidate for lat/lng → zone and is NOT available: the
 * project's Maps key has neither the Time Zone API nor the Geocoding API enabled
 * ("This API is not activated on your API project"). Mapbox geocoding does work
 * but has no timezone endpoint. If Google's Time Zone API is ever enabled, add
 * it as tier 2.5 for the straddling states, where lat/lng is the only exact
 * answer.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'

const APPLY = process.argv.includes('--apply')
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// States wholly inside one IANA zone. A state NOT in this map is refused.
const SINGLE_ZONE_STATE: Record<string, string> = {
  AL: 'America/Chicago',   AR: 'America/Chicago',   AZ: 'America/Phoenix',
  CA: 'America/Los_Angeles', CO: 'America/Denver',  CT: 'America/New_York',
  DC: 'America/New_York',  DE: 'America/New_York',  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',  IA: 'America/Chicago',   IL: 'America/Chicago',
  LA: 'America/Chicago',   MA: 'America/New_York',  MD: 'America/New_York',
  ME: 'America/New_York',  MN: 'America/Chicago',   MO: 'America/Chicago',
  MS: 'America/Chicago',   MT: 'America/Denver',    NC: 'America/New_York',
  NH: 'America/New_York',  NJ: 'America/New_York',  NM: 'America/Denver',
  NY: 'America/New_York',  OH: 'America/New_York',  OK: 'America/Chicago',
  PA: 'America/New_York',  RI: 'America/New_York',  SC: 'America/New_York',
  UT: 'America/Denver',    VA: 'America/New_York',  VT: 'America/New_York',
  WA: 'America/Los_Angeles', WI: 'America/Chicago', WV: 'America/New_York',
  WY: 'America/Denver',
}
// Straddle a zone boundary — lat/lng is the only exact answer, so refuse.
const MULTI_ZONE = new Set(['AK', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'NE', 'NV', 'ND', 'OR', 'SD', 'TN', 'TX'])

/** Last 2-letter US state token in a free-text address. */
function stateFromAddress(...parts: (string | null | undefined)[]): string | null {
  const text = parts.filter(Boolean).join(', ')
  const tokens = text.split(/[,\s]+/).map(t => t.trim().toUpperCase()).filter(t => /^[A-Z]{2}$/.test(t))
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (SINGLE_ZONE_STATE[tokens[i]] || MULTI_ZONE.has(tokens[i])) return tokens[i]
  }
  return null
}

interface Row { ref: string; name: string; address: string | null; city: string | null; state: string | null; live: boolean; native: boolean }

async function main() {
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — filling NULL timezones\n`)
  const rows = (await sql`
    SELECT restaurant_reference AS ref, name, address, city, state,
           COALESCE(is_live,false) AS live, COALESCE(is_disco_native,false) AS native
    FROM disco_restaurant_cache
    WHERE archived_at IS NULL AND (timezone IS NULL OR timezone = '')
    ORDER BY COALESCE(is_live,false) DESC, name
  `) as unknown as Row[]
  console.log(`${rows.length} restaurant(s) with no timezone (${rows.filter(r => r.live).length} live)\n`)

  const resolved: { row: Row; tz: string; via: string }[] = []
  const unresolved: { row: Row; why: string }[] = []

  for (const r of rows) {
    // 1. FM — authoritative, and the source the cache refresh already uses.
    let tz: string | null = null
    let via = ''
    try {
      const d = await (await fetch(`${FM}/public-api/restaurants/${r.ref}`, { headers: { Accept: 'application/json' } })).json() as Record<string, unknown>
      const t = typeof d?.timezone === 'string' ? d.timezone.trim() : ''
      if (t) { tz = t; via = 'FM' }
    } catch { /* fall through */ }

    // 2. Single-zone US state.
    if (!tz) {
      const st = r.state?.trim().toUpperCase() || stateFromAddress(r.address, r.city)
      if (st && SINGLE_ZONE_STATE[st]) { tz = SINGLE_ZONE_STATE[st]; via = `state:${st}` }
      else if (st && MULTI_ZONE.has(st)) { unresolved.push({ row: r, why: `${st} straddles a zone boundary — needs lat/lng` }); continue }
      else if (!st) { unresolved.push({ row: r, why: r.address ? 'no US state found in the address' : 'no address on record' }); continue }
    }

    if (tz) resolved.push({ row: r, tz, via })
  }

  const show = (list: typeof resolved) => list.forEach(x =>
    console.log(`   ${x.row.live ? 'LIVE' : '    '} ${String(x.row.name).slice(0, 34).padEnd(34)} → ${x.tz.padEnd(20)} via ${x.via}`))

  console.log(`── RESOLVED (${resolved.length}) ──`)
  show(resolved.filter(x => x.row.live))
  const notLive = resolved.filter(x => !x.row.live)
  if (notLive.length) { console.log(`   … and ${notLive.length} not-live restaurant(s)`); show(notLive.slice(0, 8)) }

  console.log(`\n── UNRESOLVED (${unresolved.length}) — left NULL on purpose ──`)
  unresolved.filter(u => u.row.live).forEach(u => console.log(`   LIVE ${String(u.row.name).slice(0, 34).padEnd(34)} ${u.why}`))
  const nlU = unresolved.filter(u => !u.row.live).length
  if (nlU) console.log(`   … and ${nlU} not-live restaurant(s)`)

  if (APPLY && resolved.length) {
    await sql.transaction(resolved.map(x => sql`
      UPDATE disco_restaurant_cache SET timezone = ${x.tz}
      WHERE restaurant_reference = ${x.row.ref} AND (timezone IS NULL OR timezone = '')
    `))
    const after = (await sql`
      SELECT count(*)::int AS n FROM disco_restaurant_cache
      WHERE archived_at IS NULL AND (timezone IS NULL OR timezone = '')
    `) as unknown as { n: number }[]
    const afterLive = (await sql`
      SELECT count(*)::int AS n FROM disco_restaurant_cache
      WHERE archived_at IS NULL AND is_live AND (timezone IS NULL OR timezone = '')
    `) as unknown as { n: number }[]
    console.log(`\nWrote ${resolved.length}. Still NULL: ${after[0].n} (${afterLive[0].n} live).`)
  }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
