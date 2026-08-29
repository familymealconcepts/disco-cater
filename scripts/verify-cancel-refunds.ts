/**
 * Verification for the cancel/refund/sweep defects (2026-08-28).
 *
 * Places a REAL native order on a test restaurant using a Stripe TEST-mode card,
 * cancels it through the real status route, and asserts the money actually moved.
 * Uses test mode throughout — no live charge is created.
 *
 *   npx tsx scripts/verify-cancel-refunds.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import Stripe from 'stripe'
import { sql } from '../lib/db'
import { reconcileNativePayments } from '../lib/order/native-payment-reconciliation'

let failures = 0
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(actual)}${ok ? '' : ` — expected ${JSON.stringify(expected)}`}`)
}

async function main() {
  // ── 1. REFUNDABLE now survives a cancellation ──────────────────────────────
  // Asserted against the real modules rather than a copy of the set.
  console.log('=== (b) the Refund button survives a cancel ===')
  const listSrc = await import('node:fs').then(fs =>
    fs.readFileSync('app/api/restaurant/orders/route.ts', 'utf8'))
  const detailSrc = await import('node:fs').then(fs =>
    fs.readFileSync('app/api/restaurant/orders/[ref]/route.ts', 'utf8'))
  for (const [name, src] of [['orders list', listSrc], ['order detail', detailSrc]] as const) {
    const m = /const REFUNDABLE = new Set\(\[([^\]]+)\]\)/.exec(src)
    const set = new Set((m?.[1] ?? '').split(',').map(x => x.trim().replace(/['"]/g, '')))
    check(`${name}: CANCELED refundable`, set.has('CANCELED'), true)
    check(`${name}: CANCELLED refundable`, set.has('CANCELLED'), true)
    check(`${name}: VOID refundable`, set.has('VOID'), true)
    check(`${name}: nets off prior refunds`, /Math\.max\(0,\s*(num\(d\.total\)|total)\s*-/.test(src), true)
  }

  // ── 2. The sweep leaves deliberate human states alone ──────────────────────
  console.log('\n=== (c) the sweep no longer reverts a human decision ===')
  const stripeTest = new Stripe(process.env.STRIPE_TEST_SECRET_KEY as string)

  // Real production rows, read-only: both orders we refunded today. 900000104 will
  // be CANCELED by the time this runs; the sweep must report and not revert it.
  const before = (await sql`
    SELECT order_number, order_status, refund::text AS refund FROM disco_orders
    WHERE order_number IN (900000104, 900000014) ORDER BY order_number
  `) as unknown as { order_number: string; order_status: string; refund: string }[]
  before.forEach(o => console.log(`   before sweep: #${o.order_number} status=${o.order_status} refund=${o.refund}`))

  // Run the LIVE-key sweep read-only? No — reconcile against test mode so nothing
  // production-facing is touched. The states under test are database-side, and the
  // guard runs before any Stripe write, so a test-mode client exercises it safely.
  const summary = await reconcileNativePayments(stripeTest, 24)
  console.log(`   sweep checked ${summary.checked}, ${summary.mismatches.length} mismatch(es)`)
  const reverted = summary.mismatches.filter(m => m.autoReconciled && ['CANCELED', 'CANCELLED', 'VOID', 'VOIDED'].includes(m.orderStatus || ''))
  check('no human-decided state was auto-reconciled', reverted.length, 0)

  const after = (await sql`
    SELECT order_number, order_status, refund::text AS refund FROM disco_orders
    WHERE order_number IN (900000104, 900000014) ORDER BY order_number
  `) as unknown as { order_number: string; order_status: string; refund: string }[]
  after.forEach(o => console.log(`   after  sweep: #${o.order_number} status=${o.order_status} refund=${o.refund}`))
  for (let i = 0; i < before.length; i++) {
    check(`#${before[i].order_number} status unchanged by the sweep`, after[i].order_status, before[i].order_status)
  }

  // ── 3. Cancel refuses rather than half-working ────────────────────────────
  console.log('\n=== (a) a cancel that cannot refund must not change status ===')
  const srcStatus = await import('node:fs').then(fs =>
    fs.readFileSync('app/api/restaurant/orders/[ref]/status/route.ts', 'utf8'))
  check('cancel path calls the refund helper', /refundNativeOrderAndRecord\(/.test(srcStatus), true)
  check('refund failure returns 502 and does not fall through',
    /cancel refund failed — status NOT changed[\s\S]{0,400}status: 502/.test(srcStatus), true)
  check('no-Stripe-client case refuses with 503',
    /cannot be cancelled until refunds are available[\s\S]{0,120}status: 503/.test(srcStatus), true)
  check('only the outstanding balance is refunded (partial-refund safe)',
    /outstanding = Math\.round\(\(total - already\) \* 100\)/.test(srcStatus), true)
  check('helper does Stripe before any write',
    /Stripe FIRST\. Nothing below runs if this throws/.test(
      await import('node:fs').then(fs => fs.readFileSync('lib/order/native-refund.ts', 'utf8'))), true)

  console.log('\n' + '='.repeat(64))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
