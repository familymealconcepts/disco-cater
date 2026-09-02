/**
 * "Ready to convert" and "safe to price" must agree, and must accept an explicit
 * 0% while refusing a restaurant with no rate anywhere.
 *
 * Four real cases, chosen because each breaks a different naive predicate:
 *   DeCheco's      explicit 0 everywhere  → converts, prices at 0%   (a state-only
 *                                            gate that blocked on a zero SUM
 *                                            would wrongly refuse it)
 *   Tenkatori      0 state + 9.75 local   → converts, prices at 9.75% (a state-only
 *                                            gate reports the wrong number)
 *   Pine and Crane null state + 9.75 local → configured; would have 409'd on every
 *                                            order under a state-only taxReliable
 *   tax_rates NULL nothing anywhere       → still blocked, and checkout still refuses
 *
 *   npx tsx scripts/verify-tax-gate.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql } from '../lib/db'
import { effectiveTaxPercent, isTaxConfigured } from '../lib/pricing/tax-config'
import { loadNativePricingConfig } from '../lib/pricing/native-order'
import { checkConversionReadiness, carryOverTaxRates } from '../lib/native-conversion'

let fails = 0
const check = (l: string, ok: boolean, extra = '') => { if (!ok) fails++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ` — ${extra}` : ''}`) }

async function main() {
  console.log('── the shared predicate: 0 is an answer, null is the absence of one')
  check('no object → not configured', !isTaxConfigured(null))
  check('all-null fields → not configured', !isTaxConfigured({ stateSalesTax: { percent: null }, localSalesTax: { percent: null }, otherSalesTax: { percent: null } }))
  check('explicit zeros → CONFIGURED (DeCheco\'s shape)', isTaxConfigured({ stateSalesTax: { percent: 0 }, localSalesTax: { percent: 0 }, otherSalesTax: { percent: 0 } }))
  check('   ...and its effective rate is 0, not null', effectiveTaxPercent({ stateSalesTax: { percent: 0 }, localSalesTax: { percent: 0 } }) === 0)
  check('local only, no state → CONFIGURED (Pine and Crane shape)', isTaxConfigured({ localSalesTax: { percent: 9.75 } }))
  check('   ...and sums to 9.75', effectiveTaxPercent({ localSalesTax: { percent: 9.75 } }) === 9.75)
  check('other only → CONFIGURED (Messy shape)', isTaxConfigured({ otherSalesTax: { percent: 8.875 } }))
  check('state 0 + local 9.75 → 9.75 (Tenkatori shape)', effectiveTaxPercent({ stateSalesTax: { percent: 0 }, localSalesTax: { percent: 9.75 } }) === 9.75)

  console.log('\n── real restaurants: the gate and the pricing path must agree')
  const CASES: [string, string, { configured: boolean; effective: number | null }][] = [
    ["DeCheco's Fairlawn (explicit 0)", 'c42d8232-2cef-4f34-be9c-1705d4b48393', { configured: true, effective: 0 }],
    ['Tenkatori Sawtelle (0 state + 9.75 local)', 'f3f3a00b-2fa3-4d86-b31a-e7abf79a7eda', { configured: true, effective: 9.75 }],
  ]
  // Pine and Crane + a NULL case, looked up by name so the test survives re-seeding.
  const extra = (await sql`
    SELECT c.name, c.restaurant_reference AS ref,
           (o.tax_rates IS NULL) AS is_null
      FROM disco_restaurant_cache c JOIN disco_restaurant_overrides o USING (restaurant_reference)
     WHERE c.name IN ('Pine and Crane DTLA', 'Lee''s Chinese Food')
     ORDER BY c.name
  `) as { name: string; ref: string; is_null: boolean }[]

  for (const [label, ref, expect] of CASES) {
    const t = (await sql`SELECT tax_rates FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref}`) as { tax_rates: unknown }[]
    const rates = t[0]?.tax_rates as never
    console.log(`\n   ${label}`)
    check('   configured as expected', isTaxConfigured(rates) === expect.configured)
    check('   effective rate as expected', effectiveTaxPercent(rates) === expect.effective, String(effectiveTaxPercent(rates)))
    const { taxReliable, cfg } = await loadNativePricingConfig(ref)
    check('   checkout would price it (taxReliable)', taxReliable === expect.configured)
    const charged = cfg.stateTax.percent + cfg.localTax.percent + cfg.otherTax.percent
    check(`   checkout charges ${expect.effective}%`, charged === expect.effective, `${charged}%`)
    const r = await checkConversionReadiness(ref)
    const step = r.steps.find(s => s.key === 'settings')
    check('   conversion gate passes', step?.done === true, step?.detail?.slice(0, 90))
  }

  for (const e of extra) {
    const t = (await sql`SELECT tax_rates FROM disco_restaurant_overrides WHERE restaurant_reference = ${e.ref}`) as { tax_rates: unknown }[]
    const rates = t[0]?.tax_rates as never
    const { taxReliable, cfg } = await loadNativePricingConfig(e.ref)
    const charged = cfg.stateTax.percent + cfg.localTax.percent + cfg.otherTax.percent
    console.log(`\n   ${e.name} (tax_rates ${e.is_null ? 'NULL' : 'present'})`)
    if (e.is_null) {
      check('   NOT configured', !isTaxConfigured(rates))
      check('   checkout REFUSES to price (taxReliable false)', taxReliable === false)
    } else {
      check('   configured (local only)', isTaxConfigured(rates))
      check('   checkout would price it — the 409 that state-only caused is gone', taxReliable === true)
      check('   and it charges the real local rate, not 0%', charged > 0, `${charged}%`)
    }
  }

  // ── the carry-over guard: the fourth call site on the same predicate ──────
  // Exercised WITHOUT writing, by handing carryOverTaxRates a walled result whose
  // read failed — it must refuse before touching the DB. The accept/refuse
  // decision itself is isTaxConfigured, already covered exhaustively above.
  console.log('\n── carryOverTaxRates refuses only when nothing is configured')
  const shapes: [string, unknown, boolean][] = [
    ['0 state + 9.75 local (Tenkatori)', { stateSalesTax: { percent: 0 }, localSalesTax: { percent: 9.75 } }, true],
    ['explicit zeros (DeCheco\'s)', { stateSalesTax: { percent: 0 }, localSalesTax: { percent: 0 }, otherSalesTax: { percent: 0 } }, true],
    ['local only, no state (Pine and Crane)', { localSalesTax: { percent: 9.75 } }, true],
    ['all null', { stateSalesTax: { percent: null }, localSalesTax: { percent: null } }, false],
  ]
  for (const [label, rates, shouldCarry] of shapes) {
    check(`   would carry "${label}"`, isTaxConfigured(rates as never) === shouldCarry)
  }
  // And the real refusal path, which must not throw or write.
  const refused = await carryOverTaxRates('00000000-0000-0000-0000-000000000000', { ok: false, reason: 'test', taxRate: null, notifications: null, closedDays: null, promoCode: null, authorizedUsers: null } as never)
  check('   no FM read → refuses, does not throw', refused.carried === false, refused.reason.slice(0, 60))

  console.log('\n' + '='.repeat(64))
  console.log(fails === 0 ? 'TAX CONFIG VERIFIED — gate, pricing and carry-over agree' : `${fails} CHECK(S) FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
