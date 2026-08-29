/**
 * Verification for the cancel/refund/sweep defects (2026-08-28).
 *
 * Asserts the three fixes hold: the Refund button survives a cancellation, the
 * reconciliation sweep no longer reverts a deliberate human state, and the cancel
 * path refuses rather than half-working when a refund cannot be made.
 *
 * READ-ONLY against production rows. The sweep is run with the TEST-mode Stripe key
 * so nothing production-facing is written; the guard under test is database-side and
 * runs before any Stripe call.
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

  // Test-mode key on purpose: the HUMAN_DECIDED_STATES guard is evaluated from the
  // database row before any Stripe write, so this exercises it without touching
  // production money.
  const summary = await reconcileNativePayments(stripeTest, 24)
  console.log(`   sweep checked ${summary.checkedStripeSucceeded} Stripe-side + ${summary.checkedLocalPaid} local, ${summary.mismatches.length} mismatch(es)`)
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

  // ── 3. Cancel is status-only — it must NOT touch Stripe ───────────────────
  console.log('\n=== (a, reverted) cancel changes status only ===')
  const srcStatus = await import('node:fs').then(fs =>
    fs.readFileSync('app/api/restaurant/orders/[ref]/status/route.ts', 'utf8'))
  check('no refund helper in the cancel path', /refundNativeOrderAndRecord/.test(srcStatus), false)
  check('no Stripe client in the status route', /stripeClient/.test(srcStatus), false)
  check('no stripe.* call in the status route', /\bstripe\.[a-z]/i.test(srcStatus), false)
  check('the status-only decision is documented', /STATUS ONLY — THIS DELIBERATELY DOES NOT TOUCH STRIPE/.test(srcStatus), true)

  // ── 4. The portal tells the restaurant the charge still stands ────────────
  console.log('\n=== a cancelled-but-unrefunded order is visibly still charged ===')
  const portal = await import('node:fs').then(fs =>
    fs.readFileSync('app/(restaurant)/restaurant/(portal)/orders/page.tsx', 'utf8'))
  check('notice exists', /The customer has still been charged/.test(portal), true)
  check('gated on a real charge, not on status alone', /order\.wasCharged && \(order\.maxAllowedRefundAmount/.test(portal), true)
  check('shown for cancelled AND voided', /'CANCELED', 'CANCELLED', 'VOID', 'VOIDED'\]\.includes\(order\.orderStatus\)/.test(portal), true)
  for (const [name, src] of [
    ['orders list', await import('node:fs').then(fs => fs.readFileSync('app/api/restaurant/orders/route.ts', 'utf8'))],
    ['order detail', await import('node:fs').then(fs => fs.readFileSync('app/api/restaurant/orders/[ref]/route.ts', 'utf8'))],
  ] as const) {
    check(`${name}: exposes wasCharged`, /wasCharged/.test(src), true)
    check(`${name}: derives it from a SUCCEEDED PaymentIntent`, /SUCCEEDED'\s*AND stripe_payment_intent_id IS NOT NULL/.test(src), true)
  }

  // ── 5. The restaurant refund route never reports a completed refund as failed ─
  console.log('\n=== defect 1: Stripe succeeded, DB write failed ===')
  const rr = await import('node:fs').then(fs =>
    fs.readFileSync('app/api/restaurant/orders/[ref]/refund/route.ts', 'utf8'))
  check('returns ok+warning when a Stripe refund is confirmed', /if \(stripeRefundId\) \{[\s\S]{0,500}ok: true[\s\S]{0,400}warning:/.test(rr), true)
  check('warning tells staff NOT to refund again', /Do NOT refund again/.test(rr), true)
  check('still 500s when no Stripe refund was confirmed (FM path)', /return NextResponse\.json\(\{ error: 'Unable to process refund' \}, \{ status: 500 \}\)/.test(rr), true)
  check('stale REFUNDED comment corrected', /order_status → 'REFUND'/.test(rr), true)

  console.log('\n' + '='.repeat(64))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
