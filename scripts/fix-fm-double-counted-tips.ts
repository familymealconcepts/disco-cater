/**
 * Repairs FM-sourced disco_sale_transactions rows where the SAME third-party
 * (courier) tip was written into both tips_in_price and third_party_delivery_tips.
 *
 * Cause: syncSaleTransactionFromDetails passed tipsInPrice: null, so
 * resolveTipsInPrice recomputed it from the order-level `tips` percent — which on
 * a third-party-delivery order IS the courier tip that FM already reports
 * separately as thirdPartyDeliveryTipsInPrice. Both columns then held it, and any
 * report summing the two counted the tip twice. The mirror now reads FM's own
 * tipsInPrice; this repairs the rows written before that.
 *
 * Values come from familymeal.tbl_restaurant_sale_transactions — FM is the system
 * of record. A row is rewritten ONLY where FM disagrees; nothing is derived.
 *
 * Same access requirements as scripts/backfill-fm-sale-transaction-fees.ts
 * (SSH tunnel to FM's VPC address + FM_DB_*_OVERRIDE credentials).
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { neon } from '@neondatabase/serverless'
import { Client } from 'pg'

const sql = neon(process.env.DATABASE_URL!)
const DRY = process.argv.includes('--dry-run')
const unq = (v?: string) => (v || '').replace(/^["']|["']$/g, '')
const r2 = (x: number) => Math.round(x * 100) / 100

function fmClient(): Client {
  const port = Number(process.env.FM_DB_TUNNEL_PORT || 0)
  return new Client({
    host: port ? '127.0.0.1' : unq(process.env.FM_DB_HOST),
    port: port || Number(unq(process.env.FM_DB_PORT)) || 5432,
    database: unq(process.env.FM_DB_NAME_OVERRIDE || process.env.FM_DB_NAME),
    user: unq(process.env.FM_DB_USER_OVERRIDE || process.env.FM_DB_USER),
    password: unq(process.env.FM_DB_PASSWORD_OVERRIDE || process.env.FM_DB_PASSWORD),
    ssl: { rejectUnauthorized: false },
  })
}

async function main() {
  console.log(DRY ? '=== DRY RUN — no writes ===\n' : '=== LIVE ===\n')
  const targets = (await sql`
    SELECT t.id AS txn_id, o.fm_order_reference::text AS fmref, o.order_number, o.restaurant_name,
           t.tips_in_price::float8 AS tips, t.third_party_delivery_tips::float8 AS tp3
    FROM disco_sale_transactions t JOIN disco_orders o ON o.id = t.order_id
    WHERE t.source IN ('FM_SYNC','FM_LIST') AND o.fm_order_reference IS NOT NULL
  `) as unknown as { txn_id: number; fmref: string; order_number: string; restaurant_name: string; tips: number | null; tp3: number | null }[]

  const fm = fmClient(); await fm.connect()
  const { rows } = await fm.query<{ fmref: string; tips_in_price: string | null; tp3: string | null; dd: string | null }>(`
    SELECT ro.reference::text AS fmref, st.tips_in_price,
           st.third_party_delivery_tips_in_price AS tp3, st.doordash_tips_in_price AS dd
    FROM familymeal.tbl_restaurant_orders ro
    JOIN familymeal.tbl_restaurant_sale_transactions st ON st.restaurant_order_id = ro.id
    WHERE ro.reference::text = ANY($1) AND st.transaction_type = 'ORIGINAL'`,
    [targets.map(t => t.fmref)])
  await fm.end()

  const byRef = new Map<string, typeof rows>()
  for (const r of rows) { const a = byRef.get(r.fmref) || []; a.push(r); byRef.set(r.fmref, a) }

  const fixes: { id: number; tips: number; tp3: number }[] = []
  let noFm = 0, ambiguous = 0, agree = 0
  let beforeSum = 0, afterSum = 0
  for (const t of targets) {
    const c = byRef.get(t.fmref)
    if (!c) { noFm++; continue }
    const key = (r: typeof rows[number]) => `${r.tips_in_price}|${r.tp3}|${r.dd}`
    if (new Set(c.map(key)).size > 1) { ambiguous++; continue }
    const f = c[0]
    const fTips = r2(Number(f.tips_in_price || 0))
    const fTp3 = r2(Number(f.tp3 || 0) + Number(f.dd || 0))   // FM folds doordash tips into third-party
    const dTips = r2(t.tips ?? 0), dTp3 = r2(t.tp3 ?? 0)
    if (Math.abs(fTips - dTips) < 0.005 && Math.abs(fTp3 - dTp3) < 0.005) { agree++; continue }
    beforeSum += dTips + dTp3; afterSum += fTips + fTp3
    fixes.push({ id: t.txn_id, tips: fTips, tp3: fTp3 })
  }

  console.log(`  rows examined:        ${targets.length}`)
  console.log(`  already agree with FM:${agree}`)
  console.log(`  no FM ORIGINAL row:   ${noFm}`)
  console.log(`  ambiguous, skipped:   ${ambiguous}`)
  console.log(`  TO CORRECT:           ${fixes.length}`)
  console.log(`  tips total on those rows: ${r2(beforeSum)} -> ${r2(afterSum)}  (${r2(afterSum - beforeSum)})`)

  if (DRY || !fixes.length) { console.log('\nNothing written.'); return }
  let w = 0
  for (let i = 0; i < fixes.length; i += 100) {
    const chunk = fixes.slice(i, i + 100)
    await sql.transaction(chunk.map(f => sql`
      UPDATE disco_sale_transactions
         SET tips_in_price = ${f.tips}, third_party_delivery_tips = ${f.tp3}, updated_at = NOW()
       WHERE id = ${f.id}`))
    w += chunk.length; process.stdout.write(`\r  written ${w}/${fixes.length}`)
  }
  console.log(`\n\nDone. ${w} rows corrected.`)
}
main().catch(e => { console.error(e); process.exit(1) })
