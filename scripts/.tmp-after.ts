import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
async function main(){
  const o:any[] = await sql`SELECT subtotal,total,fee,tips,refund,order_status FROM disco_orders WHERE id=29248`
  console.log('=== disco_orders ==='); console.log(JSON.stringify(o[0],null,1))
  const t:any[] = await sql`SELECT subtotal,service_charge,state_tax,local_tax,other_tax,fee,tips_in_price,total FROM disco_sale_transactions WHERE order_id=29248 AND transaction_type='ORIGINAL'`
  console.log('\n=== ORIGINAL sale transaction ==='); console.log(JSON.stringify(t[0],null,1))
  const i:any[] = await sql`SELECT id,name,quantity,price_per_unit,total_price FROM disco_order_items WHERE order_id=29248 ORDER BY id`
  console.log('\n=== line items ===')
  let s=0; for(const x of i){ s+=Number(x.total_price); console.log(`   ${String(x.name).slice(0,48).padEnd(50)} qty=${x.quantity} unit=${x.price_per_unit} total=${x.total_price}`) }
  console.log(`   items sum = $${s.toFixed(2)}  vs stored subtotal $${o[0].subtotal}  ${Math.abs(s-Number(o[0].subtotal))<0.005?'RECONCILES':'MISMATCH'}`)
  const x=t[0]
  const sum=Number(x.subtotal)+Number(x.service_charge)+Number(x.state_tax)+Number(x.local_tax)+Number(x.other_tax)+Number(x.fee)+Number(x.tips_in_price)
  console.log(`\n   components sum = $${sum.toFixed(2)} vs stored total $${x.total}  ${Math.abs(sum-Number(x.total))<0.005?'RECONCILES':'MISMATCH'}`)
  console.log(`\n   OWED TO CUSTOMER: $${(651.12-Number(x.total)).toFixed(2)}`)
  console.log(`   refund column still records only the earlier refund: $${o[0].refund}`)
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
