import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
async function main(){
  const o:any[] = await sql`
    SELECT id, reference, order_number::text AS n, order_status, order_type, delivery_type,
           subtotal, total, fee, tips, tips_type, refund,
           customer_first_name||' '||customer_last_name AS who, customer_email,
           restaurant_name, restaurant_reference::text AS rref,
           to_char(order_date,'YYYY-MM-DD') AS order_date, order_time::text AS order_time,
           edit_count, edit_status, stripe_invoice_id, stripe_invoice_status,
           tax_exempt_id, tax_exempt_state, is_direct_entry,
           to_char(created_at,'YYYY-MM-DD HH24:MI') AS created,
           to_char(updated_at,'YYYY-MM-DD HH24:MI') AS updated
    FROM disco_orders WHERE order_number::text='900000148'`
  console.log('=== disco_orders ===')
  console.log(JSON.stringify(o[0],null,1))
  const id=o[0].id, ref=o[0].reference

  console.log('\n=== disco_sale_transactions (the money breakdown) ===')
  const t:any[] = await sql`
    SELECT id, transaction_type, status, subtotal, service_charge, state_tax, local_tax, other_tax,
           delivery_fee, tips, total, family_meal_fee, lead_gen_one_disco_fee, lead_gen_two_disco_fee,
           money_flow, source, stripe_fee, to_char(created_at,'YYYY-MM-DD HH24:MI') AS created
    FROM disco_sale_transactions WHERE order_id=${id} ORDER BY id`
  for(const x of t) console.log(JSON.stringify(x))

  console.log('\n=== line items ===')
  const i:any[] = await sql`
    SELECT id, meal_package_reference, name, quantity, price_per_unit, total_price
    FROM disco_order_items WHERE order_id=${id} ORDER BY id`
  for(const x of i) console.log(`   #${x.id}  ${String(x.name).slice(0,46).padEnd(48)} qty=${x.quantity} unit=$${x.price_per_unit} total=$${x.total_price}`)

  console.log('\n=== add-ons ===')
  const a:any[] = await sql`
    SELECT ia.order_item_id, ia.name, ia.quantity, ia.price
    FROM disco_order_item_addons ia JOIN disco_order_items it ON it.id=ia.order_item_id
    WHERE it.order_id=${id} ORDER BY ia.id`.catch(()=>[])
  console.log(a.length ? a.map(x=>`   item#${x.order_item_id} ${x.name} x${x.quantity} $${x.price}`).join('\n') : '   (none)')

  console.log('\n=== edit history ===')
  const e:any[] = await sql`
    SELECT to_char(created_at,'YYYY-MM-DD HH24:MI') AS t, editor_email, edit_type, delta,
           original_total, new_total, payment_action, payment_status, stripe_refund_id
    FROM disco_order_edits WHERE fm_order_reference=${ref}::uuid ORDER BY created_at`
  for(const x of e) console.log('   ', JSON.stringify(x))

  console.log('\n=== restaurant rates (for recomputation) ===')
  const r:any[] = await sql`
    SELECT o.tax_rates, o.money_flow, o.stripe_account_id IS NOT NULL AS linked
    FROM disco_restaurant_overrides o WHERE o.restaurant_reference=${o[0].rref}`
  console.log('   ', JSON.stringify(r[0]))
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
