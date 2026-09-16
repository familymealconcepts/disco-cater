/**
 * Verifies super admin's System Admin list now includes Disco-native accounts.
 *
 * A converted restaurant is Disco-native — Disco owns its people. The endpoint
 * proxied FM alone, so every Disco-native SYSTEM_ADMIN was invisible. This runs
 * the exact query the route runs and asserts the ones that were missing are back.
 *
 *   npx tsx scripts/verify-system-admins-merge.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — ${detail}`}`)
}

async function main() {
  // EXACTLY the query in app/api/admin/system-admins/route.ts
  const rows = (await sql`
    SELECT a.email, a.first_name, a.last_name,
           COALESCE(
             json_agg(
               json_build_object('reference', g.restaurant_reference, 'businessName', c.name)
               ORDER BY c.name
             ) FILTER (WHERE g.restaurant_reference IS NOT NULL),
             '[]'
           ) AS managed
      FROM disco_restaurant_accounts a
      LEFT JOIN disco_restaurant_location_access g ON lower(g.account_email) = lower(a.email)
      LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = g.restaurant_reference
     WHERE a.role = 'SYSTEM_ADMIN'
       AND a.archived_at IS NULL
       AND a.email NOT LIKE 'stripe-import+%'
     GROUP BY a.email, a.first_name, a.last_name
  `) as Array<{ email: string; first_name: string | null; last_name: string | null; managed: { reference: string; businessName: string | null }[] }>

  console.log(`\n=== Disco-native SYSTEM_ADMINs the list now carries: ${rows.length} ===`)
  for (const r of rows.slice(0, 12)) {
    const names = (r.managed || []).map(m => m.businessName).filter(Boolean)
    console.log(`   ${String(r.email).padEnd(38)} ${String((r.first_name || '') + ' ' + (r.last_name || '')).trim().padEnd(20)} ${r.managed.length} location(s)${names.length ? ': ' + names.slice(0, 3).join(', ') : ''}`)
  }
  if (rows.length > 12) console.log(`   ...and ${rows.length - 12} more`)

  console.log('\n=== the reported case ===')
  const rita = rows.find(r => r.email.toLowerCase() === 'rita.jones@eggbred.com')
  check('rita.jones@eggbred.com appears in the System Admin list', !!rita, 'still missing')
  if (rita) {
    check('  ...with her real name', `${rita.first_name} ${rita.last_name}`.trim() === 'Rita Jones', `${rita.first_name} ${rita.last_name}`)
    check('  ...and both location grants', rita.managed.length === 2, `${rita.managed.length} grant(s)`)
    console.log('     locations:', rita.managed.map(m => m.businessName).join(', '))
  }

  console.log('\n=== reach comes from grants, never the anchor ===')
  const anchor = (await sql`
    SELECT restaurant_reference, business_name FROM disco_restaurant_accounts WHERE email = 'rita.jones@eggbred.com'
  `) as { restaurant_reference: string; business_name: string | null }[]
  const anchorName = (await sql`
    SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${anchor[0].restaurant_reference}
  `) as { name: string }[]
  console.log(`   anchor restaurant_reference -> ${anchorName[0]?.name}`)
  console.log(`   stale business_name column  -> ${anchor[0].business_name}`)
  check('the two disagree, so the anchor is NOT a usable source of reach',
    anchorName[0]?.name !== anchor[0].business_name,
    'they happen to agree here, but grants remain the only correct source')

  console.log('\n' + '='.repeat(64))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
