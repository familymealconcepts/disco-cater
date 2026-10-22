// Can Bill Kohne switch between his two Hugo's Tacos locations on a FamilyMeal
// login? Since 22 Oct 2026 an FM-password System Admin reaches exactly their
// Disco list (getFmSessionPermittedRefs -> discoListForEmail); the multi-unit
// link rule this script used to exercise is gone. Same expectations, real data.
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { discoListForEmail } from '../lib/restaurant-auth'

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
  const permitted = await discoListForEmail('stucity@hugostacos.com')
  console.log(`Disco's list for stucity@hugostacos.com: ${permitted.size} restaurant(s)`)
  console.log(`  Tacos Studio City: ${permitted.has(TACOS_SC)}   Tacos Atwater: ${permitted.has(TACOS_AV)}`)

  console.log('\nBill, on a FamilyMeal login, switching:')
  check('to Hugo\'s Tacos Studio City  ', permitted.has(TACOS_SC), true)
  check('to Hugo\'s Tacos Atwater Villg', permitted.has(TACOS_AV), true)

  // THE CHECK MUST STILL REFUSE. Hugo's Restaurant is a different business with
  // its own login; linking the two chains together would have "fixed" Bill by
  // handing him someone else's restaurants.
  console.log('\nThe refusal still works — a different business stays out of reach:')
  check('to Hugo\'s Studio City        ', permitted.has(HUGOS_SC), false)
  check('to Hugo\'s West Hollywood     ', permitted.has(HUGOS_WH), false)

  // And the other chain's own admin can switch within THEIR two.
  const permittedB = await discoListForEmail('contact@hugosrestaurant.com')
  console.log(`\nHugo's Restaurant admin manages ${permittedB.size} restaurant(s):`)
  check('to Hugo\'s Studio City        ', permittedB.has(HUGOS_SC), true)
  check('to Hugo\'s West Hollywood     ', permittedB.has(HUGOS_WH), true)
  check('to Hugo\'s Tacos Studio City  ', permittedB.has(TACOS_SC), false)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
