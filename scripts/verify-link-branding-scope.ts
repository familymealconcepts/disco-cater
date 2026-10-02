// Adversarial check on the locations-page branding guard.
//
// The routes take the link's slug from the REQUEST BODY, so the only thing
// standing between a caller and another chain's branding is this scope test.
// Verified against real links and real grants, from both session types, and
// including the failure paths — not just the happy one.
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
import { canBrandLink } from '../lib/locations/link-branding-scope'
import type { RestaurantAuthContext } from '../lib/restaurant-auth-context'

let pass = 0, fail = 0
const check = (label: string, got: boolean, want: boolean) => {
  const ok = got === want
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} -> ${got ? 'ALLOWED' : 'REFUSED'}${ok ? '' : `  (wanted ${want ? 'ALLOWED' : 'REFUSED'})`}`)
}
const disco = (email: string, ref: string, role: string): RestaurantAuthContext => ({
  restaurantReference: ref, email, firstName: null, lastName: null, restaurantName: null,
  authType: 'disco', fmToken: null, role, businessName: null,
} as RestaurantAuthContext)

async function main() {
  // Two real links owned by different people.
  const links = (await sql`
    SELECT k.slug, k.owner_email, array_agg(m.restaurant_reference::text) AS members
      FROM disco_multi_unit_links k
      JOIN disco_multi_unit_link_members m ON m.link_reference = k.reference
     GROUP BY k.slug, k.owner_email HAVING count(*) >= 2
     ORDER BY k.slug LIMIT 2
  `) as { slug: string; owner_email: string | null; members: string[] }[]
  if (links.length < 2) { console.log('need two multi-member links to test against'); process.exit(1) }
  const [A, B] = links
  console.log(`link A: ${A.slug} (${A.members.length} members)`)
  console.log(`link B: ${B.slug} (${B.members.length} members)`)

  // A real granted admin on link A.
  const granted = (await sql`
    SELECT lower(g.account_email) AS email, a.role
      FROM disco_restaurant_location_access g
      JOIN disco_restaurant_accounts a ON lower(a.email) = lower(g.account_email)
     WHERE g.restaurant_reference = ${A.members[0]} AND a.archived_at IS NULL
       AND a.email NOT LIKE 'stripe-import+%' LIMIT 1
  `)[0] as { email: string; role: string } | undefined

  console.log('\n1. A MEMBER MAY BRAND THEIR OWN PAGE')
  if (granted) {
    check(`${granted.email} on their own link`, (await canBrandLink(disco(granted.email, A.members[0], granted.role), A.slug)).allowed, true)
  } else {
    console.log('  (no granted admin found on link A — skipping)')
  }

  console.log('\n2. AND IS REFUSED SOMEONE ELSE\'S')
  if (granted) {
    check(`${granted.email} on link B`, (await canBrandLink(disco(granted.email, A.members[0], granted.role), B.slug)).allowed, false)
  }
  // An ADMIN whose own location is not in link A.
  check('an ADMIN anchored elsewhere', (await canBrandLink(disco('nobody@example.test', B.members[0], 'ADMIN'), A.slug)).allowed, false)

  console.log('\n3. A SYSTEM_ADMIN REACHES EXACTLY THEIR GRANTS')
  // Same identity, no grants at all → only their anchor counts.
  check('SYSTEM_ADMIN with no grants, anchored outside the link',
    (await canBrandLink(disco('no-grants@example.test', B.members[0], 'SYSTEM_ADMIN'), A.slug)).allowed, false)
  check('SYSTEM_ADMIN with no grants, anchored INSIDE the link',
    (await canBrandLink(disco('no-grants@example.test', A.members[0], 'SYSTEM_ADMIN'), A.slug)).allowed, true)

  console.log('\n4. THE FAILURE PATHS REFUSE')
  check('no session at all', (await canBrandLink(null, A.slug)).allowed, false)
  check('empty slug', (await canBrandLink(disco('x@example.test', A.members[0], 'ADMIN'), '')).allowed, false)
  check('unknown slug is not created', (await canBrandLink(disco('x@example.test', A.members[0], 'ADMIN'), 'no-such-chain-xyz')).allowed, false)
  // An FM session carries no Disco identity; with no FM cookie present in this
  // process there is no permitted set, so it must refuse rather than widen.
  const fmCtx = { restaurantReference: '', email: '', firstName: null, lastName: null, restaurantName: null,
    authType: 'fm', fmToken: 'x', role: null, businessName: null } as RestaurantAuthContext
  check('FM session with no resolvable permitted set', (await canBrandLink(fmCtx, A.slug)).allowed, false)

  console.log('\n5. SUPER_ADMIN IS THE ONLY UNRESTRICTED CASE')
  check('SUPER_ADMIN on any link', (await canBrandLink(disco('admin@discocater.com', A.members[0], 'SUPER_ADMIN'), B.slug)).allowed, true)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
