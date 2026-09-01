/**
 * Role gates reach — the three READ paths that used to honour raw grant rows.
 *
 * An ADMIN has exactly one location no matter how many grants they hold; a
 * SYSTEM_ADMIN has exactly the set they're granted. Exercises the real code
 * paths (report-scope's sanitizer, and the exact ref-resolution both
 * /api/restaurant/team and /api/restaurant/locations now perform) against real
 * accounts, and asserts both directions.
 *
 *   npx tsx scripts/verify-role-gated-reach.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { getLocationAccessRefs, discoGroupRefs } from '../lib/disco-restaurant-auth'
import { resolveDiscoAccessScope, resolveDiscoGroupScope } from '../lib/restaurant-write-scope'
import { sanitizeReportFilter } from '../lib/reports/report-scope'
import type { RestaurantAuthContext } from '../lib/restaurant-auth-context'

const SUBJECTS = [
  'stacy.freemyer@atlantabreadwoodstock.com', // ADMIN, 8 grants, FM gives 1
  'southcobb@atlantabread.com',               // ADMIN, 8 grants, FM gives 1
  'barbara@graciousbakery.com',               // SYSTEM_ADMIN, 2 grants
  'cory@dechecos.com',                        // SYSTEM_ADMIN, 6 grants
  'kjp@atlantabread.com',                     // SYSTEM_ADMIN, 9 grants
]

let fails = 0
const check = (l: string, ok: boolean, extra = '') => { if (!ok) fails++; console.log(`      ${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ` — ${extra}` : ''}`) }

async function main() {
  for (const email of SUBJECTS) {
    const a = (await sql`
      SELECT role, business_name, restaurant_reference FROM disco_restaurant_accounts WHERE email = ${email} LIMIT 1
    `) as { role: string | null; business_name: string | null; restaurant_reference: string | null }[]
    if (!a.length) { console.log(`\n   ${email} — no account row, skipped`); continue }
    const anchor = a[0].restaurant_reference || ''
    const ctx = {
      restaurantReference: anchor, email, firstName: null, lastName: null, restaurantName: null,
      authType: 'disco', fmToken: null, role: a[0].role, businessName: a[0].business_name,
    } as RestaurantAuthContext
    const grants = await getLocationAccessRefs(email)
    const isSA = ctx.role === 'SYSTEM_ADMIN' || ctx.role === 'SUPER_ADMIN'
    const expected = isSA ? grants.length : 1

    console.log(`\n   ${email}  role=${ctx.role}  grant rows=${grants.length}  → expect reach ${expected}`)

    // report-scope: hand it every granted ref and see what survives.
    const f = await sanitizeReportFilter(ctx, anchor, { locationReferenceIds: grants })
    const kept = (f.locationReferenceIds || []).length
    check(`scheduled report accepts ${expected} location(s)`, kept === expected, `kept ${kept}`)

    // /api/restaurant/team — the exact resolution the route now performs.
    const accGate = await resolveDiscoAccessScope(ctx)
    let teamRefs = accGate.unrestricted ? await getLocationAccessRefs(email) : [...accGate.refs]
    if (!teamRefs.length && anchor) teamRefs = [anchor]
    check(`team page shows ${expected} location(s)`, teamRefs.length === expected, `got ${teamRefs.length}`)

    // /api/restaurant/locations — likewise.
    const grpGate = await resolveDiscoGroupScope(ctx)
    const reachable = grpGate.unrestricted ? await discoGroupRefs(ctx.businessName, email, anchor) : grpGate.refs
    const locRefs = [...new Set([anchor, ...reachable].filter(Boolean))]
    check(`locations list shows ${expected} location(s)`, locRefs.length === expected, `got ${locRefs.length}`)

    if (!isSA) {
      // The specific exposure: none of the OTHER granted refs may be reachable.
      const others = grants.filter(r => r !== anchor)
      const leaked = others.filter(r => teamRefs.includes(r) || locRefs.includes(r) || (f.locationReferenceIds || []).includes(r))
      check(`none of the ${others.length} non-home granted refs leak`, leaked.length === 0, leaked.length ? `${leaked.length} leaked` : '')
      check('the one location shown IS their home/anchor', teamRefs[0] === anchor && locRefs[0] === anchor)
    } else {
      // A SYSTEM_ADMIN must lose nothing.
      const missing = grants.filter(r => !locRefs.includes(r))
      check('every granted location still appears', missing.length === 0, missing.length ? `${missing.length} missing` : '')
    }
  }
  console.log('\n' + '='.repeat(62))
  console.log(fails === 0 ? 'ROLE GATES REACH — ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
