/**
 * Full inventory of every Disco-native restaurant, sorted by gross.
 * Read-only. Writes docs/disco-native-restaurants.md.
 *
 * Group comes from FamilyMeal's explicit tbl_restaurant_groups (via a tunnel);
 * if FM is unreachable the group column degrades to "—" rather than guessing
 * from names.
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { neon } from '@neondatabase/serverless'
import { Client } from 'pg'
const sql = neon(process.env.DATABASE_URL!)
const unq=(s?:string)=>(s||'').replace(/^["']|["']$/g,'')
const money=(n:number)=>'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})

async function main(){
  const rows = await sql`
    SELECT c.restaurant_reference::text AS ref, c.name, c.is_live,
      COALESCE(o.visible,false) AS visible,
      COALESCE(o.online_ordering_enabled,true) AS ooe,
      (o.stripe_account_id IS NOT NULL OR COALESCE(o.stripe_connected,false)) AS stripe,
      -- NaN-SAFE. Five NATIVE_CHECKOUT rows (orders #900000097-101, The Winkin'
      -- Rooster and Atlanta Bread - Smyrna) hold NaN in total and stripe_fee, and
      -- a single NaN poisons the whole SUM — it made both restaurants, and the
      -- fleet total, render as $NaN. Excluded from the sum and counted separately
      -- so the figure is honest rather than silently wrong.
      COALESCE((SELECT SUM(t.total - COALESCE(t.fee,0)) FROM disco_orders x
        JOIN disco_sale_transactions t ON t.order_id=x.id AND t.transaction_type='ORIGINAL'
        WHERE x.restaurant_reference::text=c.restaurant_reference::text
          AND t.total::text <> 'NaN' AND COALESCE(t.fee::text,'0') <> 'NaN'),0)::float8 AS gross,
      (SELECT COUNT(*)::int FROM disco_orders x
        JOIN disco_sale_transactions t ON t.order_id=x.id AND t.transaction_type='ORIGINAL'
        WHERE x.restaurant_reference::text=c.restaurant_reference::text
          AND (t.total::text='NaN' OR t.fee::text='NaN')) AS nan_orders,
      (SELECT COUNT(*)::int FROM disco_orders x WHERE x.restaurant_reference::text=c.restaurant_reference::text) AS orders,
      (SELECT MAX(x.order_date)::text FROM disco_orders x WHERE x.restaurant_reference::text=c.restaurant_reference::text) AS last_order,
      (SELECT COUNT(*)::int FROM disco_menu_items i
        WHERE i.restaurant_reference::text=c.restaurant_reference::text) AS items,
      (SELECT COUNT(*)::int FROM disco_menus m WHERE m.restaurant_reference::text=c.restaurant_reference::text) AS menus
    FROM disco_restaurant_cache c
    LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference=c.restaurant_reference
    WHERE c.is_disco_native = true AND c.archived_at IS NULL
    ORDER BY gross DESC` as any[]

  // converted-at, from the two progress trails
  const at = new Map<string,string>()
  if (existsSync('data/converted-today.csv')) for (const l of readFileSync('data/converted-today.csv','utf8').split('\n').slice(1)) {
    const p = l.split(','); if (p[1] && p[p.length-1]) at.set(p[1], p[p.length-1].slice(0,10))
  }
  for (const f of ['data/mass-convert-progress.jsonl','data/chain-finish-progress.jsonl','data/eggbred-namkeen-conversion.jsonl']) {
    if (!existsSync(f)) continue
    for (const l of readFileSync(f,'utf8').split('\n')) { if(!l.trim()) continue
      try { const j = JSON.parse(l); if (j.ref && j.converted && j.at) at.set(j.ref, String(j.at).slice(0,10)) } catch {}
    }
  }

  let groupOf = new Map<string,string>()
  try{
    const c=new Client({host:'127.0.0.1',port:55432,database:unq(process.env.FM_DB_NAME_OVERRIDE),user:unq(process.env.FM_DB_USER_OVERRIDE),password:unq(process.env.FM_DB_PASSWORD_OVERRIDE),ssl:{rejectUnauthorized:false}})
    await c.connect()
    const g=(await c.query(`SELECT r.reference::text AS ref, g.name FROM familymeal.tbl_restaurants r
      JOIN familymeal.tbl_restaurant_groups g ON g.id=r.group_id WHERE r.reference::text = ANY($1)`,[rows.map(r=>r.ref)])).rows
    groupOf = new Map(g.map((x:any)=>[x.ref,x.name]))
    await c.end()
  }catch(e:any){ console.error('FM group lookup unavailable:', e.message) }

  const yn=(b:any)=>b?'Yes':'No'
  const head = '| # | Restaurant | Group | Gross | Orders | Last order | Stripe | Ordering | Map | Menus / items | Converted |\n|---:|---|---|---:|---:|---|---|---|---|---:|---|'
  const body = rows.map((r,i)=>`| ${i+1} | ${r.name} | ${groupOf.get(r.ref)||'—'} | ${money(r.gross)} | ${r.orders} | ${r.last_order||'—'} | ${yn(r.stripe)} | ${yn(r.ooe)} | ${yn(r.visible)} | ${r.menus} / ${r.items} | ${at.get(r.ref)||'—'} |${r.nan_orders>0?` <!-- ${r.nan_orders} order(s) excluded: NaN -->`:''}`).join('\n')
  const t = { gross: rows.reduce((a,r)=>a+r.gross,0), orders: rows.reduce((a,r)=>a+r.orders,0),
    items: rows.reduce((a,r)=>a+r.items,0), menus: rows.reduce((a,r)=>a+r.menus,0),
    stripe: rows.filter(r=>r.stripe).length, ooe: rows.filter(r=>r.ooe).length, vis: rows.filter(r=>r.visible).length }
  const md = `# Disco Cater — native restaurants

Generated ${new Date().toISOString().slice(0,19)}Z. Every restaurant with
\`disco_restaurant_cache.is_disco_native = true\` and not archived, sorted by gross.

Gross is restaurant-facing: order total less the FamilyMeal fee. Group is
FamilyMeal's explicit \`tbl_restaurant_groups\`, not a name match. "Converted" is
blank where no conversion trail records a date (the earliest conversions predate
the progress files).

**${rows.length} restaurants** · gross **${money(t.gross)}** · **${t.orders}** orders ·
**${t.menus}** menus / **${t.items}** items · Stripe **${t.stripe}** · ordering on **${t.ooe}** · on the map **${t.vis}**

${head}
${body}

| | **TOTAL** | | **${money(t.gross)}** | **${t.orders}** | | **${t.stripe}** | **${t.ooe}** | **${t.vis}** | **${t.menus} / ${t.items}** | |
`
  writeFileSync('docs/disco-native-restaurants.md', md)
  const nanTot = rows.reduce((a,r)=>a+(r.nan_orders||0),0)
  if (nanTot) console.log(`NOTE: ${nanTot} order(s) excluded from gross — NaN in total/fee (pre-existing data defect)`)
  console.log(`wrote docs/disco-native-restaurants.md — ${rows.length} restaurants`)
  console.log(`TOTALS gross ${money(t.gross)} | orders ${t.orders} | menus ${t.menus} | items ${t.items} | stripe ${t.stripe} | ordering ${t.ooe} | map ${t.vis}`)
  console.log('\nTOP 25:')
  rows.slice(0,25).forEach((r,i)=>console.log(`${String(i+1).padStart(3)}. ${String(r.name).slice(0,34).padEnd(34)} ${money(r.gross).padStart(12)} ord=${String(r.orders).padStart(4)} ${String(groupOf.get(r.ref)||'—').slice(0,22).padEnd(22)} menus=${r.menus} items=${String(r.items).padStart(3)} conv=${at.get(r.ref)||'—'}`))
}
main().catch(e=>{console.error(e);process.exit(1)})
