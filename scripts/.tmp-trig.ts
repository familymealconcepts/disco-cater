import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
async function main(){
  const t:any[] = await sql`
    SELECT trigger_name, event_manipulation, event_object_table, action_timing, action_statement
    FROM information_schema.triggers WHERE event_object_table IN ('disco_orders','disco_sale_transactions')`
  console.log('=== triggers ===')
  console.log(t.length ? JSON.stringify(t,null,1) : '   (none)')
  const d:any[] = await sql`
    SELECT column_name, column_default, is_generated, generation_expression
    FROM information_schema.columns WHERE table_name='disco_orders' AND column_name='refund'`
  console.log('\n=== refund column definition ===')
  console.log(JSON.stringify(d[0],null,1))
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
