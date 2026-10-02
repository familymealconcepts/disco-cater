// End-to-end verification of the three scheduled-report fixes.
//
//  1. Third-party delivery is matchable at all (it was not, for any report).
//  2. A saved report's columns resolve, money columns included.
//  3. An order that synced after its window still reaches a report.
//
// Builds the REAL report through buildReport with each report's REAL stored
// config. Sends nothing — buildReport is pure; only the cron emails.
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'
import { buildReport, REPORT_COLUMNS, type ScheduledReportConfig } from '../lib/reports/native-reports'
import { expandFulfillmentFilter, collapseFulfillmentFilter, sanitizeReportColumns, RETIRED_REPORT_COLUMNS } from '../lib/reports/fulfillment-filter'
import { resolvePeriod } from '../lib/reports/report-period'

let pass = 0, fail = 0
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

const GRACIOUS_SR = 'e5fa43f9-ba16-490b-a6cf-f0d3e9d8c012'

async function cfgOf(ref: string): Promise<{ cfg: ScheduledReportConfig; fileType: string; lastRun: string | null; name: string }> {
  const r = (await sql`
    SELECT name, frequency, time, timezone, weekday, day_of_month, range_type, range_days,
           auto_tidy, columns, filter, file_type, restaurant_reference::text AS rr, last_run_at::text AS last_run
    FROM disco_scheduled_reports WHERE reference = ${ref}::uuid
  `)[0] as any
  return {
    name: r.name, fileType: r.file_type, lastRun: r.last_run,
    cfg: {
      name: r.name, frequency: r.frequency, time: r.time, timezone: r.timezone,
      weekday: r.weekday, dayOfMonth: r.day_of_month, rangeType: r.range_type, rangeDays: r.range_days,
      autoTidy: r.auto_tidy === true, columns: r.columns, restaurantReference: r.rr, filter: r.filter,
    },
  }
}

async function main() {
  console.log('1. FULFILMENT FILTER — the concept expands to every courier value')
  check('THIRD_PARTY expands to all four', expandFulfillmentFilter(['THIRD_PARTY']).sort(),
    ['DLIVRD_DELIVERY', 'DOOR_DASH_DELIVERY', 'NASH_DELIVERY', 'THIRD_PARTY_DELIVERY'])
  check('a legacy raw value still matches itself', expandFulfillmentFilter(['PICKUP', 'OWN_DELIVERY']).sort(), ['OWN_DELIVERY', 'PICKUP'])
  check('legacy THIRD_PARTY_DELIVERY reads as the concept (superset, nothing lost)',
    expandFulfillmentFilter(['THIRD_PARTY_DELIVERY']).includes('NASH_DELIVERY'), true)
  check('an unrecognised value passes through rather than vanishing', expandFulfillmentFilter(['SOME_NEW_COURIER']), ['SOME_NEW_COURIER'])
  check('empty means no filter', expandFulfillmentFilter([]), [])
  check('raw values collapse back to concepts for the picker',
    collapseFulfillmentFilter(['PICKUP', 'DLIVRD_DELIVERY']), ['PICKUP', 'THIRD_PARTY'])

  console.log('\n2. STORED CONFIGS — every report now resolves every column it asks for')
  const valid = new Set(REPORT_COLUMNS.map(c => c.key))
  const all = (await sql`SELECT name, columns, filter FROM disco_scheduled_reports ORDER BY created_at`) as any[]
  for (const r of all) {
    const bad = (r.columns as string[]).filter(k => !valid.has(k))
    check(`"${String(r.name).slice(0, 30)}" has no unresolvable columns`, bad, [])
  }
  check('every report can now match third-party orders',
    all.every(r => expandFulfillmentFilter(r.filter?.deliveryTypes).includes('THIRD_PARTY_DELIVERY')), true)

  console.log("\n3. GRACIOUS BAKERY — what Monday's report would actually contain")
  const { cfg, fileType, lastRun } = await cfgOf(GRACIOUS_SR)
  // The window Monday 2026-10-05 will produce, from the real period resolver.
  const monday = new Date('2026-10-05T11:00:00Z')
  const period = resolvePeriod({ frequency: 'WEEKLY', timezone: cfg.timezone, rangeType: cfg.rangeType, rangeDays: cfg.rangeDays }, monday)
  console.log(`   window: ${period.from} → ${period.to}   (catch-up since ${lastRun})`)

  const gen = await buildReport({ ...cfg, catchUpSince: lastRun }, period, fileType)
  const csv = String(gen.body)
  const header = csv.split('\n')[0]
  console.log(`   rows=${gen.rowCount}  late=${gen.lateRows}  invalidColumns=${JSON.stringify(gen.invalidColumns)}`)
  console.log(`   header: ${header}`)

  check('no invalid columns', gen.invalidColumns, [])
  check('the report is not empty', gen.rowCount > 0, true)
  for (const h of ['Order ID', 'Status', 'Net Sales', 'Tax (State)', 'Gross', 'Total Distributed']) {
    check(`header carries "${h}"`, header.includes(h), true)
  }
  check('a third-party order is present', /Third-Party Delivery/.test(csv), true)
  check('money is real, not blank', /\d+\.\d\d/.test(csv), true)

  console.log('\n4. BEFORE/AFTER on the same window, to isolate the filter')
  const noTp = await buildReport(
    { ...cfg, catchUpSince: null, filter: { ...cfg.filter, deliveryTypes: ['PICKUP', 'DLIVRD_DELIVERY'] } }, period, fileType)
  const withTp = await buildReport({ ...cfg, catchUpSince: null }, period, fileType)
  console.log(`   old filter (PICKUP+DLIVRD only): ${noTp.rowCount} rows`)
  console.log(`   new filter (concepts):           ${withTp.rowCount} rows`)
  check('the filter fix is what changes the count', withTp.rowCount > noTp.rowCount, true)

  console.log('\n5. LATE-SYNC CATCH-UP — the order that was lost between two windows')
  // #80285521: placed 2026-09-04, synced 2026-09-10. The 09-07 run covered its
  // date but the row did not exist; the 09-14 window starts after its date.
  const w = { from: '2026-09-07', to: '2026-09-14' }
  const without = await buildReport({ ...cfg, catchUpSince: null }, w, fileType)
  const withCatch = await buildReport({ ...cfg, catchUpSince: '2026-09-07T11:00:39Z' }, w, fileType)
  console.log(`   09-07 → 09-14 without catch-up: ${without.rowCount} rows`)
  console.log(`   09-07 → 09-14 with catch-up:    ${withCatch.rowCount} rows (late=${withCatch.lateRows})`)
  check('the late order is recovered', withCatch.rowCount > without.rowCount, true)
  check('it is reported as late, not as in-window', withCatch.lateRows > 0, true)
  check('#80285521 specifically', String(withCatch.body).includes('80285521'), true)

  console.log('\n6. CATCH-UP CANNOT DOUBLE-COUNT OR REACH FORWARD')
  const future = await buildReport({ ...cfg, catchUpSince: '2000-01-01T00:00:00Z' }, { from: '2026-09-01', to: '2026-09-07' }, fileType)
  const lines = String(future.body).split('\n')
  const cells = (l: string) => l.split(',').map(c => c.replace(/^"|"$/g, ''))
  const head = cells(lines[0])
  const rowsOnly = lines.slice(1, -1)       // drop header and the totals row
  const ids = rowsOnly.map(l => cells(l)[0]).filter(Boolean)
  check('no duplicate orders', ids.length, new Set(ids).size)

  // THE COLUMN THE REPORT FILTERS ON, not any date in the row. This report is
  // createdDate-based, and an order created on the 6th for an October delivery
  // legitimately carries an October ORDER date — asserting on the whole row
  // flags that as a leak when it is simply the other column doing its job.
  const dateCol = head.indexOf(cfg.filter?.dateType === 'createdDate' ? 'Created Date' : 'Order Date')
  check('the filtered date column was found', dateCol >= 0, true)
  const dates = rowsOnly.map(l => cells(l)[dateCol]).filter(Boolean)
  console.log(`   filtered on "${head[dateCol]}": ${dates.join(' ')}`)
  check('nothing dated AFTER the window is pulled in', dates.filter(d => d > '2026-09-07'), [])

  console.log('\n7. RETIRED COLUMNS — customer contact details cannot come back')
  const keys = REPORT_COLUMNS.map(c => c.key)
  for (const k of ['customerEmail', 'customerPhone']) {
    check(`"${k}" is not offered as a column`, keys.includes(k), false)
    check(`"${k}" is listed as retired, not merely absent`, k in RETIRED_REPORT_COLUMNS, true)
    const s1 = sanitizeReportColumns(['orderId', k, 'gross'], keys)
    check(`"${k}" is refused at write time`, s1.columns, ['orderId', 'gross'])
    check(`"${k}" refusal carries a reason`, s1.rejected.map(r => r.key), [k])
  }
  check('an unknown key is refused too', sanitizeReportColumns(['orderId', 'nonsense'], keys).columns, ['orderId'])
  check('duplicates are collapsed', sanitizeReportColumns(['gross', 'gross'], keys).columns, ['gross'])
  check('a valid set passes through untouched', sanitizeReportColumns(['orderId', 'netSales'], keys).columns, ['orderId', 'netSales'])

  const stored = (await sql`
    SELECT count(*)::int AS n FROM disco_scheduled_reports
    WHERE columns::text ILIKE '%customerEmail%' OR columns::text ILIKE '%customerPhone%'
  `)[0] as { n: number }
  check('no stored report references either key', stored.n, 0)

  // The underlying data is not selected either, so even a key that somehow got
  // stored could only ever render blank.
  const q = (await sql`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'disco_orders' AND column_name IN ('customer_email','customer_phone')
  `)[0] as { n: number }
  console.log(`   (disco_orders still holds ${q.n} contact column(s) — the report query does not select them)`)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
