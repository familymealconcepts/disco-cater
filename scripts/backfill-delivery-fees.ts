/**
 * Re-read FM's authoritative self-delivery fee values into Disco's two-component
 * DeliveryTier.
 *
 * DRY RUN BY DEFAULT. Writing requires --apply, and that flag is deliberately
 * not something a careless invocation can trip: without it this only prints a
 * diff.
 *
 *   npx tsx scripts/backfill-delivery-fees.ts                 # diff only
 *   npx tsx scripts/backfill-delivery-fees.ts --apply         # writes
 *   npx tsx scripts/backfill-delivery-fees.ts --ref <uuid>    # one restaurant
 *
 * WHY THIS IS A RE-READ AND NOT A RECONSTRUCTION. FM stays live after
 * conversion, so it still holds the original six fields per menu
 * (ownDeliveryFee / ownDeliveryFeePercent / ownDeliveryRadius and the secondary
 * triplet). Nothing was lost when the faithful importer collapsed them to one
 * component — it just didn't carry both across. So the correct values are
 * readable, not inferable.
 *
 * NAME-MATCHING IS THE ONLY JOIN, AND IT IS THE RISK. FM's admin and customer
 * menu objects are different records with different references, names and types
 * and no shared key (the faithful importer's own header documents this), so
 * there is no id to join on: Disco's stored menu reference is Disco's own. This
 * script therefore matches on trimmed, case-folded name and reports every match
 * with its confidence. An unmatched or ambiguous menu is SKIPPED and listed, not
 * guessed at.
 *
 * THE ZERO-RADIUS CASE IS PRESERVED, NOT NORMALISED. FM only consults a
 * secondary zone when `secondaryRadius > primaryRadius` (see
 * PriceCalculateService.calculateOwnDeliveryFee), so Hugo's "Summer" menu, whose
 * secondaryOwnDeliveryRadius is 0, has an INERT secondary zone: FM charges the
 * primary fee at any distance. Writing that 0 into Disco as a real zone would
 * invent a zone FM does not honour, and Disco's own serviceability rule would
 * then refuse deliveries FM accepts. Such zones are dropped, and flagged.
 */
import { neon } from '@neondatabase/serverless'
import { getFmServiceAuthHeader } from '../lib/fm-service-auth'

const sql = neon(process.env.DATABASE_URL!)
const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const APPLY = process.argv.includes('--apply')
const ONLY_REF = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : null

const num = (v: unknown): number => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
const r2 = (x: number) => Math.round(x * 100) / 100

interface Zone { radiusMiles: number; feeFixed: number; feePercent: number }
/** Read a stored tier through the same migrate-on-read rule parseTier uses. */
function currentZone(t: Record<string, unknown> | undefined): Zone | null {
  if (!t || t.radiusMiles == null) return null
  const hasNew = t.feeFixed != null || t.feePercent != null
  const isPct = String(t.feeType ?? '').toUpperCase() === 'PERCENT'
  return {
    radiusMiles: num(t.radiusMiles),
    feeFixed: hasNew ? num(t.feeFixed) : (isPct ? 0 : num(t.feeValue)),
    feePercent: hasNew ? num(t.feePercent) : (isPct ? num(t.feeValue) : 0),
  }
}
const fmt = (z: Zone | null) => z ? `r=${z.radiusMiles}mi $${z.feeFixed.toFixed(2)} + ${z.feePercent}%` : '(none)'
const same = (a: Zone | null, b: Zone | null) =>
  (!a && !b) || (!!a && !!b && a.radiusMiles === b.radiusMiles && r2(a.feeFixed) === r2(b.feeFixed) && r2(a.feePercent) === r2(b.feePercent))

async function main() {
  const auth = await getFmServiceAuthHeader()
  const menus = (await sql`
    SELECT m.reference, m.restaurant_reference ref, m.name, m.delivery_settings ds, c.name rest
    FROM disco_menus m LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference::text = m.restaurant_reference::text
    WHERE m.delivery_settings IS NOT NULL AND (m.delivery_settings->>'method') = 'OWN_DELIVERY'
    ORDER BY c.name, m.name
  `) as Record<string, unknown>[]
  const refs = [...new Set(menus.map(m => String(m.ref)))].filter(r => !ONLY_REF || r === ONLY_REF)

  console.log(`${APPLY ? '*** APPLY MODE — THIS WILL WRITE ***' : 'DRY RUN — nothing will be written'}`)
  console.log(`${menus.length} OWN_DELIVERY menus across ${refs.length} restaurants\n`)

  let changed = 0, identical = 0, unmatched = 0, inertDropped = 0
  const writes: { reference: string; own: { primary?: Zone; secondary?: Zone } }[] = []

  for (const ref of refs) {
    const res = await fetch(`${FM}/api/admin/menu?restaurantReference=${ref}&page=0&size=200`, { headers: { ...auth, Accept: 'application/json' } })
    if (!res.ok) { console.log(`!! ${ref}: FM HTTP ${res.status} — SKIPPED (cannot read authoritative values)`); continue }
    const j = await res.json() as Record<string, unknown>
    const fmMenus = (j.content ?? j.data ?? (Array.isArray(j) ? j : [])) as Record<string, unknown>[]
    const mine = menus.filter(m => String(m.ref) === ref)
    const restName = String(mine[0]?.rest ?? ref)
    console.log(`── ${restName}`)

    for (const dm of mine) {
      const candidates = fmMenus.filter(f => norm(f.name) === norm(dm.name))
      if (candidates.length !== 1) {
        unmatched++
        console.log(`   ?? "${dm.name}" — ${candidates.length === 0 ? 'NO FM menu with this name' : `${candidates.length} FM menus share this name`} — SKIPPED`)
        console.log(`      FM names available: ${fmMenus.map(f => `"${f.name}"`).join(', ') || '(none)'}`)
        continue
      }
      const s = (candidates[0].settings ?? {}) as Record<string, unknown>
      const ds = (dm.ds ?? {}) as Record<string, unknown>
      const own = (ds.own ?? {}) as Record<string, unknown>

      const fmPrimary: Zone | null = s.ownDeliveryRadius == null ? null
        : { radiusMiles: num(s.ownDeliveryRadius), feeFixed: num(s.ownDeliveryFee), feePercent: num(s.ownDeliveryFeePercent) }
      // FM's own guard: an inert secondary zone must not become a real one.
      const secRadius = num(s.secondaryOwnDeliveryRadius)
      const secInert = s.secondaryOwnDeliveryRadius == null || fmPrimary == null || secRadius <= fmPrimary.radiusMiles
      const fmSecondary: Zone | null = secInert ? null
        : { radiusMiles: secRadius, feeFixed: num(s.secondaryOwnDeliveryFee), feePercent: num(s.secondaryOwnDeliveryFeePercent) }
      if (s.secondaryOwnDeliveryRadius != null && secInert) {
        inertDropped++
        console.log(`   .. "${dm.name}" secondary zone INERT in FM (radius ${secRadius} <= primary ${fmPrimary?.radiusMiles ?? '?'}) — dropped, per FM's own guard`)
      }

      const curPrimary = currentZone(own.primary as Record<string, unknown>)
      const curSecondary = currentZone(own.secondary as Record<string, unknown>)
      const diffP = !same(curPrimary, fmPrimary), diffS = !same(curSecondary, fmSecondary)
      if (!diffP && !diffS) { identical++; console.log(`   == "${dm.name}" already matches FM`); continue }
      changed++
      console.log(`   ~~ "${dm.name}"`)
      if (diffP) console.log(`        primary   Disco ${fmt(curPrimary)}   ->   FM ${fmt(fmPrimary)}`)
      if (diffS) console.log(`        secondary Disco ${fmt(curSecondary)}   ->   FM ${fmt(fmSecondary)}`)
      writes.push({ reference: String(dm.reference), own: { ...(fmPrimary ? { primary: fmPrimary } : {}), ...(fmSecondary ? { secondary: fmSecondary } : {}) } })
    }
  }

  console.log(`\n=== summary ===`)
  console.log(`  menus needing a change : ${changed}`)
  console.log(`  already matching FM    : ${identical}`)
  console.log(`  skipped, name unmatched: ${unmatched}`)
  console.log(`  inert secondary zones dropped: ${inertDropped}`)

  if (!APPLY) { console.log(`\nDRY RUN — no writes. Re-run with --apply to write the ${writes.length} menu(s) above.`); return }
  for (const w of writes) {
    await sql`
      UPDATE disco_menus
      SET delivery_settings = jsonb_set(delivery_settings, '{own}', ${JSON.stringify(w.own)}::jsonb, true),
          updated_at = NOW()
      WHERE reference = ${w.reference}::uuid
    `
  }
  console.log(`\nwrote ${writes.length} menu(s).`)
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
