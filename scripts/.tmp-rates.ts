import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
const RREF='ab44411b-2154-479f-9b49-d8b1f740c04c'
async function main(){
  const r:any[] = await sql`SELECT tax_rates, lead_gen_one_percentage, lead_gen_two_percentage FROM disco_restaurant_overrides WHERE restaurant_reference=${RREF}`.catch(async()=>{
    return await sql`SELECT tax_rates FROM disco_restaurant_overrides WHERE restaurant_reference=${RREF}` })
  console.log('=== stored tax_rates for Two Hands - NoHo ===')
  console.log(JSON.stringify(r[0], null, 1))

  console.log('\n=== derived from the order\'s OWN stored figures ===')
  const sub=555.00, svc=27.75, tax=51.72, fee=16.65, total=651.12
  console.log(`   service charge / subtotal         = ${svc}/${sub} = ${(svc/sub*100).toFixed(4)}%`)
  console.log(`   FM fee / subtotal                 = ${fee}/${sub} = ${(fee/sub*100).toFixed(4)}%`)
  console.log(`   tax / subtotal                    = ${tax}/${sub} = ${(tax/sub*100).toFixed(4)}%`)
  console.log(`   tax / (subtotal+service)          = ${tax}/${(sub+svc).toFixed(2)} = ${(tax/(sub+svc)*100).toFixed(4)}%   <-- matches NYC 8.875%`)
  console.log(`   tax / (subtotal+service+fee)      = ${tax}/${(sub+svc+fee).toFixed(2)} = ${(tax/(sub+svc+fee)*100).toFixed(4)}%`)
  console.log(`   sum check: ${sub}+${svc}+${tax}+${fee} = ${(sub+svc+tax+fee).toFixed(2)} vs stored total ${total}`)

  console.log('\n=== line items vs stored subtotal ===')
  const i:any[] = await sql`SELECT id, name, quantity, price_per_unit, total_price FROM disco_order_items WHERE order_id=29248 ORDER BY id`
  let s=0; for(const x of i){ s+=Number(x.total_price) }
  console.log(`   items sum to $${s.toFixed(2)}, stored subtotal is $${sub.toFixed(2)}, difference $${(s-sub).toFixed(2)}`)
  for(const x of i){
    const expect=Number(x.price_per_unit)*Number(x.quantity)
    const flag = Math.abs(expect-Number(x.total_price))>0.005 ? `  <<< unit x qty = ${expect.toFixed(2)}, stored total ${x.total_price}` : ''
    console.log(`   #${x.id} ${String(x.name).slice(0,52).padEnd(54)} qty=${x.quantity} unit=${x.price_per_unit} total=${x.total_price}${flag}`)
  }
  console.log('\n=== does a $35 reduction reproduce the earlier $41.06 refund? ===')
  const d=35, nsub=sub-d, nsvc=+(nsub*0.05).toFixed(2), ntaxbase=nsub+nsvc, ntax=+(ntaxbase*0.08875).toFixed(2), nfee=+(nsub*0.03).toFixed(2)
  const ntot=+(nsub+nsvc+ntax+nfee).toFixed(2)
  console.log(`   subtotal ${sub}→${nsub}  svc ${nsvc}  tax ${ntax}  fee ${nfee}  total ${ntot}   delta = $${(total-ntot).toFixed(2)}`)
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
