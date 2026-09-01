/**
 * Verifies the cancellation + refund customer emails.
 *
 * SENDS NOTHING. sendEmail is stubbed at the module boundary before the routes
 * are imported, so every "send" is captured in memory. Real production rows are
 * only READ; the one write path (the idempotency claim) is exercised against a
 * scratch order that is deleted at the end.
 *
 * Asserts:
 *   1. Each cancel path sends EXACTLY ONE email, and a repeat call sends none.
 *   2. An FM-sourced cancellation sends NOTHING (FM emails those customers).
 *   3. Cancel never promises a refund — the charged wording says the restaurant
 *      will be in touch, and the words "refunded"/"refund is on its way" never
 *      appear unless money has actually gone back.
 *   4. Full vs partial refunds differ in subject AND body, and a partial refund
 *      on an already-cancelled order does NOT claim the order is proceeding.
 *
 *   npx tsx scripts/verify-cancel-refund-emails.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { sql, runDiscoOrderMigrations } from '../lib/db'

// ── Intercept at the WIRE, not at the module boundary ──────────────────────
// globalThis.fetch is replaced so any Mailgun call is captured instead of sent.
// This is deliberately the strongest place to assert: it inspects the multipart
// body Mailgun would actually have received, so it tests the real send path
// (layout, html-to-text, headers) rather than the arguments to a stub. Every
// non-Mailgun request still goes through untouched.
interface Sent { to: string; subject: string; html: string }
const sent: Sent[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('api.mailgun.net') && init?.method === 'POST') {
    const form = init.body as FormData
    sent.push({
      to: String(form.get('to') ?? ''),
      subject: String(form.get('subject') ?? ''),
      html: String(form.get('html') ?? ''),
    })
    return new Response(JSON.stringify({ id: '<captured@verify>' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

import * as notifications from '../lib/email/notifications'
import { sendOrderCancellationEmail } from '../lib/order/cancellation-email'

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

// Scratch orders are identified by this sentinel email so a run that dies
// half-way can be cleaned up by the next one — the composite
// (restaurant_reference, order_number) unique index otherwise blocks a re-run.
const SCRATCH_EMAIL = 'verify-emails@example.invalid'

async function purgeScratch(): Promise<number> {
  const refs = (await sql`
    SELECT reference FROM disco_orders WHERE customer_email = ${SCRATCH_EMAIL}
  `) as { reference: string }[]
  for (const r of refs) {
    await sql`DELETE FROM disco_stripe_payments WHERE order_reference = ${r.reference}::uuid`.catch(() => {})
    await sql`DELETE FROM disco_order_events WHERE order_reference = ${r.reference}::uuid`.catch(() => {})
    await sql`DELETE FROM disco_orders WHERE reference = ${r.reference}::uuid`.catch(() => {})
  }
  return refs.length
}

async function makeOrder(source: 'DISCO' | 'FAMILYMEAL', charged: boolean): Promise<string> {
  const rows = (await sql`
    INSERT INTO disco_orders (
      restaurant_reference, order_number, order_status, order_date, order_time,
      customer_email, customer_first_name, customer_last_name,
      source_of_order, total, is_deleted, restaurant_name, order_type
    ) VALUES (
      (SELECT restaurant_reference FROM disco_menus LIMIT 1),
      -- Above every real order number, and unique per row within a run.
      (SELECT COALESCE(MAX(order_number), 800000000) + 1 FROM disco_orders WHERE order_number >= 800000000), 'DUE',
      '2026-12-01', '12:00:00',
      'verify-emails@example.invalid', 'Ada', 'Okonkwo',
      ${source}, 250.00, false, 'Verify Test Kitchen', 'PICKUP'
    ) RETURNING reference
  `) as { reference: string }[]
  const ref = rows[0].reference
  if (charged) {
    await sql`
      INSERT INTO disco_stripe_payments (order_reference, restaurant_reference, stripe_payment_intent_id, status, total)
      VALUES (${ref}::uuid,
              (SELECT restaurant_reference FROM disco_orders WHERE reference = ${ref}::uuid),
              ${'pi_verify_' + ref.slice(0, 8)}, 'SUCCEEDED', 250.00)
    `
  }
  return ref
}
async function cleanup(refs: string[]) {
  for (const r of refs) {
    await sql`DELETE FROM disco_stripe_payments WHERE order_reference = ${r}::uuid`.catch(() => {})
    await sql`DELETE FROM disco_order_events WHERE order_reference = ${r}::uuid`.catch(() => {})
    await sql`DELETE FROM disco_orders WHERE reference = ${r}::uuid`.catch(() => {})
  }
}

async function main() {
  // The routes all call this before reaching the email helper; the idempotency
  // claim needs the partial unique index it creates.
  await runDiscoOrderMigrations()
  const made: string[] = []
  const purged = await purgeScratch()
  if (purged) console.log(`(cleaned ${purged} scratch order(s) left by an earlier run)\n`)
  try {
    // ── 1. DISCO-sourced, charged: exactly one email, and it does NOT promise a refund
    console.log('=== a DISCO-sourced cancellation, customer already charged ===')
    const discoRef = await makeOrder('DISCO', true); made.push(discoRef)
    sent.length = 0
    const r1 = await sendOrderCancellationEmail(discoRef, 'TEST')
    check('sent', r1.sent === true, JSON.stringify(r1))
    check('exactly one email', sent.length === 1, `${sent.length}`)
    const body = text(sent[0]?.html || '')
    console.log(`      subject: ${sent[0]?.subject}`)
    console.log(`      body:    ${body.trim().slice(0, 260)}`)
    check('says the order was canceled', /has been canceled/i.test(body))
    check('says the restaurant will be in touch about the charge', /will be in touch about the charge/i.test(body))
    check('does NOT promise a refund', !/refund of|has been refunded|refund is on its way|will be refunded/i.test(body),
      'cancel is status-only — the email must never imply money is coming back')
    check('no FamilyMeal branding', !/familymeal/i.test(body) && !/familymeal/i.test(sent[0]?.subject || ''))

    // ── 2. A repeat call sends nothing (idempotency claim)
    console.log('\n=== calling it again (portal double-click, or status then void) ===')
    sent.length = 0
    const r2 = await sendOrderCancellationEmail(discoRef, 'TEST')
    check('second call sends nothing', sent.length === 0 && r2.sent === false, `sent=${sent.length} reason=${r2.reason}`)
    check('reason is the claim, not an error', r2.reason === 'already-sent', String(r2.reason))

    // ── 3. FM-sourced: nothing at all
    console.log('\n=== an FM-sourced cancellation ===')
    const fmRef = await makeOrder('FAMILYMEAL', true); made.push(fmRef)
    sent.length = 0
    const r3 = await sendOrderCancellationEmail(fmRef, 'TEST')
    check('sends NOTHING for an FM-sourced order', sent.length === 0 && r3.sent === false, `sent=${sent.length}`)
    check('reason is the source filter', r3.reason === 'not-disco-source', String(r3.reason))

    // ── 4. Uncharged cancellation says nothing about money at all
    console.log('\n=== a DISCO cancellation with no successful payment ===')
    const freeRef = await makeOrder('DISCO', false); made.push(freeRef)
    sent.length = 0
    await sendOrderCancellationEmail(freeRef, 'TEST')
    const freeBody = text(sent[0]?.html || '')
    check('one email', sent.length === 1, `${sent.length}`)
    check('no money line at all', !/charge|refund/i.test(freeBody), freeBody.slice(0, 140))
  } finally {
    await cleanup(made)
    const left = await purgeScratch()
    if (left) console.log(`(purged ${left} straggler(s))`)
    const remaining = (await sql`
      SELECT count(*)::int AS n FROM disco_orders WHERE customer_email = ${SCRATCH_EMAIL}
    `) as unknown as { n: number }[]
    check('no scratch rows left behind', remaining[0].n === 0, `${remaining[0].n} remain`)
  }

  // ── 5. Refund variants — pure template checks, no rows needed
  console.log('\n=== refund: full vs partial ===')
  sent.length = 0
  await notifications.sendCustomerRefundNotification({
    to: 'x@example.invalid', firstName: 'Ada', orderNumber: 900000123,
    refundAmount: 250, businessName: 'Verify Test Kitchen',
    orderTotal: 250, totalRefunded: 250, isPartial: false,
  })
  const full = sent[0]
  console.log(`   FULL    subject: ${full.subject}`)
  console.log(`           body:    ${text(full.html).trim().slice(0, 200)}`)
  check('full: subject says processed', /Refund processed/i.test(full.subject))
  check('full: says refunded in full', /refunded in full/i.test(text(full.html)))
  check('full: does not mention a partial', !/partial/i.test(text(full.html)))

  sent.length = 0
  await notifications.sendCustomerRefundNotification({
    to: 'x@example.invalid', firstName: 'Ada', orderNumber: 900000123,
    refundAmount: 40, businessName: 'Verify Test Kitchen',
    orderTotal: 250, totalRefunded: 40, isPartial: true, orderProceeding: true,
  })
  const partial = sent[0]
  const pb = text(partial.html)
  console.log(`   PARTIAL subject: ${partial.subject}`)
  console.log(`           body:    ${pb.trim().slice(0, 300)}`)
  check('partial: its own subject', /Partial refund/i.test(partial.subject))
  check('partial: subject differs from full', partial.subject !== full.subject)
  check('partial: states what was refunded', /\$40\.00/.test(pb))
  check('partial: states the order total', /\$250\.00/.test(pb))
  check('partial: states what is still charged', /\$210\.00/.test(pb) && /still charged|leaving/i.test(pb))
  check('partial: says the order is still going ahead', /still going ahead/i.test(pb))

  sent.length = 0
  await notifications.sendCustomerRefundNotification({
    to: 'x@example.invalid', firstName: 'Ada', orderNumber: 900000123,
    refundAmount: 40, businessName: 'Verify Test Kitchen',
    orderTotal: 250, totalRefunded: 40, isPartial: true, orderProceeding: false,
  })
  const dead = text(sent[0].html)
  console.log(`   PARTIAL-ON-CANCELLED: ${dead.trim().slice(0, 220)}`)
  check('partial on a cancelled order does NOT claim it is proceeding', !/still going ahead/i.test(dead))
  check('partial on a cancelled order says it was canceled', /has been canceled/i.test(dead))

  sent.length = 0
  await notifications.sendCustomerRefundNotification({
    to: 'x@example.invalid', firstName: 'Ada', orderNumber: 900000123,
    refundAmount: 40, businessName: 'Verify Test Kitchen', isPartial: true,
  })
  const unknown = text(sent[0].html)
  check('unknown proceeding-state says nothing either way',
    !/still going ahead/i.test(unknown) && !/has been canceled/i.test(unknown))
  check('unknown totals omit the context line rather than guessing', !/order total was/i.test(unknown))

  console.log('\n' + '='.repeat(66))
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
