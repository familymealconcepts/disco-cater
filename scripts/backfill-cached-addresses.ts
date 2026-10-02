// Rewrite disco_restaurant_cache.address so each address appears once.
//
// The column was assembled as [addressLine1, city, state, zipcode].join(', ')
// while FM's addressLine1 is already a complete formatted address, so 4,200 of
// 4,207 rows repeat their own tail. lib/restaurant-cache.ts no longer composes
// it that way; this brings existing rows into line so every surface reading the
// column is correct immediately rather than at each restaurant's next sync.
//
// NEVER SHORTENS BELOW WHAT IS KNOWN. formatDisplayAddress only ever drops a
// field that is already present earlier in the string, so a row cannot lose
// information. The guard below refuses any row where the rewrite would drop a
// token that is not a duplicate or a country marker — that row is reported and
// left exactly as it is.
//
// Dry run by default. --apply writes.
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
import { formatDisplayAddress, dedupeAddressString } from '../lib/address-display'

const APPLY = process.argv.includes('--apply')
const COUNTRY_RE = /^(?:usa?|u\.s\.a?\.?|united states(?: of america)?)$/i
const tok = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)

async function main() {
  const rows = (await sql`
    SELECT restaurant_reference::text AS ref, name, address, address_line1, address_line2, city, state, zipcode
      FROM disco_restaurant_cache
     ORDER BY name
  `) as {
    ref: string; name: string | null; address: string | null
    address_line1: string | null; address_line2: string | null
    city: string | null; state: string | null; zipcode: string | null
  }[]

  let same = 0, changed = 0, refused = 0, blank = 0
  const samples: string[] = []
  const refusals: string[] = []

  for (const r of rows) {
    const next = formatDisplayAddress({
      addressLine1: r.address_line1, addressLine2: r.address_line2,
      city: r.city, state: r.state, zipcode: r.zipcode,
    })
    if (!next) {
      // Nothing to compose from — never blank a row that currently has a value.
      if ((r.address || '').trim()) blank++
      continue
    }
    if (next === (r.address || '')) { same++; continue }

    // A row whose stored address is empty or the literal string "null" can only
    // improve. 55 rows carry "null" because an earlier join stringified a null
    // part; anything composed from the structured columns beats that.
    const current = (r.address || '').trim()
    if (!current || current.toLowerCase() === 'null') {
      changed++
      if (samples.length < 8) samples.push(`  ${String(r.name).slice(0, 30).padEnd(32)}\n     was: ${r.address}\n     now: ${next}`)
      if (APPLY) await sql`UPDATE disco_restaurant_cache SET address = ${next} WHERE restaurant_reference = ${r.ref}`
      continue
    }

    // SAFETY: every significant token in the new value must already exist in the
    // old one, and every token DROPPED must be a duplicate or a country marker.
    const before = tok(r.address || '')
    const after = tok(next)
    const addedUnknown = after.filter(t => !before.includes(t))
    const counts = new Map<string, number>()
    for (const t of before) counts.set(t, (counts.get(t) ?? 0) + 1)
    for (const t of after) counts.set(t, (counts.get(t) ?? 0) - 1)
    const lostOutright = [...counts.entries()].filter(([t, n]) => n > 0 && !COUNTRY_RE.test(t) && !before.filter(x => x === t).slice(1).length).map(([t]) => t)
    if (addedUnknown.length || lostOutright.length) {
      // Recomposing would lose something — line1 does not carry the street for
      // this row. De-duplicate the stored string instead, which can only ever
      // remove a repeat.
      const deduped = dedupeAddressString(r.address)
      const dTok = tok(deduped)
      const dLost = [...new Set(before)].filter(t => !dTok.includes(t) && !COUNTRY_RE.test(t))
      if (deduped && deduped !== current && dLost.length === 0) {
        changed++
        if (samples.length < 8) samples.push(`  ${String(r.name).slice(0, 30).padEnd(32)} [deduped]\n     was: ${r.address}\n     now: ${deduped}`)
        if (APPLY) await sql`UPDATE disco_restaurant_cache SET address = ${deduped} WHERE restaurant_reference = ${r.ref}`
        continue
      }
      refused++
      if (refusals.length < 8) refusals.push(`${r.name}: "${r.address}" -> "${next}" (added ${addedUnknown.join(',') || '—'}, lost ${lostOutright.join(',') || '—'})`)
      continue
    }

    changed++
    if (samples.length < 8) samples.push(`  ${String(r.name).slice(0, 30).padEnd(32)}\n     was: ${r.address}\n     now: ${next}`)
    if (APPLY) {
      await sql`UPDATE disco_restaurant_cache SET address = ${next} WHERE restaurant_reference = ${r.ref}`
    }
  }

  console.log(`rows: ${rows.length}`)
  console.log(`  already correct            : ${same}`)
  console.log(`  rewritten                  : ${changed}`)
  console.log(`  refused (would lose data)  : ${refused}`)
  console.log(`  no parts to compose from   : ${blank} (left untouched)`)
  if (samples.length) { console.log('\nexamples:'); samples.forEach(s => console.log(s)) }
  if (refusals.length) { console.log('\nREFUSED — left exactly as they are:'); refusals.forEach(s => console.log(`  ${s}`)) }
  console.log(APPLY ? '\nwritten.' : '\nDRY RUN — re-run with --apply.')
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
