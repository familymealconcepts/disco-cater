/**
 * REPORT ONLY — changes nothing.
 *
 * Every converted (Disco-native) restaurant, every menu item, Disco's price vs
 * FamilyMeal's. Reads Neon (disco_menu_items) and FamilyMeal's PUBLIC menu
 * endpoints (menu -> categories -> mealPackages), the same traversal the
 * customer page and bulk-pricing search use.
 *
 *   npx tsx scripts/price-divergence-report.ts > /tmp/divergence.txt
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const CONCURRENCY = 6

const j = async <T>(u: string): Promise<T | null> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(FM + u, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      if (r.ok) return (await r.json()) as T
      if (r.status === 404) return null
    } catch { /* retry once */ }
  }
  return null
}

interface Loc { ref: string; name: string; convertedAt: string | null }
interface Div {
  restaurant: string; ref: string; item: string
  disco: number; fm: number; diff: number
  discoUpdated: string | null; discoCreated: string | null
  fmUpdated: string | null
  convertedAt: string | null
}

async function main() {
  const locs = (await sql`
    SELECT c.restaurant_reference::text AS ref, c.name,
           (SELECT MIN(e.created_at) FROM disco_order_events e WHERE false) AS unused,
           ov.updated_at AS converted_at
      FROM disco_restaurant_cache c
      JOIN disco_restaurant_overrides ov ON ov.restaurant_reference = c.restaurant_reference
     WHERE c.is_disco_native = true AND c.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM disco_menu_items i WHERE i.restaurant_reference::text = c.restaurant_reference)
     ORDER BY c.name
  `) as Array<{ ref: string; name: string; converted_at: string | Date | null }>

  const list: Loc[] = locs.map(l => ({ ref: l.ref, name: l.name, convertedAt: l.converted_at ? String(l.converted_at).slice(0, 19) : null }))
  console.error(`comparing ${list.length} converted restaurants with a native menu…`)

  const divergences: Div[] = []
  let compared = 0, noFmMenu = 0, checked = 0, onlyInDisco = 0, onlyInFm = 0
  const noFmMenuNames: string[] = []

  let idx = 0
  async function worker() {
    for (;;) {
      const i = idx++
      if (i >= list.length) return
      const loc = list[i]
      const neon = (await sql`
        SELECT LOWER(name) AS n, name AS raw_name, price::float8 AS price, updated_at, created_at
          FROM disco_menu_items WHERE restaurant_reference::text = ${loc.ref}
      `) as Array<{ n: string; raw_name: string; price: number; updated_at: string | Date | null; created_at: string | Date | null }>
      // A restaurant can carry the SAME item name on several menus at different
      // prices (Francesca has 237 items across menus). Keying by name and taking
      // one row reports a divergence whenever the arbitrary winner disagrees,
      // which is a false positive. Collect EVERY Disco price for a name, and
      // count it as a divergence only when FamilyMeal's price matches NONE of
      // them — then report the closest one, which is the real gap.
      const byName = new Map<string, typeof neon>()
      for (const r of neon) {
        if (!byName.has(r.n)) byName.set(r.n, [])
        byName.get(r.n)!.push(r)
      }

      const menus = await j<Array<{ reference: string }>>(`/public-api/menu?restaurantReference=${loc.ref}`)
      if (!Array.isArray(menus) || !menus.length) { noFmMenu++; noFmMenuNames.push(loc.name); continue }
      checked++

      const seenFm = new Set<string>()
      for (const m of menus) {
        const cats = await j<any[]>(`/public-api/restaurants/${loc.ref}/mealPackages?menuReference=${m.reference}`)
        for (const c of cats || []) {
          for (const p of (c?.mealPackages || [])) {
            const n = String(p?.name || '').trim().toLowerCase()
            if (!n) continue
            seenFm.add(n)
            const candidates = byName.get(n)
            if (!candidates || !candidates.length) { onlyInFm++; continue }
            compared++
            const b = Number(p.price)
            if (!Number.isFinite(b)) continue
            // Agreement with ANY same-named Disco item clears it.
            if (candidates.some(c => Number.isFinite(Number(c.price)) && Math.abs(Number(c.price) - b) <= 0.005)) continue
            // No match — report the closest Disco price, the smallest real gap.
            let d = candidates[0]
            for (const c of candidates) {
              if (Math.abs(Number(c.price) - b) < Math.abs(Number(d.price) - b)) d = c
            }
            const a = Number(d.price)
            if (!Number.isFinite(a)) continue
            divergences.push({
              restaurant: loc.name, ref: loc.ref,
              item: d.raw_name + (candidates.length > 1 ? ` [${candidates.length} same-named items, closest shown]` : ''),
              disco: a, fm: b, diff: a - b,
              discoUpdated: d.updated_at ? String(d.updated_at).slice(0, 19) : null,
              discoCreated: d.created_at ? String(d.created_at).slice(0, 19) : null,
              fmUpdated: p?.updatedDate ? String(p.updatedDate).slice(0, 19) : (p?.modifiedDate ? String(p.modifiedDate).slice(0, 19) : null),
              convertedAt: loc.convertedAt,
            })
          }
        }
      }
      for (const n of byName.keys()) if (!seenFm.has(n)) onlyInDisco++
      if (checked % 20 === 0) console.error(`  …${checked}/${list.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  divergences.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))

  console.log('='.repeat(110))
  console.log('PRICE DIVERGENCE: Disco Cater vs FamilyMeal, every converted restaurant')
  console.log('='.repeat(110))
  console.log(`converted restaurants with a native menu:   ${list.length}`)
  console.log(`  compared against an FM menu:              ${checked}`)
  console.log(`  FM returned no menu (nothing to compare): ${noFmMenu}`)
  console.log(`items matched by name and compared:         ${compared}`)
  console.log(`items only in Disco:                        ${onlyInDisco}`)
  console.log(`items only in FamilyMeal:                   ${onlyInFm}`)
  console.log(`DIVERGENCES:                                ${divergences.length}`)
  const rests = new Set(divergences.map(d => d.ref))
  console.log(`restaurants affected:                       ${rests.size}`)
  console.log()

  // Was the Disco item ever edited after import? updated_at > created_at means a
  // Disco-side change; equal means the difference came in at import.
  const money = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2)
  const editedFlag = (d: Div) => {
    if (!d.discoUpdated || !d.discoCreated) return '?'
    return new Date(d.discoUpdated).getTime() - new Date(d.discoCreated).getTime() > 5000 ? 'edited-in-disco' : 'as-imported'
  }
  console.log('WORST FIRST')
  console.log('-'.repeat(110))
  console.log(
    'DIFF'.padStart(10) + '  ' + 'DISCO'.padStart(9) + '  ' + 'FAMILYMEAL'.padStart(10) + '  ' +
    'RESTAURANT'.padEnd(30) + '  ' + 'ORIGIN'.padEnd(16) + '  ITEM')
  for (const d of divergences) {
    console.log(
      money(d.diff).padStart(10) + '  ' + money(d.disco).padStart(9) + '  ' + money(d.fm).padStart(10) + '  ' +
      d.restaurant.slice(0, 30).padEnd(30) + '  ' + editedFlag(d).padEnd(16) + '  ' + d.item)
  }

  console.log()
  console.log('WHEN EACH CHANGED (Disco item last updated / created; converted at)')
  console.log('-'.repeat(110))
  for (const d of divergences) {
    console.log(`${d.restaurant.slice(0,30).padEnd(30)} ${d.item.slice(0,34).padEnd(34)} updated ${d.discoUpdated ?? '—'}  created ${d.discoCreated ?? '—'}  converted ${d.convertedAt ?? '—'}  fmUpdated ${d.fmUpdated ?? '(FM does not expose one)'}`)
  }

  console.log()
  console.log('PER RESTAURANT')
  console.log('-'.repeat(110))
  const byRest = new Map<string, Div[]>()
  for (const d of divergences) { if (!byRest.has(d.restaurant)) byRest.set(d.restaurant, []); byRest.get(d.restaurant)!.push(d) }
  for (const [r, ds] of [...byRest.entries()].sort((a, b) => Math.abs(b[1][0].diff) - Math.abs(a[1][0].diff))) {
    const tot = ds.reduce((s, d) => s + Math.abs(d.diff), 0)
    console.log(`${r.padEnd(34)} ${String(ds.length).padStart(3)} item(s), largest ${money(ds[0].diff)}, total absolute gap ${money(tot)}`)
  }

  if (noFmMenuNames.length) {
    console.log()
    console.log('FM RETURNED NO MENU (not compared — not evidence of agreement)')
    console.log('-'.repeat(110))
    noFmMenuNames.forEach(n => console.log('  ' + n))
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
