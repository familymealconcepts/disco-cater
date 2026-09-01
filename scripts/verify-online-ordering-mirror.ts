/**
 * DRY RUN of the FM → Neon online_ordering_enabled mirror.
 *
 * Reports exactly what mirrorOnlineOrderingFromFm() would write without
 * writing it, and asserts the invariants that make it safe to run:
 *   • no disco-native row is ever a target (Disco owns those post-conversion)
 *   • an FM value that is absent or non-boolean is skipped, never read as false
 *   • the true→false direction is enumerated in full, since it is the one that
 *     removes ordering at conversion
 *
 *   npx tsx scripts/verify-online-ordering-mirror.ts          # dry run
 *   npx tsx scripts/verify-online-ordering-mirror.ts --apply  # write
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { mirrorOnlineOrderingFromFm } from '../lib/online-ordering-mirror'

const APPLY = process.argv.includes('--apply')

async function main() {
  const r = await mirrorOnlineOrderingFromFm({ dryRun: !APPLY })

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — online_ordering_enabled mirror`)
  console.log(`   FM-backed rows compared      : ${r.comparable}`)
  console.log(`   already agreeing with FM     : ${r.matched}`)
  console.log(`   corrected                    : ${r.flipped}`)
  console.log(`   skipped, no usable FM value  : ${r.skippedNoFmValue}`)
  console.log(`   skipped, disco-native        : ${r.skippedNative}   (Disco owns these)`)
  console.log(`   elapsed                      : ${r.durationMs}ms`)

  const up = r.flips.filter(f => f.after === true)
  const down = r.flips.filter(f => f.after === false)
  console.log(`\n   false → true (the seed artifact, restores ordering at conversion): ${up.length}`)
  console.log(`   true → false (removes ordering at conversion)                     : ${down.length}`)

  console.log('\n   every true → false, in full:')
  for (const f of down) console.log(`      ${(f.name || f.restaurantReference).padEnd(38)} ${f.restaurantReference}`)

  // Invariant: nothing native may appear in the flip list.
  const refs = r.flips.map(f => f.restaurantReference)
  let nativeInFlips = 0
  if (refs.length) {
    const bad = (await sql`
      SELECT COUNT(*)::int AS n FROM disco_restaurant_cache
      WHERE restaurant_reference = ANY(${refs}::text[]) AND is_disco_native = true
    `) as { n: number }[]
    nativeInFlips = bad[0]?.n ?? 0
  }
  console.log(`\n   INVARIANT native rows among the corrections: ${nativeInFlips}  ${nativeInFlips === 0 ? 'PASS' : 'FAIL'}`)

  // The two Gracious locations, specifically.
  const gracious = (await sql`
    SELECT c.name, c.restaurant_reference, o.online_ordering_enabled,
           l.raw->>'onlineOrderingAllowed' AS fm
    FROM disco_restaurant_cache c
    JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
    LEFT JOIN disco_restaurant_admin_list_cache l ON l.restaurant_reference = c.restaurant_reference
    WHERE c.name ILIKE '%gracious%'
    ORDER BY c.name
  `) as { name: string; restaurant_reference: string; online_ordering_enabled: boolean | null; fm: string | null }[]
  console.log('\n   Gracious locations:')
  for (const g of gracious) console.log(`      ${g.name.padEnd(38)} neon=${String(g.online_ordering_enabled)}  fm=${g.fm ?? 'absent'}`)

  process.exit(nativeInFlips === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
