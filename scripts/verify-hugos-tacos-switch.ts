// Can Bill Kohne switch between his two Hugo's Tacos locations on a FamilyMeal
// login? Exercises the REAL refusal check (nativeSelectionAllowed) against
// FamilyMeal's REAL answer about what he manages — nothing is stubbed and the
// check itself is unchanged.
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { readUserAssignment } from '../lib/fm-master-admin-read'
import { nativeSelectionAllowed } from '../lib/native-selection-scope'

const TACOS_SC = '37ebb7c3-89bf-4c88-8d73-9e650a69321c'
const TACOS_AV = 'a090483e-d22a-4d72-b29c-9b8970676822'
const HUGOS_SC = 'ef8ffaf5-6f65-4761-91ce-8b6ca587970f'   // the OTHER business
const HUGOS_WH = '0c1a5b5d-5156-4e78-9f1b-a624425ebbda'

let pass = 0, fail = 0
const check = (label: string, got: boolean, want: boolean) => {
  const ok = got === want
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} -> ${got ? 'ALLOWED' : 'REFUSED'}${ok ? '' : ` (wanted ${want ? 'ALLOWED' : 'REFUSED'})`}`)
}

async function main() {
  const a = await readUserAssignment('stucity@hugostacos.com', 'SYSTEM_ADMIN')
  const permitted = new Set(a.restaurantReferences)
  console.log(`FamilyMeal says stucity@hugostacos.com manages ${permitted.size} restaurant(s) (source: ${a.source})`)
  console.log(`  Tacos Studio City: ${permitted.has(TACOS_SC)}   Tacos Atwater: ${permitted.has(TACOS_AV)}`)

  console.log('\nBill, on a FamilyMeal login, switching:')
  check('to Hugo\'s Tacos Studio City  ', await nativeSelectionAllowed(TACOS_SC, permitted), true)
  check('to Hugo\'s Tacos Atwater Villg', await nativeSelectionAllowed(TACOS_AV, permitted), true)

  // THE CHECK MUST STILL REFUSE. Hugo's Restaurant is a different business with
  // its own login; linking the two chains together would have "fixed" Bill by
  // handing him someone else's restaurants.
  console.log('\nThe refusal still works — a different business stays out of reach:')
  check('to Hugo\'s Studio City        ', await nativeSelectionAllowed(HUGOS_SC, permitted), false)
  check('to Hugo\'s West Hollywood     ', await nativeSelectionAllowed(HUGOS_WH, permitted), false)

  // And the other chain's own admin can switch within THEIR two.
  const b = await readUserAssignment('contact@hugosrestaurant.com', 'SYSTEM_ADMIN')
  const permittedB = new Set(b.restaurantReferences)
  console.log(`\nHugo's Restaurant admin manages ${permittedB.size} restaurant(s):`)
  check('to Hugo\'s Studio City        ', await nativeSelectionAllowed(HUGOS_SC, permittedB), true)
  check('to Hugo\'s West Hollywood     ', await nativeSelectionAllowed(HUGOS_WH, permittedB), true)
  check('to Hugo\'s Tacos Studio City  ', await nativeSelectionAllowed(TACOS_SC, permittedB), false)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
