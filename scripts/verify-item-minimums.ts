/**
 * Verification for the item/group minimum gates (checkCartMinimums).
 *
 * Read-only. Exercises the REAL server gate against REAL production menu data for
 * the three cases named in the brief, plus the case that matters just as much:
 * a valid cart must still go through.
 *
 *   npx tsx scripts/verify-item-minimums.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { checkCartMinimums, getItemMinimumsByName } from '../lib/order/native-minimums'
import { parseModifierGroups } from '../lib/menu-import/disco-native-write'
import { sql } from '../lib/db'

let failures = 0
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}${ok ? '' : ` — expected ${JSON.stringify(expected)}`}`)
}

interface ItemRow { reference: string; name: string; price: string; min_quantity: number; restaurant: string }

async function findItem(restaurantLike: string, itemLike: string): Promise<ItemRow | null> {
  const rows = (await sql`
    SELECT mi.reference, mi.name, mi.price::text AS price, mi.min_quantity, c.name AS restaurant
    FROM disco_menu_items mi
    JOIN disco_menu_categories cat ON cat.reference = mi.category_reference
    JOIN disco_menus m ON m.reference = cat.menu_reference AND NOT m.archived
    JOIN disco_restaurant_cache c ON c.restaurant_reference = m.restaurant_reference::text
    WHERE c.name ILIKE ${restaurantLike} AND mi.name ILIKE ${itemLike} AND mi.min_quantity IS NOT NULL
    ORDER BY mi.min_quantity DESC LIMIT 1
  `) as unknown as ItemRow[]
  return rows[0] ?? null
}

/**
 * Build a VALID set of selections for an item: for every required group attached
 * to it, pick its first option at the group's minimum count.
 *
 * Needed because most minimum'd Atlanta Bread items also carry a required group
 * (Sides all have "Select Packaging Type", min 1). A cart with the right quantity
 * but no selections is correctly REFUSED by the group half of the gate, so an
 * "allowed" assertion has to supply them — otherwise the test proves nothing about
 * the quantity it meant to check.
 */
async function validAddOns(itemReference: string): Promise<{ name: string; quantity: number; groupReference: string }[]> {
  const rows = (await sql`
    SELECT g.reference AS group_reference, g.min_selected,
           (SELECT m2.name FROM disco_modifier_group_members gm2
              JOIN disco_modifiers m2 ON m2.reference = gm2.modifier_reference AND NOT m2.archived AND m2.visible
             WHERE gm2.group_reference = g.reference ORDER BY gm2.position LIMIT 1) AS option_name
    FROM disco_item_groups ig
    JOIN disco_modifier_groups g ON g.reference = ig.group_reference AND NOT g.archived AND g.visible
    WHERE ig.enabled AND ig.item_reference = ${itemReference}::uuid AND g.min_selected > 0
  `) as unknown as { group_reference: string; min_selected: number; option_name: string | null }[]
  return rows
    .filter(r => !!r.option_name)
    .map(r => ({ name: r.option_name as string, quantity: r.min_selected, groupReference: r.group_reference }))
}

async function main() {
  // ── The three named cases ──────────────────────────────────────────────────
  const cases: { label: string; restaurant: string; item: string; expectedMin: number }[] = [
    { label: 'Atlanta Bread Sides', restaurant: '%atlanta bread%smyrna%', item: 'Italian Pasta Salad', expectedMin: 4 },
    { label: 'Asheville Hot Breakfast Tray', restaurant: '%atlanta bread%asheville%', item: 'Hot Breakfast Tray', expectedMin: 10 },
    { label: 'Francesca Holiday package', restaurant: '%francesca%', item: 'Holiday Catering Package', expectedMin: 30 },
  ]

  for (const c of cases) {
    const it = await findItem(c.restaurant, c.item)
    console.log(`\n=== ${c.label} ===`)
    if (!it) { console.log(`   FAIL  item not found (${c.restaurant} / ${c.item})`); failures++; continue }
    const addOns = await validAddOns(it.reference)
    console.log(`   ${it.restaurant} · "${it.name}" · $${it.price} · min ${it.min_quantity}` +
      (addOns.length ? ` · ${addOns.length} required group(s)` : ''))
    check('stored minimum', it.min_quantity, c.expectedMin)
    const line = (quantity: number) => ({ reference: it.reference, name: it.name, quantity, addOns })

    // BELOW the minimum → refused.
    const below = await checkCartMinimums([line(it.min_quantity - 1)])
    check(`qty ${it.min_quantity - 1} refused`, !below.ok, true)
    if (!below.ok) console.log(`          → "${below.message}"`)

    // A single unit — the exact bug Kealoha described.
    check('qty 1 refused', !(await checkCartMinimums([line(1)])).ok, true)

    // AT the minimum → allowed.
    const at = await checkCartMinimums([line(it.min_quantity)])
    check(`qty ${it.min_quantity} allowed`, at.ok, true)
    if (!at.ok) console.log(`          → "${at.message}"`)

    // ABOVE the minimum → allowed.
    check(`qty ${it.min_quantity + 5} allowed`, (await checkCartMinimums([line(it.min_quantity + 5)])).ok, true)

    // Split across two lines summing to the minimum → allowed (documented behaviour:
    // the kitchen sees total portions, so refusing this would be a false refusal).
    const half = Math.floor(it.min_quantity / 2)
    const split = await checkCartMinimums([line(half), line(it.min_quantity - half)])
    check(`split ${half}+${it.min_quantity - half} allowed`, split.ok, true)

    // And the group half still bites at a correct quantity with NO selections.
    if (addOns.length) {
      const noSel = await checkCartMinimums([{ reference: it.reference, name: it.name, quantity: it.min_quantity }])
      check(`qty ${it.min_quantity} but no group selections → refused`, !noSel.ok, true)
    }
  }

  // ── Don't break ordering: a real valid cart must still pass ────────────────
  console.log(`\n=== Valid cart still works ===`)
  // Rebuild the cart that was lost on 2026-08-27, at CORRECT quantities this time.
  const smyrna = '%atlanta bread%smyrna%'
  const pasta = await findItem(smyrna, 'Italian Pasta Salad')
  const fruit = await findItem(smyrna, 'Fruit Salad')
  const noMin = (await sql`
    SELECT mi.reference, mi.name FROM disco_menu_items mi
    JOIN disco_menu_categories cat ON cat.reference = mi.category_reference
    JOIN disco_menus m ON m.reference = cat.menu_reference AND NOT m.archived
    JOIN disco_restaurant_cache c ON c.restaurant_reference = m.restaurant_reference::text
    WHERE c.name ILIKE ${smyrna} AND mi.min_quantity IS NULL AND mi.visible
    ORDER BY mi.name LIMIT 3
  `) as unknown as { reference: string; name: string }[]

  if (pasta && fruit) {
    const fixed = await checkCartMinimums([
      { reference: pasta.reference, name: pasta.name, quantity: 4, addOns: await validAddOns(pasta.reference) },
      { reference: fruit.reference, name: fruit.name, quantity: 4, addOns: await validAddOns(fruit.reference) },
      ...(await Promise.all(noMin.map(async n => ({
        reference: n.reference, name: n.name, quantity: 1, addOns: await validAddOns(n.reference),
      })))),
    ])
    check(`corrected 2026-08-27 cart (4+4 + ${noMin.length} unminimum'd items) allowed`, fixed.ok, true)
    if (!fixed.ok) console.log(`          → "${fixed.message}"`)

    // The cart as actually submitted that day → refused.
    const asSubmitted = await checkCartMinimums([
      { reference: pasta.reference, name: pasta.name, quantity: 2 },
      { reference: fruit.reference, name: fruit.name, quantity: 2 },
    ])
    check('cart as submitted on 2026-08-27 refused', !asSubmitted.ok, true)
  } else { console.log('   FAIL  could not rebuild the 08-27 cart'); failures++ }

  // Items with NO minimum, at quantity 1 — must never be touched.
  // These filler items have no minimum QUANTITY, but several carry a required
  // modifier group — so a valid cart still has to supply its selections. Without
  // them this asserted the wrong thing and passed only by luck of which rows the
  // unordered LIMIT happened to draw.
  const onlyNoMin = await checkCartMinimums(await Promise.all(noMin.map(async n => ({
    reference: n.reference, name: n.name, quantity: 1, addOns: await validAddOns(n.reference),
  }))))
  check(`${noMin.length} unminimum'd items at qty 1 allowed`, onlyNoMin.ok, true)
  check('empty cart allowed', (await checkCartMinimums([])).ok, true)
  check('cart with no references allowed (FM-backed / legacy)',
    (await checkCartMinimums([{ name: 'Something', quantity: 1 }])).ok, true)

  // ── Required modifier groups ───────────────────────────────────────────────
  console.log(`\n=== Required modifier groups ===`)
  const grp = (await sql`
    SELECT ig.item_reference, mi.name AS item_name, g.reference AS group_reference,
           g.external_name, g.min_selected,
           (SELECT m2.name FROM disco_modifier_group_members gm2
              JOIN disco_modifiers m2 ON m2.reference = gm2.modifier_reference
             WHERE gm2.group_reference = g.reference LIMIT 1) AS option_name
    FROM disco_item_groups ig
    JOIN disco_modifier_groups g ON g.reference = ig.group_reference AND NOT g.archived AND g.visible
    JOIN disco_menu_items mi ON mi.reference = ig.item_reference
    JOIN disco_restaurant_cache c ON c.restaurant_reference = mi.restaurant_reference::text
    WHERE ig.enabled AND g.min_selected >= 2 AND c.name ILIKE ${smyrna}
    LIMIT 1
  `) as unknown as { item_reference: string; item_name: string; group_reference: string; external_name: string; min_selected: number; option_name: string }[]

  if (!grp.length) { console.log('   (no min>=2 group found to test)') } else {
    const g = grp[0]
    console.log(`   "${g.item_name}" · group "${g.external_name}" · min ${g.min_selected}`)
    const itemMin = (await sql`SELECT COALESCE(min_quantity, 1) AS q FROM disco_menu_items WHERE reference = ${g.item_reference}::uuid`) as unknown as { q: number }[]
    const q = Number(itemMin[0]?.q ?? 1)

    // Exact mode (groupReference supplied) — too few selections → refused.
    const tooFew = await checkCartMinimums([{
      reference: g.item_reference, name: g.item_name, quantity: q,
      addOns: [{ name: g.option_name, quantity: 1, groupReference: g.group_reference }],
    }])
    check(`1 selection where ${g.min_selected} required — refused`, !tooFew.ok, true)
    if (!tooFew.ok) console.log(`          → "${tooFew.message}"`)

    // Enough selections → allowed.
    const enough = await checkCartMinimums([{
      reference: g.item_reference, name: g.item_name, quantity: q,
      addOns: [{ name: g.option_name, quantity: g.min_selected, groupReference: g.group_reference }],
    }])
    check(`${g.min_selected} selections — allowed`, enough.ok, true)

    // No add-ons at all on an item with a required group → refused.
    const none = await checkCartMinimums([{ reference: g.item_reference, name: g.item_name, quantity: q }])
    check("no selections at all — refused", !none.ok, true)
  }

  // ── getItemMinimumsByName (the recurring editor's source) ──────────────────
  console.log(`\n=== Name-keyed minimums endpoint helper ===`)
  const ref = (await sql`SELECT restaurant_reference FROM disco_restaurant_cache WHERE name ILIKE ${smyrna} LIMIT 1`) as unknown as { restaurant_reference: string }[]
  const byName = await getItemMinimumsByName(ref[0].restaurant_reference)
  check('italian pasta salad → 4', byName['italian pasta salad'], 4)
  check('unminimum\'d item absent', 'gallon unsweet tea' in byName, false)

  // ── parseSelectionCount, via parseModifierGroups ───────────────────────────
  console.log(`\n=== Selection counts parsed from a group name (AI-import path) ===`)
  const p = (s: string) => { const g = parseModifierGroups(s)[0]; return [g?.minSelected, g?.maxSelected] }
  check('"Select 2 Salads"', p('Select 2 Salads: A, B, C'), [2, 2])
  check('"Select 4+ Sandwiches"', p('Select 4+ Sandwiches: A, B, C, D, E'), [4, undefined])
  check('"Select 1-2 Breads"', p('Select 1-2 Breads: A, B'), [1, 2])
  check('"Choose up to 3"', p('Choose up to 3: A, B, C'), [0, 3])
  check('no count stated → default', p('Choose protein: Chicken, Beef'), [undefined, undefined])

  console.log('\n' + '='.repeat(70))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
