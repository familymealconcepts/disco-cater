/**
 * Rewrite legacy single-component delivery zones into the two-component shape,
 * VALUES UNCHANGED.
 *
 * NOT the same job as backfill-delivery-fees.ts. That script re-reads FM and rewrites
 * a menu only when its fee VALUES disagree with FM; it compares through its own
 * migrate-on-read, so a legacy row already holding the right $25 reads as "already
 * matches FM" and is left in the legacy shape. Run against the estate on 2026-08-27 it
 * reported 0 menus needing a change while 25 rows were still on feeType/feeValue. So
 * it cannot retire the legacy shape, by design.
 *
 * This script does only that: for every zone still carrying feeType/feeValue and no
 * feeFixed/feePercent, write the equivalent { radiusMiles, feeFixed, feePercent }.
 * Translation is lossless in the only direction that exists — a legacy row held
 * exactly one component, so it maps to that component plus a zero.
 *
 * WHY BOTHER, now that both read paths call parseTier. Because the NaN outage
 * (2026-08-27, 5 failed checkouts / 2 lost orders) happened when ONE new reader
 * touched this blob without knowing it needed translating. Every legacy row left in
 * the table is a live trap for the next reader. Normalising them means the compat
 * branch in parseTier can eventually be deleted rather than depended on forever.
 *
 * SAFE BY CONSTRUCTION: asserts that the fee computed for the row is bit-identical
 * before and after, at several subtotals, and skips any row where it is not.
 *
 *   npx tsx scripts/normalize-delivery-fee-shape.ts            # dry run (default)
 *   npx tsx scripts/normalize-delivery-fee-shape.ts --apply
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { computeOwnDeliveryFee, type DeliverySettings } from '../lib/menu-settings'

const APPLY = process.argv.includes('--apply')
const PROBE_SUBTOTALS = [0, 1, 100, 204.7, 1000, 12345.67]

const isLegacy = (t: unknown): boolean => {
  if (!t || typeof t !== 'object') return false
  const o = t as Record<string, unknown>
  return o.radiusMiles != null && o.feeFixed == null && o.feePercent == null
}

/** The exact translation parseTier performs, applied to the stored value. */
const translate = (t: unknown): Record<string, number> => {
  const o = t as Record<string, unknown>
  const radiusMiles = Math.max(0, Number(o.radiusMiles) || 0)
  const isPercent = String(o.feeType || 'FIXED').toUpperCase() === 'PERCENT'
  const v = Math.max(0, Number(o.feeValue) || 0)
  return { radiusMiles, feeFixed: isPercent ? 0 : v, feePercent: isPercent ? v : 0 }
}

interface Row { reference: string; name: string; restaurant: string; delivery_settings: DeliverySettings }

async function main() {
  const rows = (await sql`
    SELECT m.reference, m.name, c.name AS restaurant, m.delivery_settings
    FROM disco_menus m
    JOIN disco_restaurant_cache c ON c.restaurant_reference = m.restaurant_reference::text
    WHERE NOT m.archived AND m.delivery_settings IS NOT NULL
    ORDER BY c.name, m.position, m.id
  `) as unknown as Row[]

  let changed = 0, unchanged = 0, refused = 0
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — scanning ${rows.length} menus with delivery_settings\n`)

  for (const r of rows) {
    const del = r.delivery_settings
    const own = (del as { own?: { primary?: unknown; secondary?: unknown } }).own
    const legacyPrimary = isLegacy(own?.primary)
    const legacySecondary = isLegacy(own?.secondary)
    if (!legacyPrimary && !legacySecondary) { unchanged++; continue }

    const next: DeliverySettings = {
      ...del,
      own: {
        ...(own?.primary ? { primary: (legacyPrimary ? translate(own.primary) : own.primary) as never } : {}),
        ...(own?.secondary ? { secondary: (legacySecondary ? translate(own.secondary) : own.secondary) as never } : {}),
      },
    }

    // Equivalence proof: the fee the checkout would quote must be identical at every
    // probe subtotal AND at distances that land in each ring and past the outermost.
    const radii = [own?.primary, own?.secondary]
      .filter(Boolean)
      .map(t => Number((t as Record<string, unknown>).radiusMiles) || 0)
    const distances = [0, ...radii.flatMap(x => [Math.max(0, x - 0.01), x, x + 0.01]), Math.max(...radii, 0) + 50]
    const mismatches: string[] = []
    for (const st of PROBE_SUBTOTALS) {
      for (const d of distances) {
        const a = computeOwnDeliveryFee(own as DeliverySettings['own'], d, st)
        const b = computeOwnDeliveryFee(next.own, d, st)
        if (a.fee !== b.fee || a.serviceable !== b.serviceable) {
          mismatches.push(`subtotal=${st} dist=${d}: ${a.serviceable}/$${a.fee} → ${b.serviceable}/$${b.fee}`)
        }
      }
    }

    const label = `${r.restaurant} · "${r.name}"`
    if (mismatches.length) {
      refused++
      console.log(`   REFUSED  ${label}`)
      mismatches.slice(0, 3).forEach(m => console.log(`            ${m}`))
      continue
    }

    const show = (t: unknown) => t ? JSON.stringify(t) : '(none)'
    console.log(`   ${APPLY ? 'REWROTE ' : 'WOULD  '} ${label}`)
    console.log(`            primary   ${show(own?.primary)}`)
    console.log(`                   →  ${show(next.own?.primary)}`)
    if (own?.secondary) {
      console.log(`            secondary ${show(own.secondary)}`)
      console.log(`                   →  ${show(next.own?.secondary)}`)
    }

    if (APPLY) {
      await sql`
        UPDATE disco_menus SET delivery_settings = ${JSON.stringify(next)}::jsonb, updated_at = NOW()
        WHERE reference = ${r.reference}::uuid
      `
    }
    changed++
  }

  console.log(`\n=== summary ===`)
  console.log(`  ${APPLY ? 'rewritten' : 'would rewrite'} : ${changed}`)
  console.log(`  already new shape : ${unchanged}`)
  console.log(`  refused (fee would change) : ${refused}`)
  if (!APPLY && changed) console.log('\nRe-run with --apply to write.')
  process.exit(refused === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
