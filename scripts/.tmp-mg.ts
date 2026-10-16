import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
const unq=(v?:string)=>(v||'').replace(/^["']|["']$/g,'')
const KEY=unq(process.env.MAILGUN_API_KEY)
const auth='Basic '+Buffer.from(`api:${KEY}`).toString('base64')
async function main(){
  for(const dom of ['mg.discocater.com','mg.familymeal.com']){
    const r=await fetch(`https://api.mailgun.net/v3/${dom}/events?limit=5`,{headers:{Authorization:auth}})
    const j:any=await r.json().catch(()=>({}))
    console.log(`${dom.padEnd(22)} HTTP ${r.status}  items=${(j.items||[]).length}  ${r.ok?'readable':'NOT readable'}`)
    if(r.ok && (j.items||[]).length) console.log(`   newest: ${new Date(j.items[0].timestamp*1000).toISOString()} ${j.items[0].event} ${j.items[0].recipient}`)
  }
  console.log('\n=== transactional sending domain in code ===')
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
