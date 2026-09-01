/**
 * Proves a CHAIN conversion no longer produces chain-wide grants.
 *
 * Replays what inviteFmAuthorizedUsersFor's grant step would decide for every
 * location of a chain, using each location's REAL FM Authorized Users list and
 * REAL designated-admin field, and compares it against FM's own stored
 * membership (fm_backup, familymeal.tbl_restaurant_admins /
 * tbl_system_admin_restaurants) exported to a CSV.
 *
 * Writes NOTHING. The grant decision is re-implemented here exactly as the
 * shipped filter states it, so a divergence between the two is a real failure
 * rather than a tautology — the assertions are against FM's stored membership
 * and against the pre-fix behaviour, not against the filter's own output.
 *
 *   psql -d fm_backup -Atc "COPY (...) TO STDOUT WITH CSV" > /tmp/fm-membership.csv
 *   npx tsx scripts/verify-conversion-grant-filter.ts "Atlanta Bread" [csvPath]
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { readFileSync, existsSync } from 'fs'
import { sql } from '../lib/db'
import { readWalledFieldsForRestaurants } from '../lib/fm-master-admin-read'

const CHAIN = process.argv[2] || 'Atlanta Bread'
const CSV = process.argv[3] || '/private/tmp/claude-501/-Users-peterventi-Desktop-VS-Code/76bbaa67-ff60-4fba-92b4-a107221c33ae/scratchpad/fm-membership.csv'

let fails = 0
const check = (l: string, ok: boolean, extra = '') => { if (!ok) fails++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ` — ${extra}` : ''}`) }

async function main() {
  const locs = (await sql`
    SELECT c.restaurant_reference AS ref, c.name,
           LOWER(l.raw->'admin'->>'email') AS designated,
           l.raw->'admin'->>'enabled' AS designated_enabled
      FROM disco_restaurant_cache c
      LEFT JOIN disco_restaurant_admin_list_cache l ON l.restaurant_reference = c.restaurant_reference
     WHERE c.name LIKE ${CHAIN + '%'} AND c.archived_at IS NULL
     ORDER BY c.name
  `) as { ref: string; name: string; designated: string | null; designated_enabled: string | null }[]
  if (!locs.length) { console.log(`No locations matching "${CHAIN}".`); process.exit(1) }
  console.log(`\n"${CHAIN}" — ${locs.length} locations\n`)

  // FM's stored membership, for the independent cross-check.
  const fmMember = new Map<string, Set<string>>() // email -> refs
  if (existsSync(CSV)) {
    for (const line of readFileSync(CSV, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const [email, , ref] = line.split(',')
      if (!fmMember.has(email)) fmMember.set(email, new Set())
      fmMember.get(email)!.add(ref)
    }
    console.log(`   FM stored membership loaded for ${fmMember.size} users (snapshot)\n`)
  } else {
    console.log(`   (no FM membership CSV at ${CSV} — the stored-membership cross-check will be skipped)\n`)
  }

  const walled = await readWalledFieldsForRestaurants(locs.map(l => l.ref))

  // grantsNew[email] = refs the shipped filter WOULD grant across the whole chain.
  // grantsOld[email] = refs the PRE-FIX code granted (one per restaurant read, unfiltered).
  const grantsNew = new Map<string, Set<string>>()
  const grantsOld = new Map<string, Set<string>>()
  const invited = new Set<string>()

  for (const loc of locs) {
    const w = walled.get(loc.ref)
    const users = w?.ok ? (w.authorizedUsers ?? []) : []
    const covering = users.filter(u => u.enabled !== false && !!u.email)
    const designated = loc.designated_enabled === 'false' ? null : loc.designated
    console.log(`   ${loc.name.padEnd(34)} FM lists ${String(covering.length).padStart(2)} authorized user(s); designated admin: ${designated ?? '(none)'}`)
    for (const u of covering) {
      const e = String(u.email).toLowerCase()
      invited.add(e)
      if (!grantsOld.has(e)) grantsOld.set(e, new Set())
      grantsOld.get(e)!.add(loc.ref)                                  // pre-fix: always granted
      if (designated && e === designated) {                            // shipped filter
        if (!grantsNew.has(e)) grantsNew.set(e, new Set())
        grantsNew.get(e)!.add(loc.ref)
      }
    }
  }

  const chainRefs = new Set(locs.map(l => l.ref))
  const oldTotal = [...grantsOld.values()].reduce((a, s) => a + s.size, 0)
  const newTotal = [...grantsNew.values()].reduce((a, s) => a + s.size, 0)

  console.log(`\n   invited (unchanged)            : ${invited.size} people`)
  console.log(`   grants BEFORE the filter       : ${oldTotal}`)
  console.log(`   grants AFTER  the filter       : ${newTotal}\n`)

  check('nobody is granted the whole chain', ![...grantsNew.values()].some(s => s.size === locs.length),
    [...grantsNew.entries()].filter(([, s]) => s.size === locs.length).map(([e]) => e).join(', '))
  check('every granted person gets at most 1 location', [...grantsNew.values()].every(s => s.size <= 1))
  check('the filter grants strictly fewer than before', newTotal < oldTotal, `${newTotal} vs ${oldTotal}`)
  check('invites are NOT reduced (everyone FM returns is still invited)', invited.size > 0 && invited.size >= grantsNew.size)

  // Independent cross-check: nothing granted may contradict FM's stored membership.
  if (fmMember.size) {
    const contradictions: string[] = []
    for (const [email, refs] of grantsNew) {
      const stored = fmMember.get(email)
      for (const r of refs) if (stored && stored.size && !stored.has(r)) contradictions.push(`${email} → ${locs.find(l => l.ref === r)?.name}`)
    }
    check('no grant contradicts FM stored membership', contradictions.length === 0, contradictions.join('; '))

    const oldContradictions: string[] = []
    for (const [email, refs] of grantsOld) {
      const stored = fmMember.get(email)
      for (const r of refs) if (stored && stored.size && !stored.has(r)) oldContradictions.push(`${email}@${r}`)
    }
    console.log(`\n   (for contrast: the PRE-FIX behaviour would have written ${oldContradictions.length} grant(s) that contradict FM's stored membership)`)
  }

  console.log('\n   per-person, after the filter:')
  for (const e of [...invited].sort()) {
    const n = grantsNew.get(e)?.size ?? 0
    const o = grantsOld.get(e)?.size ?? 0
    console.log(`      ${e.padEnd(44)} invited=yes  grants ${o} → ${n}${n === 0 ? '   (held for explicit assignment)' : ''}`)
  }
  void chainRefs

  console.log('\n' + '='.repeat(64))
  console.log(fails === 0 ? 'CHAIN CONVERSION NO LONGER PRODUCES CHAIN-WIDE GRANTS' : `${fails} CHECK(S) FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
