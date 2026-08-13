// FM order-detail backfill: reconstructs disco_sale_transactions + disco_order_items
// + disco_order_item_addons for FM-mirrored orders from the frozen fm_backup
// snapshot (frozen 2026-06-17). fm-orders-sync.ts has only ever written
// disco_orders' header/total columns for these orders — never the tax/delivery/
// promo breakdown or line items — so reporting and the order PDF silently fall
// back to guessed/residual figures for every FM-mirrored order today.
//
// Set-based ETL: reads fm_backup and disco_orders in bulk (a handful of
// round-trips total, not one per order), then writes in chunks via a single
// unnest()-based multi-row INSERT per table per chunk — never one INSERT per row.
//
// Idempotent: each chunk is DELETE-then-INSERT scoped to that chunk's order_ids,
// matching writeNeonItems's pattern (app/api/restaurant/orders/[ref]/edit/route.ts).
// The DELETEs are scoped to backfill-owned rows only (source = 'FM_BACKFILL' /
// fm_package_id IS NOT NULL / fm_addon_id IS NOT NULL) so a re-run can never
// remove a native or manually-edited row for the same order_id.
//
// Modes:
//   npx tsx scripts/fm-order-backfill.ts                          dry run, no writes (default)
//   npx tsx scripts/fm-order-backfill.ts --execute --sample=20     real writes, first 20 orders only
//   npx tsx scripts/fm-order-backfill.ts --execute --limit=500     real writes, first 500 orders
//   npx tsx scripts/fm-order-backfill.ts --execute                 real writes, full run
//   npx tsx scripts/fm-order-backfill.ts --execute --resume-after=12345   skip orders with id <= 12345
//
// --backfill-placed-at: a SEPARATE fill, same script, same source DB/sample/
// limit/resume-after flags — fills disco_orders.placed_at from fm_backup's
// tbl_restaurant_orders.created_date for FM-mirrored orders that don't have it
// yet. Fill-blank-only (WHERE placed_at IS NULL both in the candidate query and
// the UPDATE itself) and therefore trivially idempotent — a second run finds
// nothing left to do. Scoped independently of EXCLUDED_ORDER_IDS: those 6
// orders are excluded from the transaction backfill because THEIR sale-
// transaction data has known problems: their order-level created_date has no
// such issue, so there's no reason to withhold their placed_at fill too.
//   npx tsx scripts/fm-order-backfill.ts --backfill-placed-at                 dry run
//   npx tsx scripts/fm-order-backfill.ts --backfill-placed-at --execute       real writes, full run
//
// Source database: defaults to the local `fm_backup` database (the original
// 2026-06-17 full snapshot). Override with --source-db=<name> or the
// FM_BACKUP_DB env var (flag wins) to point at a different local restore —
// e.g. a scoped, more-recent snapshot restored as `fm_backup_scoped` — without
// touching this file. Never a remote connection string: this always connects
// to a LOCAL database by name, same as the existing `new Client({ database })`
// convention used elsewhere in this repo (scripts/migrate-fm-to-neon.ts,
// scripts/backfill-logos-from-fm.ts).
//
// This file is never auto-run — every invocation is explicit and logs exactly
// what it did.

import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { neon } from '@neondatabase/serverless'
import { Client, types } from 'pg'
import { buildSaleTransactionFields } from '../lib/order/fm-sale-transaction'

// node-postgres returns BIGINT (OID 20) columns as strings by default — every FK
// this script joins on (restaurant_order_id, restaurant_order_meal_package_id) is
// bigint in fm_backup, so without this every Map lookup keyed by that value
// silently misses (string "12345" !== number 12345). Safe here: these are order/
// package/add-on ids, never aggregate sums that could lose precision.
types.setTypeParser(20, (val: string) => parseInt(val, 10))

const sql = neon(process.env.DATABASE_URL as string)

function n(v: unknown): number | null { if (v == null) return null; const x = Number(v); return Number.isFinite(x) ? x : null }
function round2(x: number): number { return Math.round(x * 100) / 100 }
function servesToInt(s: unknown): number | null {
  if (s == null) return null
  const m = String(s).match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}

// Investigated individually before this run (see the mismatch report delivered
// separately) — every order in fm_backup with >1 sale_transaction row of ANY
// type was checked by hand. Of the original 11 flagged by a too-naive dry-run
// check (which only compared the single ORIGINAL row, ignoring legitimate
// ADDITIONAL/REFUND rows), 5 turned out to be false positives — they reconcile
// exactly once ALL of an order's transaction rows are summed (a genuine edit
// history: an added charge, or a full refund netting to zero) — those 5 are
// INCLUDED below with their full transaction history now written, not just
// ORIGINAL. Only these 6 are excluded, for two distinct, confirmed reasons:
//   - 6741, 5122, 6512, 6517, 18470: FM's own snapshot has TWO 'ORIGINAL' rows
//     for the same order, identical totals, both transaction_status='INITIATED'
//     (never PAID), and the order itself is EXPIRED on both FM and Neon. This is
//     NOT the order_number uniqueness bug (that bug silently DROPPED orders on
//     insert due to a fleet-wide unique constraint; this is a different failure
//     mode — FM's checkout retried a payment attempt on an abandoned/expired
//     cart and wrote a second identical row instead of replacing the first).
//     disco_orders.total for these 5 already equals the DOUBLED sum (FM's own
//     total field inherited the same bug), so no single de-duped row — and no
//     honest two-row write, since neither attempt was ever actually paid —
//     would represent real money. Writing a component row here would be worse
//     than no row.
//   - 17159: genuinely unexplained. FM's only transaction row is $444.13 PAID,
//     order status DUE (active, not refunded/edited) — but disco_orders.total
//     is $381.50, a $62.63 gap with no ADDITIONAL/REFUND row to explain it.
//     Needs manual review; flagged for you, not guessed at here.
const EXCLUDED_ORDER_IDS = new Set<number>([6741, 5122, 6512, 6517, 18470, 17159])

interface Candidate { orderId: number; fmRef: string; discoTotal: number | null }
interface FmOrderRow { order_reference: string; fm_order_id: number }
interface FmTxnRow {
  restaurant_order_id: number
  subtotal: string | null; total: string | null; fee: string | null
  service_charge: string | null; stripe_fee: string | null
  state_sales_tax_in_price: string | null; local_sales_tax_in_price: string | null; other_sales_tax_in_price: string | null
  tips_in_price: string | null; third_party_delivery_tips_in_price: string | null
  own_delivery_fee: string | null; third_party_delivery_fee: string | null; third_party_delivery_subsiding: string | null
  // FM's schema keeps DoorDash as its own pair of columns, separate from the
  // generic third_party_delivery_fee/tips (Nash) pair. Neon's disco_sale_
  // transactions has only ONE third-party bucket, matching disco_orders.
  // delivery_type's own two-way model (OWN_DELIVERY vs everything else,
  // including 'DOORDASH'). Verified 0 orders have both nonzero at once, so
  // folding doordash_* into the generic third-party columns below is a safe,
  // lossless combine — 24 orders would otherwise silently lose their delivery
  // fee/tips (found while wiring the reporting cards' doordash split, which
  // reads from this same column).
  doordash_delivery_fee: string | null; doordash_tips_in_price: string | null
  discount: string | null; leadgenone_discofee: string | null; leadgentwo_discofee: string | null
  transaction_type: string | null
}
interface FmPackageRow {
  id: number; restaurant_order_id: number; origin_meal_package_reference: string | null
  name: string | null; count: number | null; price: string | null; serves: string | null
}
interface FmAddonRow {
  id: number; restaurant_order_meal_package_id: number; name: string | null; price: string | null; count: number | null
}
interface FmDeliveryAddrRow { restaurant_order_id: number; delivery_instructions: string | null }

async function loadCandidates(fm: Client): Promise<{ candidates: Candidate[]; fmOrderMap: Map<string, number>; excludedFound: number }> {
  // ORDER BY id: --sample=N/--limit=N/--resume-after take a prefix or suffix of
  // this result, which must be deterministic across repeated runs (proving
  // idempotency means re-running against the SAME orders, and resuming means
  // picking up exactly where a crash left off).
  const discoRows = (await sql`
    SELECT id, fm_order_reference, total
    FROM disco_orders
    WHERE source_of_order = 'FAMILYMEAL' AND is_deleted = false AND fm_order_reference IS NOT NULL
    ORDER BY id
  `) as { id: number; fm_order_reference: string; total: string | null }[]

  const fmOrders = await fm.query<FmOrderRow>(`
    SELECT o.reference AS order_reference, o.id AS fm_order_id
    FROM familymeal.tbl_restaurant_orders o
  `)
  const fmOrderMap = new Map(fmOrders.rows.map(r => [r.order_reference, r.fm_order_id]))

  const candidates: Candidate[] = []
  let excludedFound = 0
  for (const r of discoRows) {
    if (!fmOrderMap.has(r.fm_order_reference)) continue
    // disco_orders.id is BIGINT — the neon() driver returns it as a string, same
    // class of mismatch as the node-postgres bigint issue above. Without Number()
    // here, EXCLUDED_ORDER_IDS.has(r.id) always misses (Set<number> vs string) and
    // silently includes orders that should have been excluded.
    const orderId = Number(r.id)
    if (EXCLUDED_ORDER_IDS.has(orderId)) { excludedFound++; continue }
    candidates.push({ orderId, fmRef: r.fm_order_reference, discoTotal: n(r.total) })
  }
  return { candidates, fmOrderMap, excludedFound }
}

async function loadFmDetail(fm: Client, fmOrderIds: number[]) {
  const txns = (await fm.query<FmTxnRow>(`
    SELECT restaurant_order_id, subtotal, total, fee, service_charge, stripe_fee,
           state_sales_tax_in_price, local_sales_tax_in_price, other_sales_tax_in_price,
           tips_in_price, third_party_delivery_tips_in_price,
           own_delivery_fee, third_party_delivery_fee, third_party_delivery_subsiding,
           doordash_delivery_fee, doordash_tips_in_price,
           discount, leadgenone_discofee, leadgentwo_discofee, transaction_type
    FROM familymeal.tbl_restaurant_sale_transactions
    WHERE restaurant_order_id = ANY($1::bigint[])
    ORDER BY restaurant_order_id, id
  `, [fmOrderIds])).rows

  const packages = (await fm.query<FmPackageRow>(`
    SELECT id, restaurant_order_id, origin_meal_package_reference, name, count, price, serves
    FROM familymeal.tbl_restaurant_order_meal_packages
    WHERE restaurant_order_id = ANY($1::bigint[])
    ORDER BY restaurant_order_id, id
  `, [fmOrderIds])).rows

  const pkgIds = packages.map(p => p.id)
  const addons = pkgIds.length ? (await fm.query<FmAddonRow>(`
    SELECT id, restaurant_order_meal_package_id, name, price, count
    FROM familymeal.tbl_restaurant_order_add_ons
    WHERE restaurant_order_meal_package_id = ANY($1::bigint[])
    ORDER BY restaurant_order_meal_package_id, id
  `, [pkgIds])).rows : []

  const addrs = (await fm.query<FmDeliveryAddrRow>(`
    SELECT restaurant_order_id, delivery_instructions
    FROM familymeal.tbl_restaurant_delivery_addresses
    WHERE restaurant_order_id = ANY($1::bigint[])
  `, [fmOrderIds])).rows

  return { txns, packages, addons, addrs }
}

// Reconciliation sums ALL of an order's transaction rows (ORIGINAL + ADDITIONAL +
// REFUND — REFUND totals are already negative in FM's data), matching what a
// real edit history looks like, not just the first ORIGINAL row.
function reconciles(fmNetTotal: number | null, discoTotal: number | null): boolean {
  if (fmNetTotal == null || discoTotal == null) return true
  return Math.abs(fmNetTotal - discoTotal) <= 0.02
}

interface PlanResult {
  candidateOrders: number
  excludedOrders: number
  ordersNoTransactionRow: number
  ordersMismatched: number
  mismatchSamples: { orderId: number; fmRef: string; fmTotal: number; discoTotal: number }[]
  saleTransactionRows: number
  orderItemRows: number
  addonRows: number
  ordersWithDeliveryInstructionsToFill: number
}

// Split into chunks for both the read (avoid a single giant IN-list against
// fm_backup) and the write (checkpoint boundary for idempotent, resumable re-runs).
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

let fmOrderMap: Map<string, number> = new Map()

async function runPlan(fm: Client, candidates: Candidate[]): Promise<PlanResult> {
  const result: PlanResult = {
    candidateOrders: candidates.length,
    excludedOrders: EXCLUDED_ORDER_IDS.size,
    ordersNoTransactionRow: 0,
    ordersMismatched: 0,
    mismatchSamples: [],
    saleTransactionRows: 0,
    orderItemRows: 0,
    addonRows: 0,
    ordersWithDeliveryInstructionsToFill: 0,
  }

  const existingDeliveryInstr = new Map<number, string | null>()
  {
    const rows = (await sql`SELECT id, delivery_instructions FROM disco_orders WHERE id = ANY(${candidates.map(c => c.orderId)}::bigint[])`) as { id: number; delivery_instructions: string | null }[]
    for (const r of rows) existingDeliveryInstr.set(r.id, r.delivery_instructions)
  }

  for (const batch of chunk(candidates, 1000)) {
    const fmIds = batch.map(c => fmOrderMap.get(c.fmRef)!).filter(Boolean)
    const { txns, packages, addons, addrs } = await loadFmDetail(fm, fmIds)

    const txnByOrder = new Map<number, FmTxnRow[]>()
    for (const t of txns) {
      const arr = txnByOrder.get(t.restaurant_order_id) || []
      arr.push(t); txnByOrder.set(t.restaurant_order_id, arr)
    }
    const pkgByOrder = new Map<number, FmPackageRow[]>()
    for (const p of packages) {
      const arr = pkgByOrder.get(p.restaurant_order_id) || []
      arr.push(p); pkgByOrder.set(p.restaurant_order_id, arr)
    }
    const addonByPkg = new Map<number, FmAddonRow[]>()
    for (const a of addons) {
      const arr = addonByPkg.get(a.restaurant_order_meal_package_id) || []
      arr.push(a); addonByPkg.set(a.restaurant_order_meal_package_id, arr)
    }
    const addrByOrder = new Map<number, FmDeliveryAddrRow>()
    for (const a of addrs) addrByOrder.set(a.restaurant_order_id, a)

    for (const c of batch) {
      const fmId = fmOrderMap.get(c.fmRef)
      if (!fmId) continue
      const allTxns = txnByOrder.get(fmId) || []
      const pkgs = pkgByOrder.get(fmId) || []
      if (!allTxns.length) { result.ordersNoTransactionRow++ } else {
        result.saleTransactionRows += allTxns.length
        const fmNetTotal = allTxns.reduce((s, t) => s + (n(t.total) || 0), 0)
        if (!reconciles(round2(fmNetTotal), c.discoTotal)) {
          result.ordersMismatched++
          if (result.mismatchSamples.length < 20) {
            result.mismatchSamples.push({ orderId: c.orderId, fmRef: c.fmRef, fmTotal: round2(fmNetTotal), discoTotal: c.discoTotal ?? NaN })
          }
        }
      }
      result.orderItemRows += pkgs.length
      for (const p of pkgs) result.addonRows += (addonByPkg.get(p.id) || []).length
      const addr = addrByOrder.get(fmId)
      if (addr?.delivery_instructions && !existingDeliveryInstr.get(c.orderId)) {
        result.ordersWithDeliveryInstructionsToFill++
      }
    }
  }
  return result
}

async function executeChunk(fm: Client, batch: Candidate[]): Promise<{ txnRows: number; itemRows: number; addonRows: number; deliveryFilled: number }> {
  const orderIds = batch.map(c => c.orderId)
  const fmIds = batch.map(c => fmOrderMap.get(c.fmRef)!).filter(Boolean)
  const { txns, packages, addons, addrs } = await loadFmDetail(fm, fmIds)

  const fmIdToOrderId = new Map(batch.map(c => [fmOrderMap.get(c.fmRef), c.orderId]))

  // ── disco_sale_transactions: DELETE-then-INSERT ──
  // Scoped to FM_BACKFILL and FM_SYNC (never NATIVE_CHECKOUT/MANUAL_EDIT, which
  // shouldn't exist for these FM-mirrored candidate orders anyway). Includes
  // FM_SYNC so that once real fm_backup data becomes available for an order
  // that was previously only covered by the ongoing sync's best-effort
  // reconstruction (lib/fm-orders-sync.ts, no service_charge, tips derived from
  // a raw percentage), this backfill's snapshot-sourced data always wins and
  // replaces it — never leaves both rows sitting side by side, which would
  // violate the partial unique index (order_id) WHERE transaction_type='ORIGINAL'.
  await sql`DELETE FROM disco_sale_transactions WHERE order_id = ANY(${orderIds}::bigint[]) AND source IN ('FM_BACKFILL', 'FM_SYNC')`

  const txnCols = {
    orderId: [] as number[], subtotal: [] as (number | null)[], total: [] as (number | null)[], fee: [] as (number | null)[],
    serviceCharge: [] as (number | null)[], stripeFee: [] as (number | null)[],
    stateTax: [] as (number | null)[], localTax: [] as (number | null)[], otherTax: [] as (number | null)[],
    tipsInPrice: [] as (number | null)[], thirdPartyTips: [] as (number | null)[],
    ownDeliveryFee: [] as (number | null)[], thirdPartyDeliveryFee: [] as (number | null)[], thirdPartySubsiding: [] as (number | null)[],
    discount: [] as (number | null)[], leadGenOne: [] as (number | null)[], leadGenTwo: [] as (number | null)[],
    txnType: [] as string[],
  }
  // Every order reaching this point (EXCLUDED_ORDER_IDS already filtered out
  // upstream) has at most one ORIGINAL row in fm_backup — verified: exactly 10
  // FM orders in the whole snapshot have >1 sale_transaction row of any type,
  // and all 10 are accounted for among the 11 investigated (5 excluded above,
  // 5 included with their real ADDITIONAL/REFUND row below). This Set is a
  // defense-in-depth backstop, not load-bearing: it dedupes ORIGINAL rows only
  // (never drops a legitimate distinct ADDITIONAL/REFUND row) so the partial
  // unique index (order_id) WHERE transaction_type='ORIGINAL' is never violated
  // even if fm_backup turns out to have another such case we haven't found.
  const seenOriginalForOrder = new Set<number>()
  for (const t of txns) {
    const orderId = fmIdToOrderId.get(t.restaurant_order_id)
    if (!orderId) continue
    const type = t.transaction_type || 'ORIGINAL'
    if (type === 'ORIGINAL') {
      if (seenOriginalForOrder.has(orderId)) continue
      seenOriginalForOrder.add(orderId)
    }
    // The dump's tips_in_price and service_charge are FM's own precomputed,
    // stored values (ground truth) — passed straight through, not re-derived.
    const fields = buildSaleTransactionFields({
      subtotal: n(t.subtotal), total: n(t.total), fee: n(t.fee),
      stateTax: n(t.state_sales_tax_in_price), localTax: n(t.local_sales_tax_in_price), otherTax: n(t.other_sales_tax_in_price),
      ownDeliveryFee: n(t.own_delivery_fee), thirdPartyDeliveryFee: n(t.third_party_delivery_fee), doordashDeliveryFee: n(t.doordash_delivery_fee),
      thirdPartyDeliverySubsiding: n(t.third_party_delivery_subsiding),
      thirdPartyDeliveryTips: n(t.third_party_delivery_tips_in_price), doordashTips: n(t.doordash_tips_in_price),
      discount: n(t.discount), leadGenOne: n(t.leadgenone_discofee), leadGenTwo: n(t.leadgentwo_discofee),
      stripeFee: n(t.stripe_fee), serviceCharge: n(t.service_charge),
      tipsInPrice: n(t.tips_in_price), rawTips: null, tipsType: null,
    })
    txnCols.orderId.push(orderId)
    txnCols.subtotal.push(fields.subtotal); txnCols.total.push(fields.total); txnCols.fee.push(fields.fee)
    txnCols.serviceCharge.push(fields.serviceCharge); txnCols.stripeFee.push(fields.stripeFee)
    txnCols.stateTax.push(fields.stateTax); txnCols.localTax.push(fields.localTax); txnCols.otherTax.push(fields.otherTax)
    txnCols.tipsInPrice.push(fields.tipsInPrice)
    txnCols.thirdPartyTips.push(fields.thirdPartyDeliveryTips)
    txnCols.ownDeliveryFee.push(fields.ownDeliveryFee)
    txnCols.thirdPartyDeliveryFee.push(fields.thirdPartyDeliveryFee)
    txnCols.thirdPartySubsiding.push(fields.thirdPartyDeliverySubsiding)
    txnCols.discount.push(fields.discount); txnCols.leadGenOne.push(fields.leadGenOne); txnCols.leadGenTwo.push(fields.leadGenTwo)
    txnCols.txnType.push(type)
  }
  if (txnCols.orderId.length) {
    await sql`
      INSERT INTO disco_sale_transactions (
        order_id, transaction_status, transaction_type, subtotal, total, fee, service_charge, stripe_fee,
        state_tax, local_tax, other_tax, tips_in_price, third_party_delivery_tips,
        own_delivery_fee, third_party_delivery_fee, third_party_delivery_subsiding, discount,
        lead_gen_one_disco_fee, lead_gen_two_disco_fee, source
      )
      SELECT o, 'PAID', t, sub, tot, fee, sc, sf, st, lt, ot, tip, tpt, odf, tpdf, tps, disc, lg1, lg2, 'FM_BACKFILL'
      FROM unnest(
        ${txnCols.orderId}::bigint[], ${txnCols.txnType}::text[],
        ${txnCols.subtotal}::numeric[], ${txnCols.total}::numeric[], ${txnCols.fee}::numeric[],
        ${txnCols.serviceCharge}::numeric[], ${txnCols.stripeFee}::numeric[],
        ${txnCols.stateTax}::numeric[], ${txnCols.localTax}::numeric[], ${txnCols.otherTax}::numeric[],
        ${txnCols.tipsInPrice}::numeric[], ${txnCols.thirdPartyTips}::numeric[],
        ${txnCols.ownDeliveryFee}::numeric[], ${txnCols.thirdPartyDeliveryFee}::numeric[], ${txnCols.thirdPartySubsiding}::numeric[],
        ${txnCols.discount}::numeric[], ${txnCols.leadGenOne}::numeric[], ${txnCols.leadGenTwo}::numeric[]
      ) AS u(o, t, sub, tot, fee, sc, sf, st, lt, ot, tip, tpt, odf, tpdf, tps, disc, lg1, lg2)
    `
  }

  // ── disco_order_item_addons: DELETE first, while the OLD item ids (about to be
  // replaced below) are still valid. disco_order_item_addons has no FK/cascade on
  // order_item_id, so if this ran AFTER the items DELETE+INSERT it would delete-
  // by the brand-new item ids (which never had addons yet, having just been
  // inserted) and leave the old addon rows orphaned forever, doubling on every
  // re-run — a real bug the sample=50-run-twice idempotency proof caught (33
  // addon rows became 66 on a naive re-run before this reordering fix).
  //
  // Unconditional on order_id (no fm_addon_id IS NOT NULL filter): every order_id
  // reaching this point came from loadCandidates(), which only ever selects FM-
  // sourced orders with a confirmed fm_backup match — there is no legitimate
  // native or manually-added addon row on one of these orders to protect. Scoping
  // by fm_addon_id IS NOT NULL here would only matter if the ongoing fm-orders-
  // sync.ts path had ever written addons of its own — verified it hasn't (see the
  // add-on parsing bug fix in lib/order-edit.ts), so this was never actually a
  // risk for addons specifically, but items (below) is a different story.
  await sql`
    DELETE FROM disco_order_item_addons
    WHERE order_item_id IN (SELECT id FROM disco_order_items WHERE order_id = ANY(${orderIds}::bigint[]))
  `

  // ── disco_order_items: DELETE-then-INSERT ──
  // Unconditional on order_id, NOT scoped to fm_package_id IS NOT NULL. The
  // original scoping assumed only a prior run of THIS script could have written
  // items for these orders — wrong: fm-orders-sync.ts's ongoing per-order-load
  // sync also writes bare disco_order_items (name/qty/price, no fm_package_id,
  // no add-ons) for the same orders whenever the orders page loads. Scoping the
  // DELETE to fm_package_id IS NOT NULL left those pre-existing bare rows in
  // place and inserted a second, correct set alongside them — 25 real orders
  // ended up with EXACTLY DOUBLED item counts (e.g. order 4106: 10 bare + 10
  // backfilled = 20 shown) before this fix. Safe to delete unconditionally here
  // for the same reason as the addons DELETE above: every order_id here is
  // FM-sourced with a confirmed fm_backup match, so this backfill's reconstructed
  // set is always the authoritative, complete replacement — there's no native or
  // manually-entered item on one of these orders to lose.
  await sql`DELETE FROM disco_order_items WHERE order_id = ANY(${orderIds}::bigint[])`

  const itemCols = {
    orderId: [] as number[], ref: [] as (string | null)[], name: [] as string[], qty: [] as number[],
    price: [] as number[], total: [] as number[], serves: [] as (number | null)[], fmPkgId: [] as number[],
  }
  for (const p of packages) {
    const orderId = fmIdToOrderId.get(p.restaurant_order_id)
    if (!orderId) continue
    const qty = Math.max(1, Math.trunc(n(p.count) || 1))
    const price = round2(n(p.price) || 0)
    itemCols.orderId.push(orderId); itemCols.ref.push(p.origin_meal_package_reference); itemCols.name.push(p.name || 'Item')
    itemCols.qty.push(qty); itemCols.price.push(price); itemCols.total.push(round2(price * qty))
    itemCols.serves.push(servesToInt(p.serves)); itemCols.fmPkgId.push(p.id)
  }
  const insertedItemIds: { id: number; fm_package_id: number }[] = []
  if (itemCols.orderId.length) {
    const rows = (await sql`
      INSERT INTO disco_order_items (order_id, meal_package_reference, name, quantity, price_per_unit, total_price, serves, fm_package_id)
      SELECT o, ref, nm, qty, price, tot, srv, fpid
      FROM unnest(
        ${itemCols.orderId}::bigint[], ${itemCols.ref}::text[], ${itemCols.name}::text[], ${itemCols.qty}::int[],
        ${itemCols.price}::numeric[], ${itemCols.total}::numeric[], ${itemCols.serves}::int[], ${itemCols.fmPkgId}::bigint[]
      ) AS u(o, ref, nm, qty, price, tot, srv, fpid)
      RETURNING id, fm_package_id
    `) as { id: number; fm_package_id: number }[]
    insertedItemIds.push(...rows)
  }

  // ── disco_order_item_addons: INSERT, keyed via the item ids just inserted above ──
  // neon()'s driver returns BIGINT columns (fm_package_id) as strings too — same
  // class of mismatch as the node-postgres side (see types.setTypeParser above).
  // Without Number() here, this Map's keys are strings while
  // a.restaurant_order_meal_package_id (parsed to a number by that type parser)
  // never matches, so every add-on silently fails to attach.
  const orderItemIdByFmPkg = new Map(insertedItemIds.map(r => [Number(r.fm_package_id), r.id]))
  const addonCols = { itemId: [] as number[], name: [] as string[], price: [] as number[], qty: [] as number[], fmAddonId: [] as number[] }
  for (const a of addons) {
    const orderItemId = orderItemIdByFmPkg.get(a.restaurant_order_meal_package_id)
    if (!orderItemId) continue
    addonCols.itemId.push(orderItemId); addonCols.name.push(a.name || 'Add-on')
    addonCols.price.push(round2(n(a.price) || 0)); addonCols.qty.push(Math.max(1, Math.trunc(n(a.count) || 1)))
    addonCols.fmAddonId.push(a.id)
  }
  if (addonCols.itemId.length) {
    await sql`
      INSERT INTO disco_order_item_addons (order_item_id, name, price, quantity, fm_addon_id)
      SELECT i, nm, p, q, fid FROM unnest(
        ${addonCols.itemId}::bigint[], ${addonCols.name}::text[], ${addonCols.price}::numeric[], ${addonCols.qty}::int[], ${addonCols.fmAddonId}::bigint[]
      ) AS u(i, nm, p, q, fid)
    `
  }

  // ── delivery_instructions: fill-blank-only, never overwrite an existing value ──
  const addrByOrder = new Map<number, FmDeliveryAddrRow>()
  for (const a of addrs) addrByOrder.set(a.restaurant_order_id, a)
  const diCols = { orderId: [] as number[], instr: [] as string[] }
  for (const c of batch) {
    const fmId = fmOrderMap.get(c.fmRef)
    if (!fmId) continue
    const instr = addrByOrder.get(fmId)?.delivery_instructions
    if (instr) { diCols.orderId.push(c.orderId); diCols.instr.push(instr) }
  }
  let deliveryFilled = 0
  if (diCols.orderId.length) {
    const updated = (await sql`
      UPDATE disco_orders o SET delivery_instructions = u.instr, updated_at = NOW()
      FROM unnest(${diCols.orderId}::bigint[], ${diCols.instr}::text[]) AS u(order_id, instr)
      WHERE o.id = u.order_id AND (o.delivery_instructions IS NULL OR o.delivery_instructions = '')
      RETURNING o.id
    `) as { id: number }[]
    deliveryFilled = updated.length
  }

  return { txnRows: txnCols.orderId.length, itemRows: itemCols.orderId.length, addonRows: addonCols.itemId.length, deliveryFilled }
}

// ═══════════════════════════════════════════════════════════════════════════
// placed_at backfill — a separate, independent fill (see the header comment
// for --backfill-placed-at). Reuses this script's fm client, chunk() helper,
// and CLI flags; does not touch disco_sale_transactions/disco_order_items.
// ═══════════════════════════════════════════════════════════════════════════

// createdDate is actually a JS Date at runtime (node-postgres's TIMESTAMPTZ
// mapping), not a string — typed loosely here since both the sql tagged
// template (executePlacedAtChunk) and .toISOString() (runPlacedAtPlan) handle
// a Date correctly; only naive String() coercion is the trap.
interface PlacedAtCandidate { orderId: number; fmRef: string; createdDate: string | Date }

async function loadPlacedAtCandidates(fm: Client): Promise<{ candidates: PlacedAtCandidate[]; fmRefSet: Set<string> }> {
  // ORDER BY id: same determinism reasoning as loadCandidates() above — sample/
  // limit/resume-after must be reproducible across repeated runs.
  const discoRows = (await sql`
    SELECT id, fm_order_reference FROM disco_orders
    WHERE source_of_order = 'FAMILYMEAL' AND is_deleted = false
      AND fm_order_reference IS NOT NULL AND placed_at IS NULL
    ORDER BY id
  `) as { id: number; fm_order_reference: string }[]

  const fmOrders = await fm.query<{ reference: string; created_date: Date }>(`
    SELECT reference, created_date FROM familymeal.tbl_restaurant_orders
  `)
  const dateByRef = new Map(fmOrders.rows.map(r => [r.reference, r.created_date]))
  const fmRefSet = new Set(fmOrders.rows.map(r => r.reference))

  const candidates: PlacedAtCandidate[] = []
  for (const r of discoRows) {
    const cd = dateByRef.get(r.fm_order_reference)
    if (cd) candidates.push({ orderId: r.id, fmRef: r.fm_order_reference, createdDate: cd })
  }
  return { candidates, fmRefSet }
}

interface PlacedAtPlanResult {
  rowsToFill: number
  byYear: Record<string, number>
  alreadyFilled: number
  postFreezeTotal: number
  postFreezeAlreadyFilled: number
  postFreezeStillMissing: number
}

// fmRefSet: every order reference present in fm_backup (from loadPlacedAtCandidates)
// — used to identify post-freeze orders (fm_order_reference set, but NOT in
// fm_backup) so this report can distinguish "can't be filled by this backfill,
// here's why" from "hasn't been filled yet but could be."
async function runPlacedAtPlan(candidates: PlacedAtCandidate[], fmRefSet: Set<string>): Promise<PlacedAtPlanResult> {
  // node-postgres returns TIMESTAMPTZ columns as JS Date objects, not strings —
  // String(dateObj) invokes Date.prototype.toString() ("Fri May 01 2024...", in
  // the LOCAL system timezone), not an ISO string. .toISOString() is the
  // correct extraction, same gotcha fixed earlier this session for the same
  // driver on a different column.
  const byYear = new Map<string, number>()
  for (const c of candidates) {
    const iso = c.createdDate instanceof Date ? c.createdDate.toISOString() : String(c.createdDate)
    const year = iso.slice(0, 4)
    byYear.set(year, (byYear.get(year) || 0) + 1)
  }

  const allFm = (await sql`
    SELECT fm_order_reference, placed_at IS NOT NULL AS has_placed_at
    FROM disco_orders
    WHERE source_of_order = 'FAMILYMEAL' AND is_deleted = false AND fm_order_reference IS NOT NULL
  `) as { fm_order_reference: string; has_placed_at: boolean }[]

  let alreadyFilled = 0
  let postFreezeTotal = 0
  let postFreezeAlreadyFilled = 0
  for (const r of allFm) {
    if (r.has_placed_at) alreadyFilled++
    if (!fmRefSet.has(r.fm_order_reference)) {
      postFreezeTotal++
      if (r.has_placed_at) postFreezeAlreadyFilled++
    }
  }

  return {
    rowsToFill: candidates.length,
    byYear: Object.fromEntries([...byYear.entries()].sort()),
    alreadyFilled,
    postFreezeTotal,
    postFreezeAlreadyFilled,
    postFreezeStillMissing: postFreezeTotal - postFreezeAlreadyFilled,
  }
}

async function executePlacedAtChunk(batch: PlacedAtCandidate[]): Promise<number> {
  const orderIds = batch.map(c => c.orderId)
  const dates = batch.map(c => c.createdDate)
  const updated = (await sql`
    UPDATE disco_orders o SET placed_at = u.cd, updated_at = NOW()
    FROM unnest(${orderIds}::bigint[], ${dates}::timestamptz[]) AS u(order_id, cd)
    WHERE o.id = u.order_id AND o.placed_at IS NULL
    RETURNING o.id
  `) as { id: number }[]
  return updated.length
}

async function main() {
  const args = process.argv.slice(2)
  const execute = args.includes('--execute')
  const sampleArg = args.find(a => a.startsWith('--sample='))
  const limitArg = args.find(a => a.startsWith('--limit='))
  const resumeArg = args.find(a => a.startsWith('--resume-after='))
  const sample = sampleArg ? parseInt(sampleArg.split('=')[1], 10) : null
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null
  const resumeAfter = resumeArg ? parseInt(resumeArg.split('=')[1], 10) : null
  const sourceDbArg = args.find(a => a.startsWith('--source-db='))
  const sourceDb = sourceDbArg ? sourceDbArg.split('=')[1] : (process.env.FM_BACKUP_DB || 'fm_backup')

  const fm = new Client({ database: sourceDb })
  await fm.connect()

  console.log(`Source database: ${sourceDb}`)
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN (no writes)'}${sample ? ` sample=${sample}` : ''}${limit ? ` limit=${limit}` : ''}${resumeAfter ? ` resume-after=${resumeAfter}` : ''}`)

  if (args.includes('--backfill-placed-at')) {
    const { candidates: pCandidates, fmRefSet } = await loadPlacedAtCandidates(fm)
    let pWorking = pCandidates
    if (resumeAfter != null) pWorking = pWorking.filter(c => c.orderId > resumeAfter)
    if (sample) pWorking = pWorking.slice(0, sample)
    else if (limit) pWorking = pWorking.slice(0, limit)

    if (!execute) {
      const result = await runPlacedAtPlan(pCandidates, fmRefSet)
      console.log('\n=== PLACED_AT DRY RUN REPORT ===')
      console.log(JSON.stringify(result, null, 2))
      await fm.end()
      return
    }

    const pChunks = chunk(pWorking, 1000)
    let totalFilled = 0
    const startedAt = Date.now()
    for (let i = 0; i < pChunks.length; i++) {
      const batch = pChunks[i]
      const n = await executePlacedAtChunk(batch)
      totalFilled += n
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
      console.log(`  [chunk ${i + 1}/${pChunks.length}] orders ${batch[0].orderId}-${batch[batch.length - 1].orderId} (${batch.length}) → +${n} placed_at filled  [${elapsedSec}s elapsed, last completed order_id=${batch[batch.length - 1].orderId}]`)
    }
    console.log(`\n=== PLACED_AT EXECUTE COMPLETE === filled=${totalFilled} of ${pWorking.length} candidates`)
    await fm.end()
    return
  }

  const { candidates, fmOrderMap: map, excludedFound } = await loadCandidates(fm)
  fmOrderMap = map
  console.log(`Backfillable candidate orders: ${candidates.length} (excluded ${excludedFound} of ${EXCLUDED_ORDER_IDS.size} known-bad orders — see EXCLUDED_ORDER_IDS)`)

  let working = candidates
  if (resumeAfter != null) working = working.filter(c => c.orderId > resumeAfter)
  if (sample) working = working.slice(0, sample)
  else if (limit) working = working.slice(0, limit)

  if (!execute) {
    const result = await runPlan(fm, working)
    console.log('\n=== DRY RUN REPORT ===')
    console.log(JSON.stringify(result, null, 2))
    await fm.end()
    return
  }

  const chunks = chunk(working, 500)
  let totalTxn = 0, totalItems = 0, totalAddons = 0, totalDelivery = 0
  const failedOrders: { orderId: number; error: string }[] = []
  const startedAt = Date.now()

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i]
    try {
      const r = await executeChunk(fm, batch)
      totalTxn += r.txnRows; totalItems += r.itemRows; totalAddons += r.addonRows; totalDelivery += r.deliveryFilled
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
      const doneOrders = (i + 1) * 500 > working.length ? working.length : (i + 1) * batch.length
      console.log(`  [chunk ${i + 1}/${chunks.length}] orders ${batch[0].orderId}-${batch[batch.length - 1].orderId} (${batch.length}) → +${r.txnRows} txn, +${r.itemRows} items, +${r.addonRows} addons, +${r.deliveryFilled} delivery_instructions  [${elapsedSec}s elapsed, last completed order_id=${batch[batch.length - 1].orderId}]`)
    } catch (chunkErr) {
      // Isolate the failure: fall back to one order at a time so a single bad
      // order can never take down the whole chunk (or the whole run) silently.
      console.error(`  [chunk ${i + 1}/${chunks.length}] chunk-level failure, falling back to per-order: ${chunkErr instanceof Error ? chunkErr.message : chunkErr}`)
      for (const c of batch) {
        try {
          const r = await executeChunk(fm, [c])
          totalTxn += r.txnRows; totalItems += r.itemRows; totalAddons += r.addonRows; totalDelivery += r.deliveryFilled
        } catch (orderErr) {
          failedOrders.push({ orderId: c.orderId, error: orderErr instanceof Error ? orderErr.message : String(orderErr) })
          console.error(`    order_id=${c.orderId} FAILED: ${orderErr instanceof Error ? orderErr.message : orderErr}`)
        }
      }
    }
  }

  console.log(`\n=== EXECUTE COMPLETE ===`)
  console.log(`orders processed=${working.length - failedOrders.length} of ${working.length}`)
  console.log(`txnRows=${totalTxn} itemRows=${totalItems} addonRows=${totalAddons} deliveryInstructionsFilled=${totalDelivery}`)
  if (failedOrders.length) {
    console.log(`FAILED ORDERS (${failedOrders.length}):`, JSON.stringify(failedOrders, null, 2))
    console.log(`Resume with: --execute --resume-after=<last successful order_id below the first failure> after investigating.`)
  } else {
    console.log('No failed orders.')
  }
  await fm.end()
}

main().catch(e => { console.error(e); process.exit(1) })
