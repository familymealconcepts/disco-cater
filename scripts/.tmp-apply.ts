import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
const APPLY = process.argv.includes('--apply')
const ORDER=29248, RREF='ab44411b-2154-479f-9b49-d8b1f740c04c'
const r2=(v:number)=>Math.round(v*100)/100
async function main(){
  // Rates taken from THIS order's own stored figures / stored tax config.
  const SVC=0.05, FEE=0.03, TAX=0.08875
  const nsub=535.00, nsvc=r2(nsub*SVC), ntax=r2((nsub+nsvc)*TAX), nfee=r2(nsub*FEE)
  const ntot=r2(nsub+nsvc+ntax+nfee)
  console.log(`${APPLY?'APPLYING':'DRY RUN'} — new figures: subtotal ${nsub} service ${nsvc} tax ${ntax} fee ${nfee} total ${ntot}\n`)

  const bag:any[] = await sql`SELECT reference, name, price FROM disco_menu_items WHERE restaurant_reference=${RREF}::uuid AND name='PROSCIUTTO AND CHEDDAR BAGUETTE PLATTER' LIMIT 1`
  console.log('baguette menu item:', JSON.stringify(bag[0]))

  if(!APPLY){ console.log('\n(dry run — nothing written)'); return }

  // 1. The swapped line item: croissants -> baguettes, 110 -> 90.
  await sql`
    UPDATE disco_order_items
    SET name = ${bag[0].name}, meal_package_reference = ${bag[0].reference},
        price_per_unit = 90.00, total_price = 90.00
    WHERE id = 497856 AND order_id = ${ORDER}`
  // 2. The STALE row left by the previous correction: its unit price was updated
  //    to 75 but total_price kept 110, so the items summed to 590 against a
  //    stored subtotal of 555. Left as-is the PDF would not reconcile.
  await sql`
    UPDATE disco_order_items SET total_price = 75.00
    WHERE id = 497855 AND order_id = ${ORDER} AND price_per_unit = 75.00`
  // 3. The order header.
  await sql`
    UPDATE disco_orders SET subtotal = ${nsub}, total = ${ntot}, fee = ${nfee}, updated_at = NOW()
    WHERE id = ${ORDER}`
  // 4. The ORIGINAL sale transaction — what reporting and the PDF read.
  await sql`
    UPDATE disco_sale_transactions
    SET subtotal = ${nsub}, service_charge = ${nsvc}, state_tax = ${ntax}, fee = ${nfee},
        total = ${ntot}, updated_at = NOW()
    WHERE order_id = ${ORDER} AND transaction_type = 'ORIGINAL'`
  console.log('written.')
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
