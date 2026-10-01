// One-off repair of stored scheduled-report configurations.
//
// TWO INDEPENDENT DEFECTS, both the same shape: a vocabulary changed under
// saved configs and nothing migrated them.
//
//  1. COLUMNS. Commit 3dc0666 (2026-09-15) replaced the report column model
//     with FamilyMeal's 21 columns under new keys. Every report saved before
//     that holds the complete OLD key set, and buildReport silently dropped the
//     nine that no longer resolve — including subtotal, tax and total. Gracious
//     Bakery had configured a sales report and was receiving one with no money
//     columns in it at all.
//
//  2. FULFILMENT TYPES. The filter stored raw delivery_type values and the
//     picker offered three of the seven that exist, omitting every third-party
//     courier except DLIVRD_DELIVERY. Those raw values are migrated to the three
//     CONCEPTS the picker now offers, so "third-party delivery" means all four
//     courier values rather than the one that happened to be on the list.
//
// A DELIBERATE CHOICE IS PRESERVED. Two reports have Self-Delivery unticked and
// the default has always been all three, so that is a real decision, not a
// default — it is carried through untouched rather than "fixed" to everything.
//
// Dry run by default. Pass --apply to write.
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'
import { REPORT_COLUMNS } from '../lib/reports/native-reports'
import { collapseFulfillmentFilter } from '../lib/reports/fulfillment-filter'

const APPLY = process.argv.includes('--apply')

/**
 * Old column key → the current key(s) that carry the same information.
 *
 * An empty array means the old column has NO equivalent and is dropped. That is
 * reported, never silent — dropping a column a restaurant asked for is the
 * defect this script exists to repair, so doing it quietly here would be the
 * same mistake one layer down.
 */
const COLUMN_MIGRATION: Record<string, string[]> = {
  orderNumber: ['orderId'],
  orderDate: ['orderDate'],
  createdDate: ['createdDate'],
  // Both old columns described the same thing the Service column now prints.
  orderType: ['serviceType'],
  deliveryType: ['serviceType'],
  customerName: ['customerName'],
  // Subtotal is Net Sales; the single Tax column became the three FM taxes;
  // Total is Gross. Total Distributed is force-appended by buildReport, so the
  // payout appears whether or not it is listed here.
  subtotal: ['netSales'],
  tax: ['stateTax', 'localTax', 'otherTax'],
  total: ['gross'],
  // Restored to the column set as part of this fix (see ORDER_REPORT_COLUMNS).
  orderStatus: ['orderStatus'],
  // No equivalent in the current column set. Reported, not silently lost: the
  // row query does not select customer email or phone at all, so restoring these
  // is a query change, not a mapping. Raised rather than guessed at.
  customerEmail: [],
  customerPhone: [],
}

async function main() {
  const valid = new Set(REPORT_COLUMNS.map(c => c.key))
  const reports = (await sql`
    SELECT reference::text AS ref, name, columns, filter, created_at::text
    FROM disco_scheduled_reports ORDER BY created_at
  `) as { ref: string; name: string; columns: unknown; filter: Record<string, unknown> | null; created_at: string }[]

  let changed = 0
  for (const r of reports) {
    const cols = Array.isArray(r.columns) ? (r.columns as string[]).map(String) : []
    const filter = (r.filter && typeof r.filter === 'object' ? r.filter : {}) as Record<string, unknown>
    const storedDt = Array.isArray(filter.deliveryTypes) ? (filter.deliveryTypes as string[]).map(String) : []

    // ── Columns ────────────────────────────────────────────────────────────
    const invalid = cols.filter(k => !valid.has(k))
    const dropped: string[] = []
    let newCols = cols
    if (invalid.length) {
      const out: string[] = []
      for (const k of cols) {
        if (valid.has(k)) { out.push(k); continue }
        const mapped = COLUMN_MIGRATION[k]
        if (mapped === undefined) { dropped.push(`${k} (unknown)`); continue }
        if (mapped.length === 0) { dropped.push(`${k} (no equivalent)`); continue }
        out.push(...mapped)
      }
      newCols = [...new Set(out)].filter(k => valid.has(k))
    }

    // ── Fulfilment types ───────────────────────────────────────────────────
    const newDt = collapseFulfillmentFilter(storedDt)
    const dtChanged = JSON.stringify(newDt) !== JSON.stringify(storedDt)
    const colsChanged = JSON.stringify(newCols) !== JSON.stringify(cols)
    if (!dtChanged && !colsChanged) {
      console.log(`  ·  "${r.name}" (${r.ref.slice(0, 8)}) — already current`)
      continue
    }

    changed++
    console.log(`\n  ${APPLY ? 'UPDATING' : 'WOULD UPDATE'}  "${r.name}" (${r.ref.slice(0, 8)}, created ${r.created_at.slice(0, 10)})`)
    if (colsChanged) {
      console.log(`     columns  ${cols.length} -> ${newCols.length}`)
      console.log(`        before: ${cols.join(', ')}`)
      console.log(`        after:  ${newCols.join(', ')}`)
      if (dropped.length) console.log(`        DROPPED (no current equivalent): ${dropped.join(', ')}`)
    }
    if (dtChanged) {
      console.log(`     fulfilment  ${JSON.stringify(storedDt)} -> ${JSON.stringify(newDt)}`)
    }

    if (APPLY) {
      const nextFilter = { ...filter, deliveryTypes: newDt }
      await sql`
        UPDATE disco_scheduled_reports
           SET columns = ${JSON.stringify(newCols)}::jsonb,
               filter  = ${JSON.stringify(nextFilter)}::jsonb,
               updated_at = NOW()
         WHERE reference = ${r.ref}::uuid
      `
    }
  }

  console.log(`\n${changed} of ${reports.length} report${reports.length === 1 ? '' : 's'} ${APPLY ? 'updated' : 'would change'}.`)
  if (!APPLY && changed) console.log('Re-run with --apply to write.')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
