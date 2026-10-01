/**
 * How far Disco's native menus have drifted from FamilyMeal's frozen snapshot.
 *
 * FM returns EITHER a bare array OR a paginated {content:[...]} depending on the
 * endpoint. A check that assumes an array scores every restaurant zero — that
 * nearly cancelled a conversion run — so `arr()` handles both and the run
 * ABORTS if a restaurant known to have a menu reads as empty.
 *
 *   npx tsx -r dotenv/config scripts/measure-menu-divergence.ts dotenv_config_path=.env.local [limit]
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'

const FM = 'https://api.familymeal.com'
const arr = (d: unknown): any[] => Array.isArray(d) ? d : (Array.isArray((d as any)?.content) ? (d as any).content : [])
const norm = (s: string) => s.trim().toLowerCase()
const j = async (u: string) => { try { const r = await fetch(`${FM}${u}`, { headers: { Accept: 'application/json' }, cache: 'no-store' }); return r.ok ? await r.json() : null } catch { return null } }

async function fmMenu(ref: string) {
  const out = new Map<string, { price: number; groups: number }>()
  for (const m of arr(await j(`/public-api/menu?restaurantReference=${ref}`))) {
    for (const c of arr(await j(`/public-api/restaurants/${ref}/mealPackages?menuReference=${m.reference}`))) {
      for (const p of (c.mealPackages || [])) {
        if (p?.name) out.set(norm(p.name), { price: Number(p.price) || 0, groups: (p.extraItemsGroups || []).length })
      }
    }
  }
  return out
}

async function main() {
  const limit = Number(process.argv.find(a => /^\d+$/.test(a)) || 150)

  // ── SANITY CHECK: a restaurant known to have a menu must not read as empty ──
  const canary = (await sql`
    SELECT restaurant_reference::text AS ref FROM disco_restaurant_cache WHERE name = 'Beach Buns Bakery'
  `) as { ref: string }[]
  const canaryMenu = await fmMenu(canary[0].ref)
  if (canaryMenu.size === 0) {
    console.error('ABORT: the canary restaurant read as 0 items — the FM response shape changed and every count below would be a lie.')
    process.exit(1)
  }
  console.log(`canary OK: Beach Buns Bakery reads ${canaryMenu.size} items from FamilyMeal\n`)

  const targets = (await sql`
    SELECT c.restaurant_reference::text AS ref, c.name
    FROM disco_restaurant_cache c
    WHERE c.is_disco_native AND c.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM disco_menu_items i WHERE i.restaurant_reference::text = c.restaurant_reference::text AND i.visible)
    ORDER BY (SELECT count(*) FROM disco_orders o WHERE o.restaurant_reference::text = c.restaurant_reference::text) DESC
    LIMIT ${limit}
  `) as { ref: string; name: string }[]
  console.log(`comparing ${targets.length} native restaurants (busiest first)…`)

  let same = 0, diff = 0, noFm = 0
  const k = { price: 0, discoOnly: 0, fmOnly: 0, moreGroups: 0, fewerGroups: 0 }
  let done = 0
  const CONC = 6
  async function one(t: { ref: string; name: string }) {
    const fm = await fmMenu(t.ref)
    if (fm.size === 0) { noFm++; return }
    const neon = (await sql`
      SELECT i.name, i.price,
        (SELECT count(*)::int FROM disco_item_groups ig
           JOIN disco_modifier_groups g ON g.reference = ig.group_reference
          WHERE ig.item_reference = i.reference AND ig.enabled AND g.archived = false AND g.visible) AS groups
      FROM disco_menu_items i WHERE i.restaurant_reference::text = ${t.ref} AND i.visible
    `) as { name: string; price: string | number; groups: number }[]
    let d = false
    for (const n of neon) {
      const f = fm.get(norm(n.name))
      if (!f) { k.discoOnly++; d = true; continue }
      if (Math.abs(Number(n.price) - f.price) > 0.005) { k.price++; d = true }
      if (Number(n.groups) > f.groups) { k.moreGroups++; d = true }
      else if (Number(n.groups) < f.groups) { k.fewerGroups++; d = true }
    }
    for (const key of fm.keys()) if (!neon.some(n => norm(n.name) === key)) { k.fmOnly++; d = true }
    d ? diff++ : same++
    if (++done % 40 === 0) console.log(`  ${done}/${targets.length}`)
  }
  for (let i = 0; i < targets.length; i += CONC) await Promise.all(targets.slice(i, i + CONC).map(one))

  const compared = same + diff
  console.log(`\n=== DIVERGENCE ===`)
  console.log(`  compared                 : ${compared}`)
  console.log(`  identical to FamilyMeal  : ${same}`)
  console.log(`  DIVERGED                 : ${diff}  (${compared ? Math.round(diff / compared * 100) : 0}%)`)
  console.log(`  FM has no menu at all    : ${noFm}`)
  console.log(`\n  item-level:`)
  console.log(`     price differs                 : ${k.price}`)
  console.log(`     item only in Disco            : ${k.discoOnly}`)
  console.log(`     item only in FM (removed)     : ${k.fmOnly}`)
  console.log(`     Disco has MORE groups than FM : ${k.moreGroups}`)
  console.log(`     Disco has FEWER groups than FM: ${k.fewerGroups}`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
