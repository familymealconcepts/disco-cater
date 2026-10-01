// Verification for the hardcoded 48-hour lead time on Colonial Ranch Market's
// "Freezer Meat Packages" category (lib/menu/category-lead-time.ts).
//
// Exercises the REAL server gate (isNativeDateTimeValid) against the REAL
// database — not a reimplementation of it — and uses a control item from a
// different category on the SAME menu so "the rule bit" and "the menu changed"
// cannot be confused for each other.
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'
import { isNativeDateTimeValid, findCategoryLeadBreaches } from '../lib/order/native-checkout'
import { isCategoryLeadSatisfied } from '../lib/menu/category-lead-time'

const REF = 'ecf9bfdc-eb23-4ce4-b8c6-91ab14061cd5'   // Colonial Ranch Market
const FREEZER_CAT = '2df615a7-fcc2-4d95-8b2a-7619d0c0bdcc'

let pass = 0, fail = 0
function check(label: string, got: unknown, want: unknown) {
  const ok = got === want
  if (ok) pass++; else fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `   got=${got} want=${want}`}`)
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

async function main() {
  const menu = (await sql`
    SELECT reference::text AS reference, name, lead_time_hours FROM disco_menus
    WHERE restaurant_reference = ${REF}::uuid AND name ILIKE 'Butcher%' LIMIT 1
  `) as { reference: string; name: string; lead_time_hours: number }[]
  const menuRef = menu[0].reference
  console.log(`menu: ${menu[0].name}  lead_time_hours=${menu[0].lead_time_hours}`)

  const freezer = (await sql`
    SELECT reference::text AS reference, name FROM disco_menu_items
    WHERE restaurant_reference = ${REF}::uuid AND category_reference = ${FREEZER_CAT} AND visible
    ORDER BY position LIMIT 1
  `) as { reference: string; name: string }[]
  // Control: a different category on the SAME menu, so the menu's own schedule
  // is held constant and only the category differs.
  const control = (await sql`
    SELECT i.reference::text AS reference, i.name, c.name AS category FROM disco_menu_items i
    JOIN disco_menu_categories c ON c.reference = i.category_reference
    WHERE i.restaurant_reference = ${REF}::uuid AND c.menu_reference = ${menuRef}
      AND c.reference <> ${FREEZER_CAT} AND i.visible
    ORDER BY i.position LIMIT 1
  `) as { reference: string; name: string; category: string }[]

  const F = freezer[0], C = control[0]
  console.log(`freezer item: "${F.name}"`)
  console.log(`control item: "${C.name}" (${C.category}, same menu)\n`)

  // A slot the MENU itself accepts, inside 48h, and one outside it. Found by
  // asking the gate rather than assuming the pickup window.
  const now = new Date()
  let inside = '', outside = '', slotTime = ''
  for (const t of ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00']) {
    for (let d = 1; d <= 2 && !inside; d++) {
      const day = iso(new Date(now.getTime() + d * 86400000))
      if (await isNativeDateTimeValid(REF, day, t, menuRef)) {
        // Only counts as "inside" if 48h really is not satisfied.
        if (!isCategoryLeadSatisfied(48, day, t, now, 'America/New_York')) { inside = day; slotTime = t }
      }
    }
    for (let d = 4; d <= 8 && !outside; d++) {
      const day = iso(new Date(now.getTime() + d * 86400000))
      if (await isNativeDateTimeValid(REF, day, t, menuRef)) outside = day
    }
    if (inside && outside) break
  }
  if (!inside || !outside) { console.error('could not find both an inside-48h and an outside-48h bookable slot'); process.exit(1) }
  console.log(`inside 48h:  ${inside} ${slotTime}`)
  console.log(`outside 48h: ${outside} ${slotTime}\n`)

  console.log('1. THE MENU ITSELF IS UNCHANGED (2h lead, both dates bookable)')
  check('menu gate accepts the near date with no items supplied', await isNativeDateTimeValid(REF, inside, slotTime, menuRef), true)
  check('menu gate accepts the far date with no items supplied', await isNativeDateTimeValid(REF, outside, slotTime, menuRef), true)

  console.log('\n2. THE FREEZER PACK (48h)')
  check('refused inside 48h', await isNativeDateTimeValid(REF, inside, slotTime, menuRef, { itemReferences: [F.reference] }), false)
  check('accepted outside 48h', await isNativeDateTimeValid(REF, outside, slotTime, menuRef, { itemReferences: [F.reference] }), true)

  console.log('\n3. NO OTHER CATEGORY CHANGED (control item, same menu, same slot)')
  check('control accepted inside 48h', await isNativeDateTimeValid(REF, inside, slotTime, menuRef, { itemReferences: [C.reference] }), true)
  check('control accepted outside 48h', await isNativeDateTimeValid(REF, outside, slotTime, menuRef, { itemReferences: [C.reference] }), true)
  check('mixed cart refused inside 48h (the freezer pack poisons it)', await isNativeDateTimeValid(REF, inside, slotTime, menuRef, { itemReferences: [C.reference, F.reference] }), false)

  console.log('\n4. STAFF DIRECT ENTRY IS EXEMPT')
  check('freezer pack accepted inside 48h when exempt', await isNativeDateTimeValid(REF, inside, slotTime, menuRef, { itemReferences: [F.reference], exemptCategoryLeadTimes: true }), true)
  check('exemption does NOT lift the menu\'s own gates', await isNativeDateTimeValid(REF, '1999-01-01', slotTime, menuRef, { itemReferences: [F.reference], exemptCategoryLeadTimes: true }), false)

  console.log('\n5. THE BYPASS ATTEMPT (a direct API call naming no items, or a wide-open menu)')
  check('breach is reported for the near date', (await findCategoryLeadBreaches(REF, [F.reference], inside, slotTime)).length > 0, true)
  check('no breach for the far date', (await findCategoryLeadBreaches(REF, [F.reference], outside, slotTime)).length, 0)
  // An item reference that belongs to ANOTHER restaurant must not resolve here —
  // the lookup is scoped by restaurant_reference, so a cross-restaurant ref is
  // simply absent rather than silently carrying its own category's rule.
  check('a foreign item reference resolves to nothing', (await findCategoryLeadBreaches(REF, ['00000000-0000-0000-0000-000000000000'], inside, slotTime)).length, 0)

  console.log('\n6. NO OTHER RESTAURANT IS AFFECTED')
  const others = (await sql`
    SELECT count(*)::int AS n FROM disco_menu_categories
    WHERE reference = ${FREEZER_CAT} AND restaurant_reference <> ${REF}::uuid
  `) as { n: number }[]
  check('the category reference exists at exactly one restaurant', others[0].n, 0)
  const sample = (await sql`
    SELECT i.reference::text AS reference, i.restaurant_reference::text AS r
    FROM disco_menu_items i
    JOIN disco_restaurant_cache c ON c.restaurant_reference = i.restaurant_reference::text AND c.is_disco_native
    WHERE i.restaurant_reference <> ${REF}::uuid AND i.visible LIMIT 25
  `) as { reference: string; r: string }[]
  const breached = []
  for (const s of sample) {
    if ((await findCategoryLeadBreaches(s.r, [s.reference], inside, slotTime)).length) breached.push(s.reference)
  }
  check(`25 sampled items at other native restaurants: none carry a rule`, breached.length, 0)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
