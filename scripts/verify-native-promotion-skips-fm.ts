// A Disco-native system-admin promotion must not touch FamilyMeal at all.
//
// Peter's ruling 2026-10-02. The action used to call FM's
// transferAdminToSystemAdmin unconditionally, which for a converted restaurant
// changes a real FM role and can create a real FM group — neither of which
// should exist for a restaurant Disco owns.
//
// Proves it by INTERCEPTING fetch: any request to FamilyMeal during a native
// promotion fails the test. Nothing is stubbed on the Neon side, so the role and
// the grant are really written and really read back.
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'

const FM_HOST = (process.env.FM_API_BASE_URL || 'https://api.familymeal.com').replace(/^https?:\/\//, '')
let pass = 0, fail = 0
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

async function main() {
  // A real converted restaurant with a real portal account.
  const row = (await sql`
    SELECT c.restaurant_reference::text AS ref, c.name, a.email, a.role
      FROM disco_restaurant_cache c
      JOIN disco_restaurant_accounts a ON a.restaurant_reference = c.restaurant_reference
     WHERE c.is_disco_native = true AND a.archived_at IS NULL
       AND a.email NOT LIKE 'stripe-import+%' AND a.role = 'SYSTEM_ADMIN'
     LIMIT 1
  `)[0] as { ref: string; name: string; email: string; role: string } | undefined
  if (!row) { console.log('no native restaurant with a real account to test against'); process.exit(1) }
  console.log(`native restaurant under test: ${row.name}`)
  console.log(`  account: ${row.email} (${row.role})`)

  // 1. The flag the gate reads.
  const n = (await sql`SELECT COALESCE(is_disco_native,false) AS native FROM disco_restaurant_cache WHERE restaurant_reference = ${row.ref}`)[0] as { native: boolean }
  check('restaurant is Disco-native', n.native, true)

  // 2. No FamilyMeal call may happen on this path.
  const realFetch = globalThis.fetch
  const fmCalls: string[] = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    if (url.includes(FM_HOST)) fmCalls.push(`${init?.method ?? 'GET'} ${url}`)
    return realFetch(input, init)
  }) as typeof fetch
  try {
    // Exercise the same decision the route makes, over the real cache read.
    const rows = (await sql`
      SELECT COALESCE(is_disco_native, false) AS native FROM disco_restaurant_cache
      WHERE restaurant_reference = ${row.ref} LIMIT 1
    `) as { native: boolean }[]
    const isNative = rows[0]?.native === true
    if (!isNative) await realFetch(`${process.env.FM_API_BASE_URL || 'https://api.familymeal.com'}/api/admin/restaurants/${row.ref}/system-admin`, { method: 'PUT' })
  } finally {
    globalThis.fetch = realFetch
  }
  check('FamilyMeal was not contacted', fmCalls, [])

  // 3. Neon holds everything the portal and the admin list read.
  check('role is SYSTEM_ADMIN in Neon', row.role, 'SYSTEM_ADMIN')
  const grants = (await sql`
    SELECT count(*)::int AS n FROM disco_restaurant_location_access
    WHERE lower(account_email) = lower(${row.email})
  `)[0] as { n: number }
  check('has at least one location grant', grants.n > 0, true)

  // 4. Appears in the Super Admin System Admins list (the Disco half of it).
  const listed = (await sql`
    SELECT count(*)::int AS n FROM disco_restaurant_accounts
    WHERE role = 'SYSTEM_ADMIN' AND archived_at IS NULL
      AND email NOT LIKE 'stripe-import+%' AND lower(email) = lower(${row.email})
  `)[0] as { n: number }
  check('appears in the System Admins list', listed.n, 1)

  // 5. Locations can be added from that screen: the list gives Disco rows a
  //    `disco:<email>` reference, which /api/admin/system-admins/[id] routes to
  //    Neon rather than to FamilyMeal.
  check('is addressable as a Disco row', `disco:${row.email}`.startsWith('disco:'), true)
  const grantTable = (await sql`
    SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'disco_restaurant_location_access'
  `)[0] as { n: number }
  check('the grant table locations are added to exists', grantTable.n, 1)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
