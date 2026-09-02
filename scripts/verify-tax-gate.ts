/**
 * The tax gate must distinguish three cases that Neon stores identically:
 *   a real non-zero rate      → pass on Neon, no live read
 *   deliberately 0% (FM says 0) → pass, but only after FM confirms
 *   nothing configured (FM null) → BLOCK
 *
 *   npx tsx scripts/verify-tax-gate.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { effectiveTaxPercent, checkConversionReadiness } from '../lib/native-conversion'

let fails = 0
const check = (l: string, ok: boolean, extra = '') => { if (!ok) fails++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ` — ${extra}` : ''}`) }

async function main() {
  console.log('── effectiveTaxPercent: null means UNCONFIGURED, 0 means configured-at-zero')
  check('no object → null', effectiveTaxPercent(null) === null)
  check('all fields null → null', effectiveTaxPercent({ stateSalesTax: { percent: null }, localSalesTax: { percent: null }, otherSalesTax: { percent: null } }) === null)
  check('empty object → null', effectiveTaxPercent({}) === null)
  check('explicit zeros → 0, not null', effectiveTaxPercent({ stateSalesTax: { percent: 0 }, localSalesTax: { percent: 0 }, otherSalesTax: { percent: 0 } }) === 0)
  check('0 state + 9.75 local → 9.75 (the Tenkatori shape)', effectiveTaxPercent({ stateSalesTax: { percent: 0 }, localSalesTax: { percent: 9.75 } }) === 9.75)
  check('state only → that value', effectiveTaxPercent({ stateSalesTax: { percent: 8.1 } }) === 8.1)
  check('sums all three', effectiveTaxPercent({ stateSalesTax: { percent: 6 }, localSalesTax: { percent: 1.5 }, otherSalesTax: { percent: 0.25 } }) === 7.75)
  check('non-numeric ignored', effectiveTaxPercent({ stateSalesTax: { percent: NaN }, localSalesTax: { percent: 2 } }) === 2)

  console.log('\n── the gate, against real restaurants')
  const CASES: [string, string, boolean][] = [
    // label, ref, expected settings-step pass
    ['Tenkatori Sawtelle (0 state + 9.75 local)', 'f3f3a00b-2fa3-4d86-b31a-e7abf79a7eda', true],
    ['DeCheco’s Fairlawn (no rate anywhere, FM null)', 'c42d8232-2cef-4f34-be9c-1705d4b48393', false],
  ]
  for (const [label, ref, expected] of CASES) {
    const r = await checkConversionReadiness(ref)
    const step = r.steps.find(s => s.key === 'settings')
    console.log(`   ${label}`)
    console.log(`      settings step: ${step?.done ? 'PASS' : 'BLOCK'} — ${step?.detail}`)
    check(`   expected ${expected ? 'PASS' : 'BLOCK'}`, step?.done === expected)
  }
  console.log('\n' + '='.repeat(60))
  console.log(fails === 0 ? 'TAX GATE VERIFIED' : `${fails} CHECK(S) FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
