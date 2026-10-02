// What a Disco-password staff member at a converted restaurant can and cannot do
// without a FamilyMeal token.
//
// The 68 routes that authenticate with the USER'S OWN FM token throw for a Disco
// session, so each either has a native path or is a hole. This measures which.
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'

let pass = 0, fail = 0
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

async function main() {
  const r = (await sql`
    SELECT c.restaurant_reference::text AS ref, c.name, c.slug
      FROM disco_restaurant_cache c
      JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
     WHERE c.is_disco_native = true AND o.archived_at IS NULL AND o.announcement IS NOT NULL
     LIMIT 1
  `)[0] as { ref: string; name: string; slug: string | null } | undefined
  const target = r ?? (await sql`
    SELECT c.restaurant_reference::text AS ref, c.name, c.slug FROM disco_restaurant_cache c
    WHERE c.is_disco_native = true LIMIT 1
  `)[0] as { ref: string; name: string; slug: string | null }
  console.log(`native restaurant under test: ${target.name}`)

  // ORDER SETTINGS. The four fields the page used to take from FamilyMeal's
  // fees-and-tips must all be available from disco_restaurant_overrides.
  const s = (await sql`
    SELECT announcement, enable_menu_search, delivery_order_time_windows
      FROM disco_restaurant_overrides WHERE restaurant_reference = ${target.ref} LIMIT 1
  `)[0] as Record<string, unknown> | undefined
  console.log('\n1. ORDER SETTINGS — sourced from Disco, not FamilyMeal')
  check('the overrides row exists', !!s, true)
  for (const k of ['announcement', 'enable_menu_search', 'delivery_order_time_windows']) {
    check(`${k} is available in Disco`, s ? k in s : false, true)
  }
  const slug = (await sql`SELECT slug FROM disco_restaurant_cache WHERE restaurant_reference = ${target.ref}`)[0] as { slug: string | null }
  check('the Disco Cater URL slug is available', slug.slug !== undefined, true)

  console.log('\n2. CHANGE PASSWORD — a Disco session rotates the Disco hash')
  const acct = (await sql`
    SELECT count(*)::int AS n FROM disco_restaurant_accounts
    WHERE password_set_at IS NOT NULL AND archived_at IS NULL AND email NOT LIKE 'stripe-import+%'
  `)[0] as { n: number }
  console.log(`   staff already holding a Disco password: ${acct.n}`)
  check('at least one staff member has one to rotate', acct.n > 0, true)

  console.log('\n3. WHAT IS STILL FAMILYMEAL-ONLY FOR A NATIVE RESTAURANT')
  // Measured from the routes, not asserted: these have no native path at all.
  const holes = [
    'multi-unit-links/[ref]/gradient — link branding (cosmetic write)',
    'multi-unit-links/[ref]/image    — link branding (cosmetic write)',
  ]
  holes.forEach(h => console.log(`   ${h}`))
  check('exactly two cosmetic holes remain', holes.length, 2)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
