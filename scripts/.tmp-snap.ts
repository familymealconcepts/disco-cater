import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { writeFileSync } from 'fs'
const unq=(v?:string)=>(v||'').replace(/^["']|["']$/g,'')
const auth='Basic '+Buffer.from(`api:${unq(process.env.MAILGUN_API_KEY)}`).toString('base64')
const WATCH=['asantim8@gmail.com','lucy@twohandsnyc.com']
async function main(){
  const snap:any={ takenAt:new Date().toISOString(), domains:{} }
  for(const dom of ['mg.discocater.com','mg.familymeal.com']){
    const r=await fetch(`https://api.mailgun.net/v3/${dom}/events?limit=50`,{headers:{Authorization:auth}})
    const j:any=await r.json()
    const items=j.items||[]
    snap.domains[dom]={ newest: items[0]? new Date(items[0].timestamp*1000).toISOString():null, count: items.length,
      ids: items.map((e:any)=>e.id) }
    const hits=items.filter((e:any)=>WATCH.includes(String(e.recipient||'').toLowerCase()))
    console.log(`${dom.padEnd(22)} newest=${snap.domains[dom].newest}  events-for-watched-addresses=${hits.length}`)
    for(const h of hits) console.log(`   ${h.event} ${h.recipient} ${new Date(h.timestamp*1000).toISOString()}`)
  }
  writeFileSync('/tmp/mg-before.json', JSON.stringify(snap,null,2))
  console.log('\nsnapshot written. Watched addresses:', WATCH.join(', '))
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})
