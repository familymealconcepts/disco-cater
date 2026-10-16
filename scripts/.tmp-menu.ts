import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
const RREF='ab44411b-2154-479f-9b49-d8b1f740c04c'
async function main(){
  console.log('=== Two Hands - NoHo menu items matching prosciutto / baguette ===')
  const m:any[] = await sql`
    SELECT reference, name, price, visible FROM disco_menu_items
    WHERE restaurant_reference=${RREF}::uuid AND (name ILIKE '%prosciutto%' OR name ILIKE '%baguette%')
    ORDER BY name`
  for(const x of m) console.log(`   $${String(x.price).padStart(7)}  visible=${x.visible}  ${x.name}`)
  if(!m.length) console.log('   (no match — the baguette item may not exist on the native menu)')

  console.log('\n=== anything priced exactly 90 ===')
  const n:any[] = await sql`SELECT name, price FROM disco_menu_items WHERE restaurant_reference=${RREF}::uuid AND price=90 ORDER BY name`
  for(const x of n) console.log(`   $${x.price}  ${x.name}`)

  console.log('\n=== EXACT RECOMPUTATION (rates from this order / stored config) ===')
  const SVC=0.05, FEE=0.03, TAX=0.08875
  const r2=(v:number)=>Math.round(v*100)/100
  const cur={sub:555.00, svc:27.75, tax:51.72, fee:16.65, total:651.12}
  const nsub=r2(cur.sub-20)
  const nsvc=r2(nsub*SVC)
  const ntax=r2((nsub+nsvc)*TAX)
  const nfee=r2(nsub*FEE)
  const ntot=r2(nsub+nsvc+ntax+nfee)
  console.log(`                 current      new       change`)
  console.log(`   subtotal      ${cur.sub.toFixed(2).padStart(8)}  ${nsub.toFixed(2).padStart(8)}  ${(nsub-cur.sub).toFixed(2).padStart(8)}`)
  console.log(`   service 5%    ${cur.svc.toFixed(2).padStart(8)}  ${nsvc.toFixed(2).padStart(8)}  ${(nsvc-cur.svc).toFixed(2).padStart(8)}`)
  console.log(`   tax 8.875%    ${cur.tax.toFixed(2).padStart(8)}  ${ntax.toFixed(2).padStart(8)}  ${(ntax-cur.tax).toFixed(2).padStart(8)}`)
  console.log(`   FM fee 3%     ${cur.fee.toFixed(2).padStart(8)}  ${nfee.toFixed(2).padStart(8)}  ${(nfee-cur.fee).toFixed(2).padStart(8)}`)
  console.log(`   tips              0.00      0.00      0.00`)
  console.log(`   TOTAL         ${cur.total.toFixed(2).padStart(8)}  ${ntot.toFixed(2).padStart(8)}  ${(ntot-cur.total).toFixed(2).padStart(8)}`)
  console.log(`\n   >>> OWED TO THE CUSTOMER: $${(cur.total-ntot).toFixed(2)}`)
  console.log(`   (already refunded separately: $41.06 — this is additional)`)
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
