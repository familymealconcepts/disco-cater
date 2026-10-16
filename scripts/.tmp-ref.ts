import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import Stripe from 'stripe'
const unq=(v?:string)=>(v||'').replace(/^["']|["']$/g,'')
async function main(){
  const s=new Stripe(unq(process.env.STRIPE_READONLY_KEY))
  const pi:any = await s.paymentIntents.retrieve('pi_3UFH3zKp5OWEZLTA1qlH8LPq', { expand:['latest_charge'] } as never)
  const ch:any = pi.latest_charge
  console.log(`PaymentIntent  : ${pi.id}  amount=$${(pi.amount/100).toFixed(2)}  status=${pi.status}`)
  console.log(`Charge         : ${ch?.id}  amount=$${(ch.amount/100).toFixed(2)}  refunded=$${(ch.amount_refunded/100).toFixed(2)}`)
  const rf = await s.refunds.list({ charge: ch.id, limit: 20 })
  console.log(`\nrefunds on this charge: ${rf.data.length}`)
  let sum=0
  for(const r of rf.data as any[]){
    sum += r.amount/100
    console.log(`   ${r.id}  $${(r.amount/100).toFixed(2)}  ${r.status}  ${new Date(r.created*1000).toISOString()}  reason=${r.reason ?? '—'}`)
  }
  console.log(`   total refunded: $${sum.toFixed(2)}`)
  console.log(`\n   net the customer has paid: $${((ch.amount - ch.amount_refunded)/100).toFixed(2)}`)
}
main().then(()=>process.exit(0)).catch(e=>{console.error('ERR:',e.message);process.exit(1)})
