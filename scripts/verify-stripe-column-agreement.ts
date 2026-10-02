// The three surfaces that answer "can this restaurant take a payment?" must
// agree. They did not: the super-admin Ordering list read FamilyMeal's
// stripe_connected probe while the customer checkout gate and the restaurant
// portal both read Disco's own connected account.
//
// Simulates each surface's predicate over the REAL fleet and asserts they match.
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'
import { stripeStatusByReference } from '../lib/stripe-account-status'
import { assertRestaurantOrderable } from '../lib/restaurant-orderable'

let pass = 0, fail = 0
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

const AL_VOLO = '80ed44ce-96c4-4d36-97a2-ca29f37b5179'
const REALMUTO = 'af24fb4d-6557-4c3a-98a6-0f5b46eeaf0d'

/** The ADMIN column, as it now renders: native reads the resolver, FM-backed the probe. */
function adminColumn(native: boolean, state: string, fmConnected: boolean, hasAcct: boolean): string {
  if (native) {
    if (state === 'restricted') return 'Restricted'
    if (state === 'at-risk') return 'At risk'
    if (state === 'connected') return 'Connected'
    if (state === 'unknown') return 'Unknown'
    return 'Not connected'
  }
  return (hasAcct || fmConnected) ? 'Connected' : 'Not connected'
}

async function main() {
  console.log('1. AL VOLO AND REALMUTO')
  for (const [name, ref] of [['Al Volo', AL_VOLO], ['Realmuto Pasticceria', REALMUTO]] as [string, string][]) {
    const o = (await sql`
      SELECT o.stripe_account_id, o.stripe_connected, o.stripe_status, c.is_disco_native
      FROM disco_restaurant_cache c LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference=c.restaurant_reference
      WHERE c.restaurant_reference=${ref}`)[0] as any
    const st = await stripeStatusByReference(sql, [ref])
    const gate = await assertRestaurantOrderable(ref)
    const col = adminColumn(!!o.is_disco_native, st[ref]?.state ?? 'no-account', !!o.stripe_connected, !!o.stripe_account_id)
    console.log(`\n   ${name}`)
    console.log(`      account id        : ${o.stripe_account_id ?? 'NULL'}`)
    console.log(`      FM stripe_connected: ${o.stripe_connected}`)
    console.log(`      resolver state    : ${st[ref]?.state}`)
    console.log(`      admin column      : ${col}`)
    console.log(`      portal column     : ${st[ref]?.state === 'no-account' ? 'Not connected' : st[ref]?.state}`)
    console.log(`      customer page     : ${gate.reason}`)
    check(`${name}: admin column says Not connected`, col, 'Not connected')
    check(`${name}: portal agrees`, st[ref]?.state, 'no-account')
    check(`${name}: customer page refuses`, gate.reason, 'payment-not-configured')
  }

  console.log('\n2. THE TWO RESTAURANTS DO NOT SHARE AN ACCOUNT')
  const shared = (await sql`
    SELECT count(*)::int AS n FROM disco_restaurant_overrides
    WHERE restaurant_reference IN (${AL_VOLO}, ${REALMUTO}) AND stripe_account_id IS NOT NULL`)[0] as { n: number }
  check('neither holds a Stripe account in Disco', shared.n, 0)
  const acct = (await sql`
    SELECT count(*)::int AS n FROM disco_restaurant_overrides WHERE stripe_account_id = 'acct_1TyXnIKTNuY1rXIb'`)[0] as { n: number }
  check('acct_1TyXnIKTNuY1rXIb is not linked anywhere in Disco', acct.n, 0)

  console.log('\n3. FLEET — the admin column and the customer gate now agree on every native row')
  const rows = (await sql`
    SELECT c.restaurant_reference::text AS ref, c.name,
           COALESCE(o.stripe_connected,false) AS fm_connected,
           (o.stripe_account_id IS NOT NULL) AS has_acct
    FROM disco_restaurant_cache c
    JOIN disco_restaurant_overrides o ON o.restaurant_reference=c.restaurant_reference
    WHERE c.is_disco_native AND o.archived_at IS NULL
      AND COALESCE(o.visible,false) AND COALESCE(o.online_ordering_enabled,false)`) as any[]
  const states = await stripeStatusByReference(sql, rows.map(r => r.ref))

  // THE INVARIANT. The customer gate refuses exactly when no Stripe account is
  // linked (lib/restaurant-orderable.ts: nativePaymentUnconfigured), so the
  // column must read "Not connected" on exactly those rows and never on others.
  //
  // 'unknown' is deliberately NOT a disagreement: an account IS linked but its
  // capability snapshot has not been fetched, so the gate lets the order through
  // and the column honestly declines to claim health. 'restricted' likewise --
  // the account exists, the gate allows, and Stripe will decline the charge. The
  // column's job is to say which, not to predict Stripe.
  let disagreeNow = 0, disagreeBefore = 0
  for (const r of rows) {
    const state = states[r.ref]?.state ?? 'no-account'
    const gateRefuses = !r.has_acct
    const beforeSaidNotConnected = !(r.fm_connected || r.has_acct)
    const afterSaidNotConnected = adminColumn(true, state, r.fm_connected, r.has_acct) === 'Not connected'
    if (beforeSaidNotConnected !== gateRefuses) disagreeBefore++
    if (afterSaidNotConnected !== gateRefuses) disagreeNow++
  }
  console.log(`   native + visible + ordering-on rows: ${rows.length}`)
  console.log(`   rows where the OLD admin column disagreed with the customer gate: ${disagreeBefore}`)
  console.log(`   rows where the NEW admin column disagrees:                        ${disagreeNow}`)
  check('the new column agrees with the customer gate on every native row', disagreeNow, 0)
  check('the old column genuinely disagreed (this was a real defect)', disagreeBefore > 100, true)

  console.log('\n4. RESTRICTED IS DISTINGUISHABLE FROM ABSENT')
  const byState: Record<string, number> = {}
  for (const r of rows) { const s = states[r.ref]?.state ?? 'no-account'; byState[s] = (byState[s] ?? 0) + 1 }
  console.log(`   ${JSON.stringify(byState)}`)
  check('"restricted" and "no-account" are different column values',
    adminColumn(true, 'restricted', true, true) !== adminColumn(true, 'no-account', true, false), true)
  check('a restricted account does not read Connected', adminColumn(true, 'restricted', true, true), 'Restricted')
  check('an at-risk account reads At risk, not Connected', adminColumn(true, 'at-risk', true, true), 'At risk')

  console.log('\n5. FM-BACKED ROWS ARE UNCHANGED')
  check('FM-backed with FM probe true still reads Connected', adminColumn(false, 'no-account', true, false), 'Connected')
  check('FM-backed with nothing reads Not connected', adminColumn(false, 'no-account', false, false), 'Not connected')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
