// Pass 1 of the FM missing-row backfill: inserts disco_orders header rows for
// pre-freeze fm_backup orders that never got a row at all (distinct from the
// earlier, already-completed backfill at scripts/fm-order-backfill.ts, which
// enriches rows that already existed). Pass 2 (that same script, run against
// the fm_order_reference set this pass creates) fills in the sale-transaction/
// item detail afterward — this pass only ever writes the header.
//
// Modes:
//   npx tsx scripts/fm-missing-row-backfill.ts              dry run, no writes (default)
//   npx tsx scripts/fm-missing-row-backfill.ts --execute     real writes
//
// Source database: local `fm_backup` (or --source-db=<name> / FM_BACKUP_DB env
// var), same convention as fm-order-backfill.ts. Never a remote connection.
//
// Scope: every fm_backup order with no disco_orders row (by fm_order_reference),
// MINUS the 3 confirmed EXPIRED/INITIATED order_number-collision artifacts
// below (FM's checkout retried an abandoned cart and wrote a second identical-
// total row instead of replacing the first — never paid, not a real order; same
// exclusion shape as scripts/fm-order-backfill.ts's EXCLUDED_ORDER_IDS, applied
// here by fm_backup order id for the same reason: fm_order_reference values
// aren't known ahead of time by anyone reading this file, ids are stable and
// visible in fm_backup directly).
//
// Two other EXPIRED/INITIATED artifacts in the same shape (fm_backup id 2890,
// 2389) already landed in Neon before this population was known — reported
// separately, deliberately NOT touched by this script. Their groups' real
// order_number slot is therefore already occupied; every real order in those
// two groups gets a synthetic number below (see "slot already occupied").
const EXCLUDED_ORDER_IDS = new Set<number>([2324, 1946, 3416])

// Deliberate completeness: no restaurant- or dollar-value-based filtering.
// Test Kitchen (187 orders) and the 126 zero-dollar no-email orders are in
// scope like everything else.

import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { Client, types } from 'pg'
types.setTypeParser(20, (val: string) => parseInt(val, 10))
import { neon } from '@neondatabase/serverless'
import { fetchAllFmRestaurants } from '../lib/restaurant-cache'
import { guestPlaceholderEmail, unlinkedPlaceholderEmail } from '../lib/customer-email-guard'

const sql = neon(process.env.DATABASE_URL as string)
const SOURCE_DB = process.argv.find(a => a.startsWith('--source-db='))?.split('=')[1] || process.env.FM_BACKUP_DB || 'fm_backup'
const EXECUTE = process.argv.includes('--execute')

// Synthetic order_number for a disambiguated collision loser: obviously not a
// real FM number (always starts 700000..., a run of zeros FM's date-derived
// encoding never produces), deterministic (pure function of FM's own stable
// id), globally unique (fm id is unique fleet-wide, not just per restaurant),
// nowhere near disco_native_order_seq's 900,000,000-and-up range or any real
// FM order_number (11-17 digits observed, always far larger).
function syntheticOrderNumber(fmId: number): number {
  return 70_000_000_000 + fmId
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

// Same allowlist as the live sync path (lib/fm-orders-sync.ts) — an
// unrecognized value goes to NULL (the CHECK constraint allows that) rather
// than failing the whole row's insert.
const ALLOWED_DELIVERY_TYPES = new Set([
  'NASH_DELIVERY', 'OWN_DELIVERY', 'DOORDASH', 'SHIPDAY', 'THIRD_PARTY',
  'THIRD_PARTY_DELIVERY', 'PICKUP', 'DLIVRD', 'DOOR_DASH_DELIVERY', 'DLIVRD_DELIVERY',
])

interface FmRow {
  id: number
  fm_order_reference: string
  order_number: string
  order_date: string
  order_time: string
  order_type: string | null
  order_status: string
  delivery_type: string | null
  source_of_order: string
  note: string | null
  restaurant_id: number
  restaurant_reference: string | null
  restaurant_name: string | null
  restaurant_blocked: boolean | null
  restaurant_customer_id: number | null
  subtotal: string | null
  total: string | null
  fee: string | null
  tips_in_price: string | null
  state_sales_tax_in_price: string | null
  local_sales_tax_in_price: string | null
  other_sales_tax_in_price: string | null
  own_delivery_fee: string | null
  third_party_delivery_fee: string | null
  customer_email: string | null
  customer_first_name: string | null
  customer_last_name: string | null
  customer_phone: string | null
  delivery_instructions: string | null
}

function n(v: string | null): number | null {
  if (v == null) return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

async function main() {
  console.log(`mode: ${EXECUTE ? 'EXECUTE (real writes)' : 'DRY RUN (no writes)'}  source db: ${SOURCE_DB}`)

  console.log('\n[1] loading existing disco_orders.fm_order_reference set (fresh, right now)...')
  const existingRows = (await sql`SELECT fm_order_reference::text AS ref FROM disco_orders WHERE fm_order_reference IS NOT NULL`) as { ref: string }[]
  const existingSet = new Set(existingRows.map(r => r.ref))
  console.log('    existing FM-referenced disco_orders rows:', existingSet.size)

  console.log(`[2] connecting to ${SOURCE_DB}...`)
  const fm = new Client({ database: SOURCE_DB })
  await fm.connect()

  console.log('[3] loading all fm_backup orders + restaurant + ORIGINAL sale-transaction + customer + delivery address...')
  const { rows: allRows } = await fm.query(`
    SELECT
      o.id, o.reference AS fm_order_reference, o.order_number, o.order_date, o.order_time,
      o.order_type, o.order_status, o.delivery_type, o.source_of_order, o.note,
      o.restaurant_id,
      r.reference AS restaurant_reference, r.business_name AS restaurant_name, r.blocked AS restaurant_blocked,
      st.restaurant_customer_id,
      st.subtotal, st.total, st.fee, st.tips_in_price,
      st.state_sales_tax_in_price, st.local_sales_tax_in_price, st.other_sales_tax_in_price,
      st.own_delivery_fee, st.third_party_delivery_fee,
      rc.email AS customer_email, rc.first_name AS customer_first_name, rc.last_name AS customer_last_name,
      rc.phone_number AS customer_phone,
      da.delivery_instructions
    FROM familymeal.tbl_restaurant_orders o
    LEFT JOIN familymeal.tbl_restaurants r ON r.id = o.restaurant_id
    LEFT JOIN familymeal.tbl_restaurant_sale_transactions st ON st.restaurant_order_id = o.id AND st.transaction_type = 'ORIGINAL'
    LEFT JOIN familymeal.tbl_restaurant_customers rc ON rc.id = st.restaurant_customer_id
    LEFT JOIN familymeal.tbl_restaurant_delivery_addresses da ON da.restaurant_order_id = o.id
    WHERE o.is_deleted = false
  `) as { rows: FmRow[] }
  console.log('    total fm_backup order rows (post-join, may fan out on >1 ORIGINAL txn):', allRows.length)

  // Dedup by fm_order_reference (fan-out guard) before anything else.
  const byRef = new Map<string, FmRow>()
  for (const r of allRows) if (!byRef.has(r.fm_order_reference)) byRef.set(r.fm_order_reference, r)
  const allOrders = [...byRef.values()]

  // Not-yet-synced, minus the 3 confirmed artifacts. Still includes bucket C
  // below (the population the existing cache-independent cron will close on
  // its own) — that gets excluded from the actual candidate set right after
  // bucket classification, but is computed against this superset first so the
  // bucket report stays complete/informational.
  const notYetSynced = allOrders.filter(r => !existingSet.has(r.fm_order_reference) && !EXCLUDED_ORDER_IDS.has(r.id))
  const excludedFound = allOrders.filter(r => EXCLUDED_ORDER_IDS.has(r.id) && !existingSet.has(r.fm_order_reference))
  console.log('[4] not yet synced (deduped, excluding the 3 artifacts):', notYetSynced.length)
  console.log('    exclusions actually applied (should be 3):', excludedFound.length)
  for (const e of excludedFound) console.log(`      excluded: id=${e.id} ref=${e.fm_order_reference} order_number=${e.order_number} status=${e.order_status}`)

  // ── Structural buckets (fresh, live) ──────────────────────────────────────
  console.log('\n[5] fetching live FM restaurant list + disco_restaurant_cache + current per-restaurant order counts...')
  const fmRowsLive = await fetchAllFmRestaurants()
  const liveFmRefs = new Set(fmRowsLive.map((r: any) => String(r.reference ?? r.restaurantReference ?? '')).filter(isUuid))
  const cacheRows = (await sql`SELECT restaurant_reference::text AS ref FROM disco_restaurant_cache`) as { ref: string }[]
  const cacheRefSet = new Set(cacheRows.map(r => r.ref))
  const currentCountRows = (await sql`SELECT restaurant_reference::text AS ref, COUNT(*)::int AS n FROM disco_orders WHERE is_deleted = false GROUP BY restaurant_reference`) as any[]
  const currentCount = new Map(currentCountRows.map(r => [r.ref, r.n]))

  const buckets: Record<string, { count: number; dollars: number; restaurants: Set<string> }> = {
    A_not_in_live_api: { count: 0, dollars: 0, restaurants: new Set() },
    B_no_email: { count: 0, dollars: 0, restaurants: new Set() },
    C_cron_will_close: { count: 0, dollars: 0, restaurants: new Set() },
    D_cron_frozen_nonzero: { count: 0, dollars: 0, restaurants: new Set() },
    E_cache_visible_stopAtKnownDate_blind_spot: { count: 0, dollars: 0, restaurants: new Set() },
  }
  const bucketOf = new Map<string, string>()
  for (const r of notYetSynced) {
    const total = n(r.total) ?? n(r.subtotal) ?? 0
    const ref = r.restaurant_reference
    let bucket: string
    if (!ref || !liveFmRefs.has(ref)) bucket = 'A_not_in_live_api'
    else if (r.restaurant_customer_id == null || !r.customer_email) bucket = 'B_no_email'
    else if (!cacheRefSet.has(ref) && (currentCount.get(ref) || 0) === 0) bucket = 'C_cron_will_close'
    else if (!cacheRefSet.has(ref)) bucket = 'D_cron_frozen_nonzero'
    else bucket = 'E_cache_visible_stopAtKnownDate_blind_spot'
    buckets[bucket].count++
    buckets[bucket].dollars += total
    if (ref) buckets[bucket].restaurants.add(ref)
    bucketOf.set(r.fm_order_reference, bucket)
  }
  console.log('\n=== ROWS BY BUCKET ===')
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: orders=${v.count} $${v.dollars.toFixed(2)} restaurants=${v.restaurants.size}`)

  // Approved scope is A+B+D+E — bucket C (the existing cache-independent cron
  // will close these on its own) is reported above for completeness but
  // deliberately excluded from this pass's actual candidate set, so this
  // script never does work the cron already does, redundantly or otherwise.
  const missing = notYetSynced.filter(r => bucketOf.get(r.fm_order_reference) !== 'C_cron_will_close')
  console.log(`\n[4b] candidate rows for this pass (excluding bucket C): ${missing.length}`)

  // ── Order-number disambiguation ───────────────────────────────────────────
  // Fleet-wide dup groups over ALL fm_backup orders (not just missing) — a
  // group's "real" slot may already be occupied by a row that landed before
  // this pass ever ran (including, for 2 groups, by an untouched artifact).
  console.log('\n[6] computing order_number collision groups (fleet-wide, all restaurants)...')
  const { rows: dupGroupsRaw } = await fm.query(`
    SELECT restaurant_id, order_number, array_agg(id) AS ids
    FROM familymeal.tbl_restaurant_orders
    WHERE is_deleted = false
    GROUP BY restaurant_id, order_number
    HAVING COUNT(*) > 1
  `)
  const byId = new Map(allOrders.map(r => [r.id, r]))
  const missingByRef = new Map(missing.map(r => [r.fm_order_reference, r]))

  interface Disambig { fmId: number; ref: string; realNumber: string; syntheticNumber: number; keptOriginal: boolean }
  const disambiguations: Disambig[] = []
  const finalOrderNumber = new Map<string, { orderNumber: string; raw: string | null }>()

  for (const g of dupGroupsRaw as { restaurant_id: number; order_number: string; ids: number[] }[]) {
    const members = g.ids.map(id => byId.get(id)).filter((r): r is FmRow => !!r)
    const missingMembers = members.filter(r => missingByRef.has(r.fm_order_reference))
    if (!missingMembers.length) continue // nothing in this group needs a decision from us

    // Is the real (unmodified) order_number already held by some row in Neon
    // right now — whether that's a normal already-synced order OR one of the
    // 2 untouched artifacts?
    const slotHolder = (await sql`
      SELECT fm_order_reference::text AS ref FROM disco_orders
      WHERE restaurant_reference = ${members[0].restaurant_reference}::uuid AND order_number = ${g.order_number}::bigint
      LIMIT 1
    `) as { ref: string }[]
    const slotOccupied = slotHolder.length > 0

    let keeperFmId: number | null = null
    if (!slotOccupied) {
      // Nothing holds the real slot yet — lowest fm id among this group's
      // missing (non-excluded) members keeps it. Not insertion order: this is
      // FM's own stable id, fixed regardless of what order this script — or
      // any future re-run — happens to process rows in.
      keeperFmId = Math.min(...missingMembers.map(r => r.id))
    }

    for (const r of missingMembers) {
      if (r.id === keeperFmId) {
        finalOrderNumber.set(r.fm_order_reference, { orderNumber: g.order_number, raw: null })
        disambiguations.push({ fmId: r.id, ref: r.fm_order_reference, realNumber: g.order_number, syntheticNumber: syntheticOrderNumber(r.id), keptOriginal: true })
      } else {
        const synth = syntheticOrderNumber(r.id)
        finalOrderNumber.set(r.fm_order_reference, { orderNumber: String(synth), raw: g.order_number })
        disambiguations.push({ fmId: r.id, ref: r.fm_order_reference, realNumber: g.order_number, syntheticNumber: synth, keptOriginal: false })
      }
    }
  }
  console.log('    missing rows needing disambiguation:', disambiguations.length)
  console.log('    of which kept their real order_number (group winner):', disambiguations.filter(d => d.keptOriginal).length)
  console.log('    of which got a synthetic number (group loser):', disambiguations.filter(d => !d.keptOriginal).length)

  console.log('\n=== DISAMBIGUATED ORDER_NUMBERS (every one) ===')
  for (const d of disambiguations) {
    console.log(`  fm_id=${d.fmId} ref=${d.ref} real=${d.realNumber} synthetic=${d.syntheticNumber} keptOriginal=${d.keptOriginal}`)
  }

  // ── Placeholder emails + totals ───────────────────────────────────────────
  let guestCount = 0, unlinkedCount = 0, realEmailCount = 0, totalDollars = 0
  for (const r of missing) {
    totalDollars += n(r.total) ?? n(r.subtotal) ?? 0
    if (r.restaurant_customer_id == null) guestCount++
    else if (r.customer_email) realEmailCount++
    else unlinkedCount++
  }
  // disco_orders.order_date/order_time are NOT NULL; fm_backup's are nullable.
  // Flag any row that would fail on that constraint (a different reason than
  // any of the 5 buckets above) rather than silently letting a real --execute
  // run discover it row-by-row.
  const nullDateOrTime = missing.filter(r => !r.order_date || !r.order_time)
  if (nullDateOrTime.length) {
    console.log(`\n[WARNING] ${nullDateOrTime.length} row(s) have a NULL order_date or order_time in fm_backup — these would fail the NOT NULL constraint, not covered by any bucket above:`)
    for (const r of nullDateOrTime) console.log(`  id=${r.id} ref=${r.fm_order_reference} order_date=${r.order_date} order_time=${r.order_time}`)
  }

  console.log('\n=== TOTALS ===')
  console.log('total rows to insert:', missing.length)
  console.log('total dollar value:', totalDollars.toFixed(2))
  console.log('email: real=', realEmailCount, 'guest(placeholder)=', guestCount, 'unlinked(placeholder)=', unlinkedCount)
  console.log('total placeholder rows:', guestCount + unlinkedCount)

  // ── Concurrent-insert safety note ─────────────────────────────────────────
  console.log('\n[note] concurrent cron insert mid-run: handled per-row. disco_orders_fm_order_reference_uq')
  console.log('  (and, for the disambiguated rows, disco_orders_restaurant_order_number_uq) make a live')
  console.log('  duplicate a Postgres 23505 on that one row, caught individually — same pattern already')
  console.log('  proven in production during the Mavs Top Buns trigger (353 individual 23505s caught,')
  console.log('  0 effect on the other 804 successful inserts in the same run). Never a batch abort.')

  if (!EXECUTE) {
    console.log('\nDRY RUN — no rows written. Re-run with --execute for real writes.')
    await fm.end()
    return
  }

  // ── Real insert (per-row, catches 23505 as skip) ──────────────────────────
  console.log('\n[7] loading restaurant snapshots (address/phone) from disco_restaurant_cache...')
  const restaurantRefs = [...new Set(missing.map(r => r.restaurant_reference).filter((r): r is string => !!r))]
  const snapRows = (await sql`
    SELECT restaurant_reference::text AS ref, name, address, phone FROM disco_restaurant_cache
    WHERE restaurant_reference::text = ANY(${restaurantRefs})
  `.catch(() => [])) as { ref: string; name: string | null; address: string | null; phone: string | null }[]
  const snapshots = new Map(snapRows.map(s => [s.ref, s]))

  console.log('[8] inserting rows...')
  let inserted = 0, skippedConflict = 0, skippedOther = 0
  for (const r of missing) {
    const fo = finalOrderNumber.get(r.fm_order_reference)
    const orderNumber = fo ? fo.orderNumber : r.order_number
    const rawOrderNumber = fo ? fo.raw : null

    let email: string
    if (r.customer_email) email = r.customer_email
    else if (r.restaurant_customer_id == null) email = guestPlaceholderEmail(r.fm_order_reference)
    else email = unlinkedPlaceholderEmail(r.fm_order_reference)

    const orderType: 'PICKUP' | 'DELIVERY' = (r.order_type || '').toUpperCase() === 'DELIVERY' ? 'DELIVERY' : 'PICKUP'
    const deliveryType = r.delivery_type && ALLOWED_DELIVERY_TYPES.has(r.delivery_type) ? r.delivery_type : null
    const snap = r.restaurant_reference ? snapshots.get(r.restaurant_reference) : undefined

    try {
      await sql`
        INSERT INTO disco_orders (
          fm_order_reference, order_number, fm_order_number_raw, order_status, order_type, delivery_type, source_of_order,
          restaurant_reference, restaurant_name, restaurant_address, restaurant_phone,
          customer_email, customer_first_name, customer_last_name, customer_phone,
          order_date, order_time, subtotal, total, fee, tips, note, delivery_instructions,
          placed_at, created_at, updated_at
        ) VALUES (
          ${r.fm_order_reference}::uuid, ${orderNumber}::bigint, ${rawOrderNumber ? Number(rawOrderNumber) : null}, ${r.order_status || 'DUE'}, ${orderType}, ${deliveryType}, 'FAMILYMEAL',
          ${r.restaurant_reference}::uuid, ${r.restaurant_name || snap?.name || null}, ${snap?.address || null}, ${snap?.phone || null},
          ${email}, ${r.customer_first_name}, ${r.customer_last_name}, ${r.customer_phone},
          ${r.order_date}::date, ${r.order_time}::time, ${n(r.subtotal)}, ${n(r.total)}, ${n(r.fee)}, ${n(r.tips_in_price) ?? 0}, ${r.note}, ${r.delivery_instructions},
          ${r.order_date}::date, NOW(), NOW()
        )
      `
      inserted++
    } catch (e: any) {
      if (e?.code === '23505') { skippedConflict++; continue } // already synced by something else mid-run — not an error
      skippedOther++
      console.error(`[fm-missing-row-backfill] insert failed for ${r.fm_order_reference}:`, e instanceof Error ? e.message : e)
    }
  }
  console.log(`inserted=${inserted} skippedConflict=${skippedConflict} skippedOther=${skippedOther}`)
  await fm.end()
}

main().catch(e => { console.error(e); process.exit(1) })
