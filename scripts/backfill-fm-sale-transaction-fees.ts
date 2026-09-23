/**
 * Fills service_charge, stripe_fee and stripe_payment_intent_id on FM-sourced
 * disco_sale_transactions rows from FamilyMeal's OWN table.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * FM's order-detail endpoint (GET api/orders/{reference}) — the one the mirror
 * calls — returns serviceCharge but has no stripeFee field at all. The only FM
 * HTTP route that exposes stripeFee per order is GET api/orders/list, and that
 * route 500s for our service identity:
 *
 *   NonUniqueResultException: query did not return a unique result: 2702
 *
 * because getOrdersList() calls findRestaurantByAdmin(currentUser) and our
 * service account is an ADMIN matching all 2,702 restaurants. We will not write
 * to FM to fix that. So the per-order Stripe fee is read here straight from
 * familymeal.tbl_restaurant_sale_transactions, which is the system of record.
 *
 * NEVER WRITES A VALUE IT DOES NOT HAVE. Where FM holds NULL, or where the order
 * has no ORIGINAL sale transaction at all (every EXPIRED order — never paid, so
 * FM never created one), the column is left NULL. NULL means "not known", and
 * that stays true.
 *
 * ACCESS: FM's database is on a private VPC address (10.x), unreachable from
 * Vercel and from a laptop directly. Open a tunnel through the API droplet first:
 *
 *   ssh -f -N -L 55432:10.108.0.6:5432 root@68.183.151.221
 *   FM_DB_TUNNEL_PORT=55432 npx tsx scripts/backfill-fm-sale-transaction-fees.ts --dry-run
 *
 * FM_DB_PASSWORD in .env.local is empty (Vercel returns Sensitive vars blank on
 * pull), so pass the live credential explicitly:
 *
 *   FM_DB_PASSWORD_OVERRIDE=... FM_DB_USER_OVERRIDE=... FM_DB_NAME_OVERRIDE=...
 *
 * Read-only against FM. Writes only to Neon.
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { neon } from '@neondatabase/serverless'
import { Client } from 'pg'

const sql = neon(process.env.DATABASE_URL!)
const DRY = process.argv.includes('--dry-run')
const unq = (v?: string) => (v || '').replace(/^["']|["']$/g, '')

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

interface Target { txn_id: number; fmref: string; order_number: string | null; order_status: string | null; total: string | null }
interface FmRow { fmref: string; service_charge: string | null; stripe_fee: string | null; stripe_payment_intent_id: string | null; total: string | null; transaction_status: string | null }

async function main() {
  console.log(DRY ? '=== DRY RUN — no writes ===\n' : '=== LIVE — writing to Neon ===\n')

  const targets = (await sql`
    SELECT t.id AS txn_id, o.fm_order_reference::text AS fmref, o.order_number,
           o.order_status, t.total::text AS total
    FROM disco_sale_transactions t
    JOIN disco_orders o ON o.id = t.order_id
    WHERE t.source IN ('FM_SYNC','FM_LIST')
      AND (t.service_charge IS NULL OR t.stripe_fee IS NULL OR t.stripe_payment_intent_id IS NULL)
      AND o.fm_order_reference IS NOT NULL
  `) as unknown as Target[]
  console.log(`Neon rows with at least one of the three fields missing: ${targets.length}`)
  if (!targets.length) return

  const fm = fmClient()
  await fm.connect()
  // ORIGINAL only: EDIT/REFUND rows describe later adjustments, not the original sale.
  const { rows: fmRows } = await fm.query<FmRow>(`
    SELECT ro.reference::text AS fmref, st.service_charge, st.stripe_fee,
           st.stripe_payment_intent_id, st.total, st.transaction_status
    FROM familymeal.tbl_restaurant_orders ro
    JOIN familymeal.tbl_restaurant_sale_transactions st ON st.restaurant_order_id = ro.id
    WHERE ro.reference::text = ANY($1) AND st.transaction_type = 'ORIGINAL'`,
    [targets.map(t => t.fmref)])
  await fm.end()

  const byRef = new Map<string, FmRow[]>()
  for (const r of fmRows) { const a = byRef.get(r.fmref) || []; a.push(r); byRef.set(r.fmref, a) }

  let filled = 0, noFmTxn = 0, fmNull = 0, skippedAmbiguous = 0, netOfRefund = 0, dupOriginals = 0
  const statusOfNoTxn: Record<string, number> = {}
  const updates: { id: number; sc: string | null; sf: string | null; pi: string | null }[] = []

  for (const t of targets) {
    const cand = byRef.get(t.fmref)
    if (!cand) { noFmTxn++; statusOfNoTxn[t.order_status || 'null'] = (statusOfNoTxn[t.order_status || 'null'] || 0) + 1; continue }

    // FM holds genuine DUPLICATE ORIGINAL rows for a handful of orders (same
    // amount, sometimes one PAID and one VOIDED/INITIATED). Prefer the PAID one;
    // if several survive, they must agree on all three values or we do not guess.
    let pick = cand
    if (pick.length > 1) {
      dupOriginals++
      const paid = pick.filter(r => String((r as unknown as { transaction_status?: string }).transaction_status || '').toUpperCase() === 'PAID')
      if (paid.length) pick = paid
      const key = (r: FmRow) => `${r.service_charge}|${r.stripe_fee}|${r.stripe_payment_intent_id}`
      if (new Set(pick.map(key)).size > 1) { skippedAmbiguous++; continue }
    }
    const r = pick[0]

    // A total difference here is EXPECTED and is not a reason to skip. The join is
    // on the order's own UUID, so there is no question which order this is; the
    // difference is that Disco's mirrored total is net of a later REFUND (or
    // includes a later ADDITIONAL charge) while FM's ORIGINAL row holds the
    // pre-adjustment amount. The ORIGINAL row's own service charge and Stripe fee
    // are still exactly what belongs on Disco's ORIGINAL row. Counted, not skipped.
    if (t.total != null && r.total != null && Math.abs(Number(t.total) - Number(r.total)) > 0.005) netOfRefund++

    if (r.service_charge == null && r.stripe_fee == null && r.stripe_payment_intent_id == null) { fmNull++; continue }
    updates.push({ id: t.txn_id, sc: r.service_charge, sf: r.stripe_fee, pi: r.stripe_payment_intent_id })
    filled++
  }

  console.log(`\n  will fill:                    ${filled}`)
  console.log(`  no ORIGINAL txn in FM:        ${noFmTxn}   ${JSON.stringify(statusOfNoTxn)}`)
  console.log(`  FM holds NULL for all three:  ${fmNull}`)
  console.log(`  differs from FM ORIGINAL:     ${netOfRefund}  (net of refund / plus additional — filled)`)
  console.log(`  FM had duplicate ORIGINALs:   ${dupOriginals}  (resolved ${dupOriginals - skippedAmbiguous}, skipped ${skippedAmbiguous})`)

  if (DRY) { console.log('\nDry run — nothing written.'); return }

  let written = 0
  const BATCH = 100
  for (let i = 0; i < updates.length; i += BATCH) {
    const chunk = updates.slice(i, i + BATCH)
    // COALESCE so an existing non-null value is never overwritten, and a NULL
    // from FM never blanks something we already had.
    await sql.transaction(chunk.map(u => sql`
      UPDATE disco_sale_transactions
         SET service_charge           = COALESCE(service_charge, ${u.sc}::numeric),
             stripe_fee               = COALESCE(stripe_fee, ${u.sf}::numeric),
             stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ${u.pi}),
             updated_at               = NOW()
       WHERE id = ${u.id}`))
    written += chunk.length
    process.stdout.write(`\r  written ${written}/${updates.length}`)
  }
  console.log(`\n\nDone. ${written} rows updated.`)
}

main().catch(e => { console.error(e); process.exit(1) })
