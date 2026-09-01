/**
 * Verifies that BOTH reminder passes are DISCO-source only.
 *
 * READ-ONLY — it never calls the cron and never sends mail. It re-runs each
 * pass's candidate SELECT with the 24h window widened to +/-180 days (so real
 * rows actually appear) and everything else intact, then runs the SAME query
 * with the source filter removed. The second query is the point: it proves the
 * filter is doing work on real data rather than passing because the table
 * happens to be empty.
 *
 * WHY IT MATTERS. disco_orders mirrors FAMILYMEAL-direct orders so the portal can
 * display them. FM already emails those customers AND those restaurants from
 * mg.familymeal.com. PASS 1 (customer) has always filtered on
 * source_of_order = 'DISCO'; PASS 2 (restaurant/admin) shipped without it, so
 * Disco was sending restaurants a second reminder for orders FM had already
 * reminded them about.
 *
 *   npx tsx scripts/verify-reminder-source-filter.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { readFileSync } from 'node:fs'
import { sql } from '../lib/db'

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

type Bucket = { source_of_order: string | null; n: number }
const fmt = (rows: Bucket[]) =>
  rows.length ? rows.map(r => `${r.source_of_order ?? '(null)'}=${r.n}`).join(' ') : '(none)'

async function main() {
  // ── 1. Both passes carry the clause, in the real route file ───────────────
  console.log('=== the route source ===')
  const src = readFileSync('app/api/cron/order-reminders/route.ts', 'utf8')
  const occurrences = (src.match(/AND o\.source_of_order = 'DISCO'/g) || []).length
  check('the DISCO-source clause appears twice (customer + restaurant)', occurrences === 2, `found ${occurrences}`)
  const pass2 = src.slice(src.indexOf('PASS 2'))
  check('PASS 2 specifically carries it', /AND o\.source_of_order = 'DISCO'/.test(pass2))
  check('PASS 2 still gates on the admin toggle', /ov\.admin_order_reminder_emails_enabled = true/.test(pass2))
  check('PASS 2 still gates on admin_reminder_sent', /o\.admin_reminder_sent = false/.test(pass2))

  // ── 2. What each pass would actually pick up, on real rows ────────────────
  // Same predicates as the route, with only the 24h window widened so there is
  // something to look at. Grouped by source so a leak is visible, not inferred.
  console.log('\n=== PASS 2 (restaurant) candidates, window widened to +/-180 days ===')
  const withFilter = (await sql`
    SELECT o.source_of_order, count(*)::int AS n
    FROM disco_orders o
    JOIN disco_restaurant_overrides ov ON ov.restaurant_reference = o.restaurant_reference::text
    LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
    WHERE ov.admin_order_reminder_emails_enabled = true
      AND o.order_status = 'DUE'
      AND o.is_deleted = false
      AND o.source_of_order = 'DISCO'
      AND ((o.order_date + o.order_time::time) AT TIME ZONE COALESCE(rc.timezone, 'America/New_York'))
            BETWEEN NOW() - INTERVAL '180 days' AND NOW() + INTERVAL '180 days'
    GROUP BY 1 ORDER BY 2 DESC
  `) as unknown as Bucket[]
  console.log(`   with the filter:    ${fmt(withFilter)}`)

  const withoutFilter = (await sql`
    SELECT o.source_of_order, count(*)::int AS n
    FROM disco_orders o
    JOIN disco_restaurant_overrides ov ON ov.restaurant_reference = o.restaurant_reference::text
    LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
    WHERE ov.admin_order_reminder_emails_enabled = true
      AND o.order_status = 'DUE'
      AND o.is_deleted = false
      AND ((o.order_date + o.order_time::time) AT TIME ZONE COALESCE(rc.timezone, 'America/New_York'))
            BETWEEN NOW() - INTERVAL '180 days' AND NOW() + INTERVAL '180 days'
    GROUP BY 1 ORDER BY 2 DESC
  `) as unknown as Bucket[]
  console.log(`   without the filter: ${fmt(withoutFilter)}`)

  const leaked = withFilter.filter(r => r.source_of_order !== 'DISCO')
  check('no FM-sourced order can reach the restaurant reminder', leaked.length === 0, fmt(leaked))

  const suppressed = withoutFilter.filter(r => r.source_of_order !== 'DISCO').reduce((a, r) => a + r.n, 0)
  check('the filter actually suppresses real FM-sourced orders (not a vacuous pass)',
    suppressed > 0, `${suppressed} FM-sourced order(s) would have been emailed`)

  const stillSent = withFilter.find(r => r.source_of_order === 'DISCO')?.n ?? 0
  check('Disco-sourced orders are still picked up', stillSent > 0, `${stillSent} candidate(s)`)

  // ── 3. The two passes agree with each other ───────────────────────────────
  console.log('\n=== PASS 1 (customer) — unchanged, used as the reference ===')
  const p1 = (await sql`
    SELECT o.source_of_order, count(*)::int AS n
    FROM disco_orders o
    JOIN disco_restaurant_overrides ov ON ov.restaurant_reference = o.restaurant_reference::text
    LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
    WHERE ov.order_reminder_emails_enabled = true
      AND o.order_status = 'DUE'
      AND o.is_deleted = false
      AND o.source_of_order = 'DISCO'
      AND o.customer_email IS NOT NULL AND o.customer_email <> ''
      AND ((o.order_date + o.order_time::time) AT TIME ZONE COALESCE(rc.timezone, 'America/New_York'))
            BETWEEN NOW() - INTERVAL '180 days' AND NOW() + INTERVAL '180 days'
    GROUP BY 1 ORDER BY 2 DESC
  `) as unknown as Bucket[]
  console.log(`   customer pass:      ${fmt(p1)}`)
  check('the customer pass is also DISCO-only', p1.every(r => r.source_of_order === 'DISCO'))

  // ── 4. Fleet context ──────────────────────────────────────────────────────
  const totals = (await sql`
    SELECT source_of_order, count(*)::int AS n FROM disco_orders
    WHERE is_deleted = false GROUP BY 1 ORDER BY 2 DESC
  `) as unknown as Bucket[]
  console.log(`\n   all orders by source: ${fmt(totals)}`)

  console.log('\n' + '='.repeat(66))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
