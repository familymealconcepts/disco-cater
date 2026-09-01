/**
 * Items with a $0 BASE price whose real cost comes from REQUIRED PAID modifier
 * groups — and what their free-text display_price claims. READ-ONLY.
 *
 * A $0 base is legitimate: the item carries mandatory groups with positive
 * prices, so the customer cannot buy it for nothing. The open question is
 * DISPLAY: a flat "$43.99" reads as the price, when the true floor is whatever
 * the cheapest required selection costs. This measures the display price against
 * that floor so the qualifier question can be answered from data.
 *
 * floor = sum over each REQUIRED group (min_selected >= 1) of
 *         min_selected * cheapest PAID option price in that group
 *
 * GROUPED BY ITEM REFERENCE, NOT NAME. Several restaurants carry two live items
 * with the same name (Hugo's has "Avocado Jalapeno" and "Broccoli" twice), and
 * grouping by name summed both items' floors — which made a correct $10.00
 * display price look like it understated a $20.00 minimum by half. That was a bug
 * in this script, not in the data.
 *
 *   npx tsx scripts/audit-zero-base-items.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'

interface Row {
  restaurant: string; live: boolean; item: string; display_price: string | null
  groups: number; required_groups: number
  floor: string | null; cheapest_any: string | null; dearest: string | null
}

const money = (v: string | null) => v == null ? '—' : `$${Number(v).toFixed(2)}`

async function main() {
  const rows = (await sql`
    WITH zero AS (
      SELECT mi.reference, btrim(mi.name) AS item, mi.display_price,
             m.restaurant_reference, c.name AS restaurant, COALESCE(c.is_live,false) AS live
      FROM disco_menu_items mi
      JOIN disco_menu_categories cat ON cat.reference = mi.category_reference
      JOIN disco_menus m ON m.reference = cat.menu_reference AND NOT m.archived
      JOIN disco_restaurant_cache c ON c.restaurant_reference = m.restaurant_reference::text
      WHERE mi.price::numeric = 0
    ),
    grp AS (
      SELECT z.reference AS item_reference, g.reference AS group_reference,
             g.min_selected,
             MIN(mo.price::numeric) FILTER (WHERE mo.price::numeric > 0) AS cheapest_paid,
             MIN(mo.price::numeric) AS cheapest_any,
             MAX(mo.price::numeric) AS dearest,
             COUNT(mo.reference) AS options
      FROM zero z
      JOIN disco_item_groups ig ON ig.item_reference = z.reference AND ig.enabled = true
      JOIN disco_modifier_groups g ON g.reference = ig.group_reference AND g.archived = false AND g.visible = true
      LEFT JOIN disco_modifier_group_members gm ON gm.group_reference = g.reference
      LEFT JOIN disco_modifiers mo ON mo.reference = gm.modifier_reference AND mo.archived = false AND mo.visible = true
      GROUP BY 1,2,3
    )
    SELECT z.reference, z.restaurant, z.live, z.item, z.display_price,
           COUNT(grp.group_reference)::int AS groups,
           COUNT(*) FILTER (WHERE grp.min_selected >= 1)::int AS required_groups,
           SUM(GREATEST(grp.min_selected,0) * COALESCE(grp.cheapest_paid, 0))
             FILTER (WHERE grp.min_selected >= 1)::text AS floor,
           MIN(grp.cheapest_any)::text AS cheapest_any,
           MAX(grp.dearest)::text AS dearest
    FROM zero z
    LEFT JOIN grp ON grp.item_reference = z.reference
    GROUP BY 1,2,3,4,5
    ORDER BY z.restaurant, z.item
  `) as unknown as Row[]

  const withRequiredPaid = rows.filter(r => r.required_groups > 0 && Number(r.floor) > 0)
  const requiredFree = rows.filter(r => r.required_groups > 0 && !(Number(r.floor) > 0))
  const optionalOnly = rows.filter(r => r.groups > 0 && r.required_groups === 0)
  const noGroups = rows.filter(r => r.groups === 0)

  console.log(`${rows.length} live-menu item(s) with a $0 base price\n`)
  console.log(`   required PAID group(s)  — cannot be bought for $0 : ${withRequiredPaid.length}  (${withRequiredPaid.filter(r => r.live).length} live restaurants)`)
  console.log(`   required group, all options free                  : ${requiredFree.length}`)
  console.log(`   groups but NONE required — buyable at $0          : ${optionalOnly.length}  <- the ones worth a look`)
  console.log(`   no modifier groups at all — buyable at $0         : ${noGroups.length}  <- ditto\n`)

  const dp = (r: Row) => (r.display_price || '').trim()
  const flat = withRequiredPaid.filter(r => dp(r) && !/[+]|from|start|–|-|per /i.test(dp(r)))
  const qualified = withRequiredPaid.filter(r => /[+]|from|start|–|-/i.test(dp(r)))
  const blank = withRequiredPaid.filter(r => !dp(r))

  console.log('── HOW THE DISPLAY PRICE IS WRITTEN (required-paid items only) ──')
  console.log(`   FLAT figure, no qualifier : ${flat.length}   <- reads as the price; the floor is what it really is`)
  console.log(`   already qualified (+, range, "from") : ${qualified.length}`)
  console.log(`   blank (renders "$0.00")   : ${blank.length}\n`)

  console.log('── DOES THE FLAT FIGURE EQUAL THE CHEAPEST REQUIRED SELECTION? ──')
  let eqFloor = 0, aboveFloor = 0, belowFloor = 0, unparsed = 0
  for (const r of flat) {
    const n = Number(dp(r).replace(/[$,]/g, ''))
    const f = Number(r.floor)
    if (!Number.isFinite(n)) { unparsed++; continue }
    if (Math.abs(n - f) < 0.005) eqFloor++
    else if (n > f) aboveFloor++
    else belowFloor++
  }
  console.log(`   equals the floor exactly : ${eqFloor}   <- it IS the cheapest required selection`)
  console.log(`   ABOVE the floor          : ${aboveFloor}   <- a typical/hand-picked figure, cheaper is possible`)
  console.log(`   BELOW the floor          : ${belowFloor}   <- understates the real minimum`)
  console.log(`   not a number             : ${unparsed}\n`)

  // The two directions that matter are printed IN FULL — a sample would hide
  // exactly the rows worth acting on.
  const withVerdict = flat.map(r => {
    const n = Number(dp(r).replace(/[$,]/g, ''))
    const f = Number(r.floor)
    return { r, n, f, kind: !Number.isFinite(n) ? 'prose' : Math.abs(n - f) < 0.005 ? 'floor' : n > f ? 'above' : 'below' }
  })
  for (const [kind, label] of [['below', 'UNDERSTATES the real minimum — a customer cannot pay this little'],
                               ['above', 'ABOVE the floor — a cheaper required selection exists']] as const) {
    const set = withVerdict.filter(x => x.kind === kind)
    console.log(`\n── ${label} (${set.length}) ──`)
    set.forEach(x => console.log(
      `   ${x.r.live ? 'LIVE' : '    '} ${x.r.restaurant.slice(0, 24).padEnd(24)} ${x.r.item.slice(0, 26).padEnd(26)} ` +
      `display "${dp(x.r)}"  floor ${money(x.r.floor)}  range ${money(x.r.cheapest_any)}–${money(x.r.dearest)}`))
  }

  console.log('\n── SAMPLE (flat display price vs the real floor) ──')
  flat.slice(0, 8).forEach(r => {
    const n = Number(dp(r).replace(/[$,]/g, ''))
    const f = Number(r.floor)
    const verdict = !Number.isFinite(n) ? 'prose'
      : Math.abs(n - f) < 0.005 ? '= floor'
      : n > f ? `ABOVE floor by $${(n - f).toFixed(2)}` : `BELOW floor by $${(f - n).toFixed(2)}`
    console.log(`   ${r.live ? 'LIVE' : '    '} ${r.restaurant.slice(0, 24).padEnd(24)} ${r.item.slice(0, 26).padEnd(26)} display "${dp(r)}"  floor ${money(r.floor)}  range ${money(r.cheapest_any)}–${money(r.dearest)}  ${verdict}`)
  })

  if (optionalOnly.length || noGroups.length) {
    console.log('\n── BUYABLE AT $0 (no required paid group) — display vs reality ──')
    ;[...optionalOnly, ...noGroups].filter(r => r.live).slice(0, 14).forEach(r =>
      console.log(`   ${r.restaurant.slice(0, 24).padEnd(24)} ${r.item.slice(0, 26).padEnd(26)} display "${dp(r) || '(blank)'}"  groups=${r.groups} required=${r.required_groups}`))
  }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
