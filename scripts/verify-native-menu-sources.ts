/**
 * Proves every menu-reading path serves a NATIVE restaurant Disco's own menu,
 * not FamilyMeal's frozen snapshot — checked against a restaurant whose menu has
 * genuinely drifted, so a regression cannot pass by coincidence.
 *
 *   npx tsx -r dotenv/config scripts/verify-native-menu-sources.ts dotenv_config_path=.env.local
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'
import { repriceCart, checkMenuAvailability } from '../lib/recurring'
import { loadNativeEditMenu } from '../lib/menu/native-edit-menu'

const FM = 'https://api.familymeal.com'
let fail = 0
const chk = (label: string, ok: boolean, detail = '') => {
  if (!ok) fail++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const norm = (s: string) => s.trim().toLowerCase()

async function fmPrices(ref: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const menus = await fetch(`${FM}/public-api/menu?restaurantReference=${ref}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : []).catch(() => [])
  for (const m of (Array.isArray(menus) ? menus : [])) {
    const cats = await fetch(`${FM}/public-api/restaurants/${ref}/mealPackages?menuReference=${m.reference}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : []).catch(() => [])
    for (const c of (Array.isArray(cats) ? cats : [])) for (const p of (c.mealPackages || [])) {
      if (p?.name) out.set(norm(p.name), Number(p.price) || 0)
    }
  }
  return out
}

async function main() {
  const r = (await sql`
    SELECT restaurant_reference::text AS ref, name FROM disco_restaurant_cache WHERE name = 'Beach Buns Bakery'
  `) as { ref: string; name: string }[]
  const ref = r[0].ref
  console.log(`Restaurant under test: ${r[0].name} (${ref.slice(0, 8)}) — chosen because its menu HAS drifted\n`)

  const neon = (await sql`
    SELECT name, price FROM disco_menu_items WHERE restaurant_reference = ${ref}::uuid AND visible = true
  `) as { name: string; price: string | number }[]
  const fm = await fmPrices(ref)

  const drifted = neon.filter(n => { const f = fm.get(norm(n.name)); return f !== undefined && Math.abs(Number(n.price) - f) > 0.005 })
  const discoOnly = neon.filter(n => !fm.has(norm(n.name)))
  console.log(`   drift confirmed: ${drifted.length} price difference(s), ${discoOnly.length} Disco-only item(s)`)
  chk('the test restaurant really has drifted (otherwise this proves nothing)', drifted.length > 0 || discoOnly.length > 0)

  // ── 1. recurring repricing ──
  console.log('\n=== repriceCart (recurring orders — real money) ===')
  const sample = drifted[0]
  if (sample) {
    const fmPrice = fm.get(norm(sample.name))!
    const out = await repriceCart(ref, [{ name: sample.name, price: 0, quantity: 1 } as never])
    const got = Number((out[0] as { price: number }).price)
    chk(`"${sample.name}" priced from Disco, not FamilyMeal`, Math.abs(got - Number(sample.price)) < 0.005,
      `got $${got.toFixed(2)} | Disco $${Number(sample.price).toFixed(2)} | FM $${fmPrice.toFixed(2)}`)
  }

  // ── 2. availability ──
  console.log('\n=== checkMenuAvailability (false cancellations) ===')
  if (discoOnly[0]) {
    const a = await checkMenuAvailability(ref, [{ name: discoOnly[0].name, price: 0, quantity: 1 } as never])
    chk(`a Disco-only item is NOT declared unavailable: "${discoOnly[0].name}"`, a.available === true,
      `unavailable=${JSON.stringify(a.unavailableItems)}`)
  }

  // ── 3. order edit dialog ──
  console.log('\n=== order-edit menu (the original report) ===')
  const sections = await loadNativeEditMenu(ref)
  chk('native menu returned (not null)', sections !== null)
  const pkgs = (sections ?? []).flatMap(s => s.categories.flatMap(c => c.mealPackages))
  chk('items present', pkgs.length > 0, `${pkgs.length} items`)
  if (sample) {
    const p = pkgs.find(x => norm(x.name) === norm(sample.name))
    chk(`"${sample.name}" carries Disco's price`, !!p && Math.abs(p.price - Number(sample.price)) < 0.005,
      p ? `$${p.price.toFixed(2)}` : 'item missing')
  }

  // ── 4. FM-backed must be untouched ──
  console.log('\n=== an FM-backed restaurant still uses FamilyMeal ===')
  const fmb = (await sql`
    SELECT restaurant_reference::text AS ref, name FROM disco_restaurant_cache
    WHERE NOT is_disco_native AND archived_at IS NULL LIMIT 1
  `) as { ref: string; name: string }[]
  chk('loadNativeEditMenu returns null for an FM-backed restaurant', (await loadNativeEditMenu(fmb[0].ref)) === null, fmb[0].name)

  console.log('\n' + '='.repeat(62))
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
