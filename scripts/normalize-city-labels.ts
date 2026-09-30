/**
 * One-off backfill of disco_restaurant_cache city/state/location to the rule in
 * lib/geo/us-state-from-address.ts.
 *
 * The same rule now runs inside lib/restaurant-cache.ts's normalize(), so the
 * daily sync keeps producing these values rather than reverting them. This exists
 * only to correct the rows already stored, without waiting a day.
 *
 *   npx tsx -r dotenv/config scripts/normalize-city-labels.ts dotenv_config_path=.env.local [--apply]
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'
import { resolvePlace } from '../lib/geo/us-state-from-address'

async function main() {
  const apply = process.argv.includes('--apply')
  const rows = (await sql`
    SELECT restaurant_reference::text AS ref, name, city, state, address_line1, location
    FROM disco_restaurant_cache WHERE archived_at IS NULL
  `) as { ref: string; name: string; city: string | null; state: string | null; address_line1: string | null; location: string | null }[]

  const updates: { ref: string; city: string | null; state: string | null; location: string | null }[] = []
  let lost = 0
  for (const r of rows) {
    const p = resolvePlace({ city: r.city, state: r.state, addressLine1: r.address_line1, location: r.location })
    if ((p.location ?? '') === (r.location ?? '') && (p.city ?? '') === (r.city ?? '') && (p.state ?? '') === (r.state ?? '')) continue
    // A backfill must never blank a label that exists.
    if (r.location && !p.location) { lost++; continue }
    updates.push({ ref: r.ref, city: p.city, state: p.state, location: p.location })
  }

  console.log(`rows ${rows.length} | to update ${updates.length} | refused (would have blanked a label) ${lost}`)
  if (!apply) { console.log('\nDRY RUN — pass --apply to write.'); return }

  let done = 0
  const CHUNK = 100
  for (let i = 0; i < updates.length; i += CHUNK) {
    await Promise.all(updates.slice(i, i + CHUNK).map(u => sql`
      UPDATE disco_restaurant_cache
      SET city = ${u.city}, state = ${u.state}, location = ${u.location}
      WHERE restaurant_reference = ${u.ref}
    `))
    done += Math.min(CHUNK, updates.length - i)
    if (done % 1000 === 0 || done === updates.length) console.log(`  ${done}/${updates.length}`)
  }
  console.log(`updated ${done}`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
