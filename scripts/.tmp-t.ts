import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
async function main(){
  const c:any[] = await sql`SELECT column_name FROM information_schema.columns WHERE table_name='disco_sale_transactions' ORDER BY ordinal_position`
  console.log('sale_transactions cols:', c.map(x=>x.column_name).join(', '))
  const t:any[] = await sql`SELECT * FROM disco_sale_transactions WHERE order_id=29248 ORDER BY id`
  console.log(`\n=== ${t.length} transaction row(s) ===`)
  for(const x of t) console.log(JSON.stringify(x,null,1))
  const i:any[] = await sql`SELECT id, name, quantity, price_per_unit, total_price FROM disco_order_items WHERE order_id=29248 ORDER BY id`
  console.log('\n=== line items ===')
  for(const x of i) console.log(`   #${x.id}  ${String(x.name).slice(0,48).padEnd(50)} qty=${x.quantity} unit=$${x.price_per_unit} total=$${x.total_price}`)
  const e:any[] = await sql`SELECT to_char(created_at,'YYYY-MM-DD HH24:MI') AS t, editor_email, edit_type, delta, original_total, new_total, payment_action, payment_status, stripe_refund_id FROM disco_order_edits WHERE fm_order_reference='89b913af-1464-4b5e-b851-9bf012ec6cb6'::uuid ORDER BY created_at`
  console.log('\n=== edit history ===')
  for(const x of e) console.log('   ', JSON.stringify(x))
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
