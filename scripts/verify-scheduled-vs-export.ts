/**
 * Proves a scheduled report and the on-demand export contain IDENTICAL figures
 * for the same restaurant and the same window.
 *
 * Both are supposed to go through buildOrderReportRows — this asserts it against
 * real data rather than trusting the call graph, and checks every financial
 * total cell-by-cell, not just the row count.
 *
 *   npx tsx -r dotenv/config scripts/verify-scheduled-vs-export.ts dotenv_config_path=.env.local
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { sql } from '../lib/db'
import { buildOrderReportRows, totalsRow, ORDER_REPORT_COLUMNS } from '../lib/reports/order-report-rows'
import { generateReportCsv } from '../lib/reports/native-reports'
import { resolvePeriod } from '../lib/reports/report-period'

let fail = 0
const chk = (label: string, ok: boolean, detail = '') => {
  if (!ok) fail++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  // A restaurant with real, varied data over the window.
  const pick = (await sql`
    SELECT o.restaurant_reference::text AS ref, max(o.restaurant_name) AS name, count(*)::int AS n
    FROM disco_orders o
    WHERE o.is_deleted = false AND o.order_date >= CURRENT_DATE - 120
    GROUP BY 1 ORDER BY 3 DESC LIMIT 1
  `) as { ref: string; name: string; n: number }[]
  const target = pick[0]
  console.log(`Restaurant under test: ${target.name} (${target.ref.slice(0, 8)}), ${target.n} orders in the last 120 days\n`)

  const period = resolvePeriod(
    { frequency: 'WEEKLY', timezone: 'America/New_York', rangeType: 'LAST_90_DAYS' },
    new Date(),
  )
  console.log(`Window: ${period.from} .. ${period.to}\n`)

  // ── the on-demand export path ──
  const exportRows = await buildOrderReportRows({
    refs: [target.ref], from: period.from, to: period.to, dateField: 'created_at',
  })
  const exportTotals = totalsRow(exportRows)

  // ── the scheduled-report path ──
  const { csv, rowCount } = await generateReportCsv({
    name: 'verify', frequency: 'WEEKLY', time: '09:00', timezone: 'America/New_York',
    columns: [], restaurantReference: target.ref,
    filter: { dateType: 'createdDate' },
  }, period)

  console.log('=== row counts ===')
  chk('scheduled row count equals the export row count', rowCount === exportRows.length,
    `scheduled ${rowCount} vs export ${exportRows.length}`)

  // ── every financial total, parsed back OUT of the emitted CSV ──
  console.log('\n=== financial totals, parsed back out of the generated CSV ===')
  const lines = csv.trim().split('\n')
  const header = lines[0].split(',').map(h => h.replace(/^"|"$/g, ''))
  const totalLine = lines[lines.length - 1].split(',').map(c => c.replace(/^"|"$/g, ''))
  const isTotalRow = totalLine.some(c => c === 'TOTAL')
  chk('the CSV carries a TOTAL row', isTotalRow)

  const money = (v: unknown) => Number(Number(v ?? 0).toFixed(2))
  let compared = 0
  for (const col of ORDER_REPORT_COLUMNS.filter(c => c.financial)) {
    const at = header.indexOf(col.label)
    if (at < 0) continue // legitimately hidden (e.g. subsidy) — nothing to compare
    const fromCsv = money(totalLine[at])
    const fromExport = money((exportTotals as Record<string, unknown>)[col.key])
    compared++
    chk(`${col.label}`, fromCsv === fromExport, `csv ${fromCsv.toFixed(2)} vs export ${fromExport.toFixed(2)}`)
  }
  chk('at least ten financial columns were actually compared', compared >= 10, `compared ${compared}`)

  // ── the window really is closed ──
  console.log('\n=== the window excludes today ===')
  const today = new Date().toISOString().slice(0, 10)
  chk('report window ends before today', period.to < today, `to=${period.to}, today=${today}`)

  console.log('\n' + '='.repeat(62))
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
