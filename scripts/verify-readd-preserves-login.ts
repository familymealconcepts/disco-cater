/**
 * Does re-adding an EXISTING peer through Authorized Users break their login?
 *
 * The lead-SYSTEM_ADMIN pattern in the runbook depends on this: a lead re-adds a
 * peer by the same email, the POST's ON CONFLICT adopts them (sets created_by)
 * and grants locations — but it also issues a FRESH set-password invite. If that
 * invalidated the existing password, the pattern would break for everyone who has
 * already signed in, which is most of them.
 *
 * Creates a throwaway account, signs in over the REAL HTTP login route, replays
 * the exact mutation the sub-admins POST performs, signs in again, and cleans up.
 * Requires `npm run dev` on :3000.
 *
 *   npx tsx scripts/verify-readd-preserves-login.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { randomUUID } from 'crypto'
import { sql } from '../lib/db'
import { hashPassword, grantLocationAccess, setInviteToken, revokeLocationAccess } from '../lib/disco-restaurant-auth'

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000'
const EMAIL = `disco-readd-test+${randomUUID().slice(0, 8)}@discocater.com`
const PASSWORD = randomUUID() // never a real credential; discarded with the account

let fails = 0
const check = (l: string, ok: boolean, extra = '') => { if (!ok) fails++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ` — ${extra}` : ''}`) }

async function login(): Promise<{ status: number; ok: boolean }> {
  const res = await fetch(`${BASE}/api/disco-restaurant-auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  return { status: res.status, ok: res.ok }
}

async function cleanup() {
  await sql`DELETE FROM disco_restaurant_sessions WHERE email = ${EMAIL}`.catch(() => {})
  await sql`DELETE FROM disco_restaurant_location_access WHERE account_email = ${EMAIL}`.catch(() => {})
  await sql`DELETE FROM disco_restaurant_accounts WHERE email = ${EMAIL}`.catch(() => {})
}

async function main() {
  const r = (await sql`
    SELECT restaurant_reference AS ref, name FROM disco_restaurant_cache
     WHERE is_disco_native = true ORDER BY name LIMIT 2
  `) as { ref: string; name: string }[]
  if (r.length < 2) { console.log('need 2 native restaurants to test with'); process.exit(1) }
  const [home, second] = r
  console.log(`\n   test account : ${EMAIL}`)
  console.log(`   home         : ${home.name}`)
  console.log(`   re-added with: ${home.name} + ${second.name}\n`)

  try {
    // 1. Create with a real password, as an accepted (no open invite) account.
    await sql`
      INSERT INTO disco_restaurant_accounts (email, password_hash, restaurant_reference, first_name, last_name, role, created_by)
      VALUES (${EMAIL}, ${await hashPassword(PASSWORD)}, ${home.ref}, 'ReAdd', 'Test', 'ADMIN', 'verify-readd-script')
    `
    await grantLocationAccess(EMAIL, home.ref, 'verify-readd-script')

    const before = await login()
    check('BEFORE re-add: existing password logs in', before.ok, `HTTP ${before.status}`)
    if (!before.ok) { console.log('\n   aborting — baseline login failed, nothing to conclude'); await cleanup(); process.exit(1) }

    // 2. Replay EXACTLY what POST /api/restaurant/team/sub-admins does for an
    //    existing email: ON CONFLICT adopt, grant, then a fresh invite token.
    const leadEmail = 'lead-system-admin@example.test'
    await sql`
      INSERT INTO disco_restaurant_accounts (
        email, password_hash, restaurant_reference, first_name, last_name,
        restaurant_name, role, business_name, created_by, updated_at
      ) VALUES (
        ${EMAIL}, ${await hashPassword(randomUUID())}, ${home.ref}, 'ReAdd', 'Test',
        ${null}, 'SYSTEM_ADMIN', ${null}, ${leadEmail}, NOW()
      )
      ON CONFLICT (email) DO UPDATE SET
        role = 'SYSTEM_ADMIN', created_by = ${leadEmail},
        first_name = COALESCE(EXCLUDED.first_name, disco_restaurant_accounts.first_name),
        last_name = COALESCE(EXCLUDED.last_name, disco_restaurant_accounts.last_name),
        updated_at = NOW()
    `
    for (const ref of [home.ref, second.ref]) await grantLocationAccess(EMAIL, ref, leadEmail)
    const token = await setInviteToken(EMAIL)
    check('re-add issued a fresh invite token', !!token && token.length === 64)

    // 3. The question.
    const after = await login()
    check('AFTER re-add: the SAME existing password still logs in', after.ok, `HTTP ${after.status}`)

    // 4. And the adoption actually took effect.
    const row = (await sql`
      SELECT role, created_by, invite_token IS NOT NULL AS open_invite,
             (SELECT count(*)::int FROM disco_restaurant_location_access l WHERE l.account_email = ${EMAIL}) AS grants
        FROM disco_restaurant_accounts WHERE email = ${EMAIL}
    `) as { role: string; created_by: string; open_invite: boolean; grants: number }[]
    check('role updated to SYSTEM_ADMIN', row[0]?.role === 'SYSTEM_ADMIN', row[0]?.role)
    check('created_by set to the lead (adopted → editable by them)', row[0]?.created_by === leadEmail, row[0]?.created_by)
    check('both locations granted', row[0]?.grants === 2, String(row[0]?.grants))
    check('an invite is left open alongside the working password', row[0]?.open_invite === true)

    await revokeLocationAccess(EMAIL, second.ref)
  } finally {
    await cleanup()
    const gone = (await sql`SELECT count(*)::int AS n FROM disco_restaurant_accounts WHERE email = ${EMAIL}`) as { n: number }[]
    check('test account cleaned up', gone[0]?.n === 0)
  }

  console.log('\n' + '='.repeat(64))
  console.log(fails === 0 ? 'RE-ADD PRESERVES THE EXISTING LOGIN — lead pattern is safe' : `${fails} CHECK(S) FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch(async e => { console.error(e); await cleanup(); process.exit(1) })
