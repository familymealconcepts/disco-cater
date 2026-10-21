require('dotenv').config({ path: '.env.local', quiet: true })
import { sql } from './lib/db'
;(async()=>{
  const cols=await sql`SELECT column_name FROM information_schema.columns WHERE table_name='marketing_send_log' ORDER BY ordinal_position` as any[]
  console.log('  send_log columns: '+cols.map((x:any)=>x.column_name).join(', '))
  const c=await sql`SELECT campaign, outcome, COUNT(*)::int n, MAX(sent_at) last FROM marketing_send_log GROUP BY 1,2 ORDER BY 1,3 DESC` as any[]
  console.log('\n  CAMPAIGN                      OUTCOME        COUNT    LAST')
  for(const x of c) console.log('  '+String(x.campaign).slice(0,28).padEnd(30)+String(x.outcome).padEnd(15)+String(x.n).padEnd(9)+String(x.last).slice(4,24))
  const ctl=await sql`SELECT * FROM marketing_campaign_control` as any[]
  console.log('\n  control:'); for(const x of ctl) console.log('   '+JSON.stringify(x).slice(0,240))
  process.exit(0)
})().catch(e=>{console.error('ERR '+e.message);process.exit(1)})
