import Stripe from 'stripe'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { sql } from '../lib/db'
import { convertToNative, importRestaurantStripeAccount } from '../lib/native-conversion'
import { importFmMenuFaithfully } from '../lib/menu-import/fm-faithful-import'
const PROGRESS = 'data/chain-finish-progress.json'
const chains = JSON.parse(readFileSync('data/partial-chains.json','utf8')) as any[]
const res = JSON.parse(readFileSync('data/stripe-account-resolutions.json','utf8'))
const acct = new Map<string,string>()
for (const r of res.resolutions as any[]) if (r.bucket==='resolved') acct.set(r.restaurantReference, r.stripeAccountId)
;(async()=>{
  const stripe = new Stripe(process.env.STRIPE_READONLY_KEY!)
  const queue = chains.flatMap((c:any)=>c.remaining.filter((r:any)=>r.hasAcct).map((r:any)=>({...r, chain:c.token})))
  const done: Record<string, any> = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS,'utf8')) : {}
  const todo = queue.filter((q:any)=>!done[q.ref])
  console.log('chain-finish queue:', queue.length, '| remaining this run:', todo.length)
  let n=0
  for (const q of todo) {
    n++
    const t0=Date.now()
    const rec: any = { name: q.name, chain: q.chain, ref: q.ref }
    try {
      const a = acct.get(q.ref)
      if (a) await importRestaurantStripeAccount(q.ref, a, { stripe })
      const m:any = await importFmMenuFaithfully(q.ref)
      rec.items = m.items
      const r:any = await convertToNative(q.ref, { stripe, skipInvites: true, actorEmail: 'peter@familymeal.com' })
      rec.converted = r.converted
      rec.isLive = r.readiness?.isLive ?? null
      rec.link = r.multiUnitLink?.status ?? null
      rec.linkSlug = r.multiUnitLink?.slug ?? null
      rec.linkMembers = r.multiUnitLink?.members ?? null
      if (!r.converted) rec.reason = String(r.reason).slice(0,150)
    } catch(e:any) { rec.converted=false; rec.reason='THREW: '+String(e?.message).slice(0,150) }
    rec.seconds = Number(((Date.now()-t0)/1000).toFixed(1))
    done[q.ref]=rec; writeFileSync(PROGRESS, JSON.stringify(done,null,1)+'\n')
    console.log(String(n).padStart(3)+'.', String(q.chain).padEnd(20), String(q.name).slice(0,34).padEnd(36), String(rec.seconds).padStart(6)+'s',
      rec.converted ? 'OK live='+rec.isLive+' link='+rec.link+'('+rec.linkMembers+')' : 'FAIL '+rec.reason)
  }
  const all = Object.values(done) as any[]
  console.log('\nrecorded', all.length, '| converted', all.filter(x=>x.converted).length, '| failed', all.filter(x=>!x.converted).length)
  process.exit(0)
})()
