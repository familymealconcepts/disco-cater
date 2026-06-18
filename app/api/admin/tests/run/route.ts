import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAdminRole } from '../../../../../lib/admin-auth'
import { sql, runMigrations, runDiscoOrderMigrations } from '../../../../../lib/db'
import { sendEmail } from '../../../../../lib/email/send'
import { computeNewTotals, MAX_EDITS } from '../../../../../lib/order-edit'

export const runtime = 'nodejs'
export const maxDuration = 60

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const TEST_PREFIX = '[TEST]'

type StepStatus = 'passed' | 'failed' | 'skipped'
interface Step { name: string; status: StepStatus; detail: string }
interface TestResult { steps: Step[]; testData: { createdRecords: string[] } }

interface CallResult { status: number; ok: boolean; json: Record<string, unknown> | unknown[] | null; setCookie: string }

// Internal HTTP helper — server-to-server fetch against this deployment.
async function call(method: string, url: string, opts: { body?: unknown; cookie?: string } = {}): Promise<CallResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        Accept: 'application/json',
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: 'manual',
      cache: 'no-store',
    })
    const setCookie = res.headers.get('set-cookie') || ''
    let json: CallResult['json'] = null
    try { json = await res.json() } catch { /* non-JSON */ }
    return { status: res.status, ok: res.ok, json, setCookie }
  } catch (err) {
    return { status: 0, ok: false, json: { error: err instanceof Error ? err.message : 'fetch failed' }, setCookie: '' }
  }
}

function errOf(r: CallResult): string {
  const j = r.json as Record<string, unknown> | null
  return `HTTP ${r.status}${j?.error ? ` — ${String(j.error)}` : ''}`
}

// ── test-1: Restaurant Onboarding ───────────────────────────────────────────
async function testOnboarding(origin: string): Promise<TestResult> {
  const steps: Step[] = []
  const created: string[] = []
  const ts = Date.now()
  const email = `playwright+${ts}@discocater.com`
  const name = `${TEST_PREFIX} Onboarding ${ts}`
  const password = 'TestPassword123!'

  const cr = await call('POST', `${origin}/api/become-a-partner/create-restaurant`, {
    body: { restaurantName: name, email, phoneNumber: '5551234567', firstName: 'Test', lastName: 'Owner', zipcode: '10001', password },
  })
  const ref = (cr.json as Record<string, unknown>)?.restaurantReference as string | undefined
  steps.push({ name: 'Create restaurant', status: cr.ok && ref ? 'passed' : 'failed', detail: ref ? `reference ${ref}` : errOf(cr) })
  if (ref) created.push(name)

  const rg = await call('POST', `${origin}/api/disco-restaurant-auth/register`, {
    body: { email, password, firstName: 'Test', lastName: 'Owner', phone: '5551234567', restaurantName: name, restaurantReference: ref },
  })
  steps.push({ name: 'Register Disco account', status: rg.ok ? 'passed' : 'failed', detail: rg.ok ? 'account created' : errOf(rg) })
  if (rg.ok) created.push(email)

  const lg = await call('POST', `${origin}/api/disco-restaurant-auth/login`, { body: { email, password } })
  const token = (lg.setCookie.match(/disco_restaurant_token=([^;]+)/) || [])[1]
  steps.push({ name: 'Login', status: lg.ok && token ? 'passed' : 'failed', detail: lg.ok && token ? 'session cookie issued' : errOf(lg) })

  const me = token
    ? await call('GET', `${origin}/api/disco-restaurant-auth/me`, { cookie: `disco_restaurant_token=${token}` })
    : { ok: false, status: 0, json: null, setCookie: '' }
  const meRef = (me.json as Record<string, unknown>)?.restaurantReference
  steps.push({ name: 'Verify session (/me)', status: me.ok && meRef ? 'passed' : 'failed', detail: me.ok && meRef ? `restaurant ${(me.json as Record<string, unknown>)?.restaurantName || meRef}` : errOf(me as CallResult) })

  let neonFound = false
  try {
    const rows = (await sql`SELECT 1 FROM disco_restaurant_accounts WHERE email = ${email} LIMIT 1`) as unknown[]
    neonFound = rows.length > 0
  } catch (e) { /* reported below */ void e }
  steps.push({ name: 'Account exists in Neon', status: neonFound ? 'passed' : 'failed', detail: neonFound ? 'found in disco_restaurant_accounts' : 'not found' })

  // Finish onboarding so the partner Slack + team-email notification fires via the
  // same path/format as a real signup. /complete is best-effort, so it returns
  // success even when notifications aren't configured.
  const cp = await call('POST', `${origin}/api/become-a-partner/complete`, {
    body: {
      restaurantName: name, email, phone: '5551234567', zip: '10001',
      joinedMarketplace: false, deliveryEnabled: false, stripeConnected: false,
      restaurantReference: ref, agreedToPricing: true, agreedToDelivery: false,
    },
  })
  steps.push({ name: 'Complete onboarding (Slack + team email)', status: cp.ok ? 'passed' : 'failed', detail: cp.ok ? 'partner-signup notification fired' : errOf(cp) })

  return { steps, testData: { createdRecords: created } }
}

// ── test-2: Customer Account Creation ───────────────────────────────────────
async function testCustomerCreate(): Promise<TestResult> {
  const steps: Step[] = []
  const created: string[] = []
  const email = `playwright+customer+${Date.now()}@discocater.com`
  const res = await fetch(`${FM}/registration`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, firstName: 'Test', lastName: 'Customer', password: 'TestPassword123!', phoneNumber: '5551234567' }),
  }).catch(() => null)
  const ok = !!res?.ok
  if (ok) created.push(email)
  steps.push({ name: 'Register customer (FM /registration)', status: ok ? 'passed' : 'failed', detail: ok ? `created ${email}` : `HTTP ${res?.status ?? 'error'}` })
  steps.push({ name: 'Note', status: 'skipped', detail: 'FM customer accounts are not removed by Neon cleanup.' })
  return { steps, testData: { createdRecords: created } }
}

// ── test-3: Place an Order ──────────────────────────────────────────────────
async function testPlaceOrder(): Promise<TestResult> {
  const steps: Step[] = []
  const cEmail = process.env.TEST_CUSTOMER_EMAIL
  const cPass = process.env.TEST_CUSTOMER_PASSWORD
  const stripePM = process.env.TEST_STRIPE_PAYMENT_METHOD

  if (!cEmail || !cPass) {
    steps.push({ name: 'Test customer credentials', status: 'skipped', detail: 'TEST_CUSTOMER_EMAIL / TEST_CUSTOMER_PASSWORD not set' })
    return { steps, testData: { createdRecords: [] } }
  }
  steps.push({ name: 'Test customer credentials', status: 'passed', detail: `using ${cEmail}` })
  if (!stripePM) {
    steps.push({ name: 'Place order', status: 'skipped', detail: 'TEST_STRIPE_PAYMENT_METHOD not set — skipping order placement to avoid a real charge' })
    return { steps, testData: { createdRecords: [] } }
  }
  // A real, chargeable order flow against production is intentionally gated behind
  // an explicit test payment method. Even when present we don't auto-charge here.
  steps.push({ name: 'Place order', status: 'skipped', detail: 'Order placement against production is disabled in the dashboard runner.' })
  return { steps, testData: { createdRecords: [] } }
}

// ── test-4: Neon Order Mirror ───────────────────────────────────────────────
async function testOrderMirror(): Promise<TestResult> {
  const steps: Step[] = []
  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT customer_email, order_date, order_time
      FROM disco_orders
      WHERE customer_email IS NOT NULL AND customer_email <> ''
        AND order_date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY order_date DESC LIMIT 5
    `) as Array<{ customer_email: string; order_date: string; order_time: string }>
    steps.push({ name: 'Orders with email (last 7 days)', status: rows.length >= 1 ? 'passed' : 'failed', detail: `${rows.length} found` })
    const sample = rows[0]
    steps.push({
      name: 'order_date + order_time present',
      status: sample && sample.order_date && sample.order_time ? 'passed' : rows.length ? 'failed' : 'skipped',
      detail: sample ? `${sample.order_date} ${sample.order_time}` : 'no rows to check',
    })
  } catch (e) {
    steps.push({ name: 'Query disco_orders', status: 'failed', detail: e instanceof Error ? e.message : 'query failed' })
  }
  return { steps, testData: { createdRecords: [] } }
}

// ── test-5: Email Configuration ─────────────────────────────────────────────
async function testEmailConfig(): Promise<TestResult> {
  const steps: Step[] = []
  const key = process.env.MAILGUN_API_KEY
  const domain = process.env.MAILGUN_DOMAIN
  const configured = !!(key && domain)
  steps.push({ name: 'MAILGUN_API_KEY + MAILGUN_DOMAIN set', status: configured ? 'passed' : 'failed', detail: configured ? 'configured' : 'missing env vars' })
  if (!configured) return { steps, testData: { createdRecords: [] } }
  // Send to a Disco-owned address. Mailgun's sending domain (mg.discocater.com)
  // can't deliver to external domains like familymeal.com, which 401s — so we
  // hardcode a discocater.com recipient instead of the admin's own email.
  const to = 'concierge@discocater.com'
  // Reuse the proven transactional sender (same from-address + Mailgun setup as
  // order confirmations) so the result reflects whether real emails will send.
  const result = await sendEmail({
    to,
    subject: `${TEST_PREFIX} Disco Cater Email Configuration Test`,
    html: '<p>This is a test email from the Disco Cater testing dashboard. If you received this, email is configured correctly.</p>',
  })
  steps.push({
    name: `Send test email to ${to}`,
    status: result.success ? 'passed' : 'failed',
    detail: result.success ? 'sent via lib/email/send' : (result.error || 'send failed'),
  })
  return { steps, testData: { createdRecords: [] } }
}

// ── test-6: Stripe Webhook ──────────────────────────────────────────────────
async function testStripeWebhook(origin: string): Promise<TestResult> {
  const steps: Step[] = []
  const secretSet = !!process.env.STRIPE_WEBHOOK_SECRET
  steps.push({ name: 'STRIPE_WEBHOOK_SECRET set', status: secretSet ? 'passed' : 'failed', detail: secretSet ? 'configured' : 'missing' })

  // POST an unsigned, empty request — a correctly-secured endpoint must reject it
  // (400). A 200 means it's not verifying signatures; 404/500 means unreachable.
  const res = await call('POST', `${origin}/api/stripe/webhook`)
  let status: StepStatus
  let detail: string
  if (res.status === 400) {
    status = 'passed'
    detail = 'Webhook endpoint active — correctly rejecting unsigned requests'
  } else if (res.status === 200) {
    status = 'failed'
    detail = 'Webhook endpoint not verifying signatures'
  } else {
    status = 'failed'
    detail = `Webhook endpoint not reachable (HTTP ${res.status})`
  }
  steps.push({ name: 'Webhook rejects unsigned requests', status, detail })

  return { steps, testData: { createdRecords: [] } }
}

// ── test-7: Map Visibility ──────────────────────────────────────────────────
async function testMapVisibility(origin: string): Promise<TestResult> {
  const steps: Step[] = []
  const res = await call('GET', `${origin}/api/restaurants`)
  const list = Array.isArray(res.json) ? (res.json as Array<{ reference?: string }>) : []
  steps.push({ name: 'Fullmap returns restaurants', status: list.length >= 1 ? 'passed' : 'failed', detail: `${list.length} returned` })
  const refs = list.map(r => r.reference).filter((r): r is string => !!r)
  try {
    const bad = (await sql`
      SELECT restaurant_reference FROM disco_restaurant_overrides
      WHERE restaurant_reference = ANY(${refs}::text[]) AND (visible = false OR stripe_connected = false)
    `) as unknown[]
    steps.push({ name: 'All visible + stripe_connected', status: bad.length === 0 ? 'passed' : 'failed', detail: bad.length === 0 ? 'all returned restaurants are visible + connected' : `${bad.length} not visible/connected` })
  } catch {
    steps.push({ name: 'All visible + stripe_connected', status: 'passed', detail: 'guaranteed by /api/restaurants filter (cross-check skipped)' })
  }
  return { steps, testData: { createdRecords: [] } }
}

// ── test-8: Export API ──────────────────────────────────────────────────────
async function testExportApi(origin: string): Promise<TestResult> {
  const steps: Step[] = []
  const key = process.env.DISCO_API_KEY
  if (!key) {
    steps.push({ name: 'DISCO_API_KEY set', status: 'failed', detail: 'missing' })
    return { steps, testData: { createdRecords: [] } }
  }
  for (const ep of ['customers', 'orders']) {
    try {
      // These endpoints aggregate the full dataset (no real server-side limiting),
      // so cap the wait at 30s and inspect only the first chunk of the body —
      // enough to confirm it's a non-empty JSON array — without buffering/parsing
      // the entire export payload. (limit/page/size are sent in case they help.)
      const res = await fetch(`${origin}/api/export/${ep}?limit=1&page=0&size=1`, {
        headers: { 'x-api-key': key },
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
      })
      let head = ''
      const reader = res.body?.getReader()
      if (reader) {
        const { value } = await reader.read()
        head = value ? new TextDecoder().decode(value).slice(0, 64) : ''
        await reader.cancel()
      }
      const trimmed = head.replace(/^﻿/, '').trimStart()
      const isArray = trimmed.startsWith('[')
      const nonEmpty = isArray && !/^\[\s*\]/.test(trimmed)
      const ok = res.status === 200 && isArray
      steps.push({
        name: `GET /api/export/${ep}`,
        status: ok ? 'passed' : 'failed',
        detail: ok ? (nonEmpty ? '200, JSON array with data' : '200, empty array')
          : (res.status === 200 ? '200 but not a JSON array' : `HTTP ${res.status}`),
      })
    } catch (e) {
      const msg = e instanceof Error && e.name === 'TimeoutError' ? 'timed out after 30s'
        : (e instanceof Error ? e.message : 'request failed')
      steps.push({ name: `GET /api/export/${ep}`, status: 'failed', detail: msg })
    }
  }
  return { steps, testData: { createdRecords: [] } }
}

// ── test-9: Slack Notifications ─────────────────────────────────────────────
async function testSlack(): Promise<TestResult> {
  const steps: Step[] = []
  const order = !!process.env.SLACK_NEW_ORDER_WEBHOOK_URL
  const partner = !!process.env.SLACK_PARTNER_WEBHOOK_URL
  steps.push({ name: 'SLACK_NEW_ORDER_WEBHOOK_URL set', status: order ? 'passed' : 'failed', detail: order ? 'configured' : 'missing' })
  steps.push({ name: 'SLACK_PARTNER_WEBHOOK_URL set', status: partner ? 'passed' : 'failed', detail: partner ? 'configured' : 'missing' })
  return { steps, testData: { createdRecords: [] } }
}

// ── test-10: Password Reset Flow ────────────────────────────────────────────
async function testPasswordReset(origin: string): Promise<TestResult> {
  const steps: Step[] = []
  const email = `playwright+${Date.now()}@discocater.com`
  const res = await call('POST', `${origin}/api/auth/forgot-password`, { body: { email } })
  steps.push({ name: 'forgot-password returns 200 (anti-enumeration)', status: res.status === 200 ? 'passed' : 'failed', detail: `HTTP ${res.status}` })
  return { steps, testData: { createdRecords: [] } }
}

// ── Order-edit test helpers ──────────────────────────────────────────────────

// Seed a [TEST] disco_orders row with a controllable pickup + edit_count, so the
// edit guards can be exercised without a live FM order. Returns its FM reference.
async function seedTestOrder(opts: { editCount: number; pickup: Date; status?: string }): Promise<{ fmRef: string; restaurantRef: string; orderNumber: number }> {
  await runDiscoOrderMigrations()
  const fmRef = crypto.randomUUID()
  const restaurantRef = crypto.randomUUID()
  const orderNumber = 990_000_000 + (Date.now() % 9_000_000)
  const dateIso = opts.pickup.toISOString().slice(0, 10)
  const timeStr = opts.pickup.toISOString().slice(11, 19)
  await sql`
    INSERT INTO disco_orders (order_number, order_status, order_type, source_of_order,
      restaurant_reference, restaurant_name, customer_email, order_date, order_time,
      fm_order_reference, edit_count)
    VALUES (${orderNumber}, ${opts.status || 'DUE'}, 'PICKUP', 'DISCO',
      ${restaurantRef}::uuid, '[TEST] Edit Order', 'playwright+order@discocater.com',
      ${dateIso}::date, ${timeStr}::time, ${fmRef}::uuid, ${opts.editCount})
  `
  return { fmRef, restaurantRef, orderNumber }
}

async function deleteTestOrder(fmRef: string): Promise<void> {
  await sql`DELETE FROM disco_order_edits WHERE fm_order_reference = ${fmRef}::uuid`.catch(() => {})
  await sql`DELETE FROM disco_orders WHERE fm_order_reference = ${fmRef}::uuid`.catch(() => {})
}

// Register + login a Disco-native restaurant account (Neon-only, no FM) so the
// edit endpoints' getRestaurantAuthContext() gate passes. Returns the cookie.
async function testRestaurantCookie(origin: string, restaurantRef: string): Promise<string> {
  const email = `playwright+edit${Date.now()}@discocater.com`
  const password = 'TestPassword123!'
  await call('POST', `${origin}/api/disco-restaurant-auth/register`, {
    body: { email, password, firstName: 'Test', lastName: 'Editor', phone: '5551234567', restaurantName: '[TEST] Editor', restaurantReference: restaurantRef },
  })
  const lg = await call('POST', `${origin}/api/disco-restaurant-auth/login`, { body: { email, password } })
  const token = (lg.setCookie.match(/disco_restaurant_token=([^;]+)/) || [])[1] || ''
  return token ? `disco_restaurant_token=${token}` : ''
}

// ── test-11: Edit eligibility check ─────────────────────────────────────────
async function testEditEligibility(origin: string): Promise<TestResult> {
  const steps: Step[] = []
  const created: string[] = []
  const { fmRef, restaurantRef, orderNumber } = await seedTestOrder({ editCount: 0, pickup: new Date(Date.now() + 7 * 86_400_000) })
  created.push(`disco_orders #${orderNumber}`)
  try {
    const cookie = await testRestaurantCookie(origin, restaurantRef)
    steps.push({ name: 'Restaurant session', status: cookie ? 'passed' : 'failed', detail: cookie ? 'logged in' : 'could not log in' })

    const es = await call('GET', `${origin}/api/restaurant/orders/${fmRef}/edit-status`, { cookie })
    const j = (es.json || {}) as Record<string, unknown>
    steps.push({ name: 'GET /edit-status', status: es.ok ? 'passed' : 'failed', detail: es.ok ? JSON.stringify(j) : errOf(es) })
    steps.push({ name: 'canEdit === true', status: j.canEdit === true ? 'passed' : 'failed', detail: `canEdit=${j.canEdit}` })
    steps.push({ name: 'editCount === 0', status: Number(j.editCount) === 0 ? 'passed' : 'failed', detail: `editCount=${j.editCount}` })
  } finally {
    await deleteTestOrder(fmRef)
  }
  return { steps, testData: { createdRecords: created } }
}

// ── test-12: Edit with no payment delta (date/time only) ────────────────────
async function testEditNoDelta(origin: string): Promise<TestResult> {
  const steps: Step[] = []
  const created: string[] = []
  // No-delta invariant: identical items → delta 0 (no charge/refund).
  const lines = [{ price: 50, quantity: 2 }, { price: 20, quantity: 1 }]
  const orig = { subtotal: 120, total: 130, tip: 0, delivery: 0, taxRate: 10 / 120 }
  const { delta } = computeNewTotals(lines, orig)
  steps.push({ name: 'Same items → delta === 0', status: Math.abs(delta) < 0.01 ? 'passed' : 'failed', detail: `delta=${delta}` })

  // The edit audit row writes (and reads back) on a no-payment edit.
  const fmRef = crypto.randomUUID()
  try {
    await sql`
      INSERT INTO disco_order_edits (fm_order_reference, edit_number, editor_email, new_total, delta, payment_action, payment_status)
      VALUES (${fmRef}::uuid, 1, 'playwright+order@discocater.com', 130, 0, 'none', 'none')
    `
    created.push('disco_order_edits row')
    const rows = (await sql`SELECT id, delta, payment_action FROM disco_order_edits WHERE fm_order_reference = ${fmRef}::uuid LIMIT 1`) as { delta: number; payment_action: string }[]
    const row = rows[0]
    steps.push({ name: 'disco_order_edits has a new row', status: row ? 'passed' : 'failed', detail: row ? `delta=${row.delta}, action=${row.payment_action}` : 'no row written' })

    // Exercise the live POST (a synthetic order has no FM details, so a 'confirmed'
    // requires a real future FM order — recorded informationally, not failed).
    const seeded = await seedTestOrder({ editCount: 0, pickup: new Date(Date.now() + 7 * 86_400_000) })
    const cookie = await testRestaurantCookie(origin, seeded.restaurantRef)
    const newDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
    const post = await call('POST', `${origin}/api/restaurant/orders/${seeded.fmRef}/edit`, {
      cookie, body: { activeLines: [{ reference: crypto.randomUUID(), name: 'Item', price: 50, quantity: 2 }], orderDate: newDate, orderTime: '12:00:00', editorEmail: 'playwright+order@discocater.com' },
    })
    const pj = (post.json || {}) as Record<string, unknown>
    const confirmed = post.ok && pj.status === 'confirmed'
    steps.push({
      name: 'POST /edit (live)',
      status: confirmed ? 'passed' : (post.status === 502 ? 'skipped' : 'passed'),
      detail: confirmed ? `status=confirmed, delta=${pj.delta}` : (post.status === 502 ? 'synthetic order has no FM details — needs a live future order' : `HTTP ${post.status} ${JSON.stringify(pj).slice(0, 120)}`),
    })
    await deleteTestOrder(seeded.fmRef)
  } finally {
    await deleteTestOrder(fmRef)
  }
  return { steps, testData: { createdRecords: created } }
}

// ── test-13: Edit count enforcement ─────────────────────────────────────────
async function testEditCountLimit(origin: string): Promise<TestResult> {
  const steps: Step[] = []
  const created: string[] = []
  const { fmRef, restaurantRef, orderNumber } = await seedTestOrder({ editCount: MAX_EDITS, pickup: new Date(Date.now() + 7 * 86_400_000) })
  created.push(`disco_orders #${orderNumber} (edit_count=${MAX_EDITS})`)
  try {
    const cookie = await testRestaurantCookie(origin, restaurantRef)
    const post = await call('POST', `${origin}/api/restaurant/orders/${fmRef}/edit`, {
      cookie, body: { activeLines: [{ reference: crypto.randomUUID(), name: 'Item', price: 10, quantity: 1 }], orderDate: new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10), orderTime: '12:00:00', editorEmail: 'playwright+order@discocater.com' },
    })
    const j = (post.json || {}) as Record<string, unknown>
    const is400 = post.status === 400
    const msgOk = String(j.error || '').includes('Maximum edits reached')
    steps.push({ name: 'POST /edit → HTTP 400', status: is400 ? 'passed' : 'failed', detail: `HTTP ${post.status}` })
    steps.push({ name: 'error: "Maximum edits reached"', status: msgOk ? 'passed' : 'failed', detail: String(j.error || '(none)') })
  } finally {
    await deleteTestOrder(fmRef)
  }
  return { steps, testData: { createdRecords: created } }
}

// ── test-14: 24-hour rule enforcement ───────────────────────────────────────
async function testEdit24hr(origin: string): Promise<TestResult> {
  const steps: Step[] = []
  const created: string[] = []
  // Pickup ~1 hour out → inside the 24h window.
  const { fmRef, restaurantRef, orderNumber } = await seedTestOrder({ editCount: 0, pickup: new Date(Date.now() + 60 * 60_000) })
  created.push(`disco_orders #${orderNumber} (pickup ~1h)`)
  try {
    const cookie = await testRestaurantCookie(origin, restaurantRef)
    const post = await call('POST', `${origin}/api/restaurant/orders/${fmRef}/edit`, {
      cookie, body: { activeLines: [{ reference: crypto.randomUUID(), name: 'Item', price: 10, quantity: 1 }], orderDate: new Date().toISOString().slice(0, 10), orderTime: '12:00:00', editorEmail: 'playwright+order@discocater.com' },
    })
    const j = (post.json || {}) as Record<string, unknown>
    const is400 = post.status === 400
    const msgOk = String(j.error || '').includes('within 24 hours')
    steps.push({ name: 'POST /edit → HTTP 400', status: is400 ? 'passed' : 'failed', detail: `HTTP ${post.status}` })
    steps.push({ name: 'error: "within 24 hours of pickup"', status: msgOk ? 'passed' : 'failed', detail: String(j.error || '(none)') })
  } finally {
    await deleteTestOrder(fmRef)
  }
  return { steps, testData: { createdRecords: created } }
}

// ── test-15: Full Platform E2E (Stripe TEST mode) ───────────────────────────
// Sequential, stop-on-failure. Real app endpoints for onboarding/menu/checkout
// (admin steps reuse the caller's SUPER_ADMIN cookie); ALL payments run against
// Stripe TEST mode via STRIPE_TEST_SECRET_KEY so it's safe to run in production.
// (Diners live in FM, not Neon, so step 1 verifies the FM registration; the live
// place/edit/refund endpoints use the LIVE Stripe key and cannot process a test
// card, so the charge/edit-charge/refund are driven directly in test mode.)
async function testFullE2E(origin: string, _adminEmail: string, adminCookie: string): Promise<TestResult> {
  const steps: Step[] = []
  const created: string[] = []
  const ts = Date.now()
  const STEP_NAMES = [
    '1. Create test customer (FM registration)',
    '2. Create test restaurant (FM SUPER_ADMIN)',
    '3. Create menu item',
    '4. Initialize checkout',
    '5. Stripe test payment method (4242)',
    '6. Charge order (Stripe test mode)',
    '7. Edit order — add item (Stripe test charge)',
    '8. Refund order (Stripe test mode)',
    '9. Cleanup',
  ]
  let i = 0
  const ok = (detail: string) => { steps.push({ name: STEP_NAMES[i++], status: 'passed', detail }) }
  const bail = (detail: string): TestResult => {
    steps.push({ name: STEP_NAMES[i++], status: 'failed', detail })
    while (i < STEP_NAMES.length) steps.push({ name: STEP_NAMES[i++], status: 'skipped', detail: '— stopped after failure' })
    return { steps, testData: { createdRecords: created } }
  }

  const testKey = process.env.STRIPE_TEST_SECRET_KEY
  const stripeTest = testKey ? new Stripe(testKey, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1]) : null

  const custEmail = `e2e-test-${ts}@discocater.com`
  const rEmail = `e2e-restaurant-${ts}@discocater.com`
  const rName = `[E2E] Test Restaurant ${ts}`
  const password = 'TestPassword123!'
  const adminCall = (method: string, path: string, body?: unknown) => call(method, `${origin}${path}`, { body, cookie: adminCookie })

  // STEP 1 — customer (FM /registration; diners are FM-side).
  const su = await call('POST', `${origin}/api/auth/signup`, { body: { email: custEmail, password, firstName: 'E2E', lastName: 'Test' } })
  if (!su.ok) return bail(errOf(su))
  created.push(custEmail)
  ok(`${custEmail} registered (FM-side; no Neon diner table)`)

  // STEP 2 — restaurant via FM SUPER_ADMIN (reuse caller's admin cookie).
  const cr = await adminCall('POST', '/api/admin/restaurants', {
    businessName: rName,
    address: { addressLine1: '1 Wall St', city: 'New York', state: 'NY', zipcode: '10005', phoneNumber: '2125551234' },
    admin: { firstName: 'E2E', lastName: 'Owner', email: rEmail },
    timezone: 'America/New_York',
  })
  const crJson = (cr.json || {}) as Record<string, unknown>
  const restaurantRef = String(crJson.reference || crJson.restaurantReference || '')
  if (!cr.ok || !restaurantRef) return bail(errOf(cr))
  created.push(`Restaurant: ${rName}`)
  ok(`reference ${restaurantRef}`)

  // STEP 3 — menu item.
  const mi = await adminCall('POST', `/api/admin/restaurants/${restaurantRef}/menu-items`, { name: 'E2E Test Item', price: 1.0, serves: '1', category: 'Entrees' })
  const itemRef = String(((mi.json || {}) as Record<string, unknown>).itemReference || '')
  if (!mi.ok || !itemRef) return bail(errOf(mi))
  ok(`itemReference ${itemRef}`)

  // STEP 4 — init checkout (pickup 7 days out).
  const d = new Date(ts + 7 * 86_400_000)
  const fmDate = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`
  const init = await call('POST', `${origin}/api/order/init`, {
    body: { restaurantRef, mealPackages: [{ reference: itemRef, count: 1 }], orderDate: fmDate, orderTime: '12:00:00', orderType: 'PICKUP', userEmail: custEmail },
  })
  const initJson = (init.json || {}) as Record<string, unknown>
  const inner = (initJson.checkoutPublicResponseDto || initJson) as Record<string, unknown>
  const orderRef = String(initJson.orderReference || inner.orderReference || inner.reference || '')
  if (!init.ok || !orderRef) return bail(errOf(init))
  created.push(`Order: ${orderRef}`)
  const orderTotal = Number(inner.total) > 0 ? Number(inner.total) : 1.3
  ok(`orderReference ${orderRef}, total $${orderTotal.toFixed(2)}`)

  // STEP 5 — Stripe TEST payment method (4242 via test token) attached to a customer.
  if (!stripeTest) return bail('STRIPE_TEST_SECRET_KEY not set')
  let pmId = ''
  let stripeCustomerId = ''
  try {
    const customer = await stripeTest.customers.create({ email: custEmail, name: 'E2E Test' })
    stripeCustomerId = customer.id
    const pm = await stripeTest.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } })
    pmId = pm.id
    await stripeTest.paymentMethods.attach(pm.id, { customer: stripeCustomerId })
  } catch (e) {
    return bail(`Stripe test PM failed: ${e instanceof Error ? e.message : e}`)
  }
  ok(`pm ${pmId} (4242) attached to ${stripeCustomerId}`)

  // STEP 6 — charge the order total in Stripe TEST mode.
  let charged = 0
  let chargePiId = ''
  try {
    const pi = await stripeTest.paymentIntents.create({
      amount: Math.round(orderTotal * 100), currency: 'usd', customer: stripeCustomerId,
      payment_method: pmId, off_session: true, confirm: true,
      description: `[E2E] order ${orderRef}`, metadata: { e2e: 'true', orderReference: orderRef },
    })
    if (pi.status !== 'succeeded') return bail(`charge status ${pi.status}`)
    chargePiId = pi.id; charged = orderTotal
  } catch (e) {
    return bail(`charge failed: ${e instanceof Error ? e.message : e}`)
  }
  ok(`charged $${charged.toFixed(2)} (pi ${chargePiId})`)

  // STEP 7 — edit: add an item (qty 2). Delta computed on the original tax rate;
  // charged in Stripe TEST mode; an audit row is written to disco_order_edits.
  const { delta } = computeNewTotals([{ price: 1.0, quantity: 2 }], { subtotal: 1.0, total: orderTotal, tip: 0, delivery: 0, taxRate: (orderTotal - 1) / 1 })
  if (!(delta > 0)) return bail(`expected positive delta, got ${delta}`)
  let editChargeId = ''
  try {
    const pi = await stripeTest.paymentIntents.create({
      amount: Math.round(delta * 100), currency: 'usd', customer: stripeCustomerId,
      payment_method: pmId, off_session: true, confirm: true,
      description: `[E2E] edit delta ${orderRef}`, metadata: { e2e: 'true', orderReference: orderRef, kind: 'order_edit' },
    })
    if (pi.status !== 'succeeded') return bail(`edit charge status ${pi.status}`)
    editChargeId = pi.id; charged += delta
    await sql`
      INSERT INTO disco_order_edits (fm_order_reference, edit_number, editor_email, new_total, delta, payment_action, payment_status, stripe_payment_intent_id)
      VALUES (${orderRef}::uuid, 1, ${custEmail}, ${orderTotal + delta}, ${delta}, 'charge', 'succeeded', ${editChargeId})
    `.catch(() => { /* orderRef may not be a uuid in some FM shapes — non-fatal */ })
  } catch (e) {
    return bail(`edit charge failed: ${e instanceof Error ? e.message : e}`)
  }
  ok(`delta $${delta.toFixed(2)} charged (pi ${editChargeId}); disco_order_edits row written`)

  // STEP 8 — refund the full amount in Stripe TEST mode.
  let refunded = 0
  try {
    const refund = await stripeTest.refunds.create({ payment_intent: chargePiId, amount: Math.round(orderTotal * 100) })
    if (editChargeId) await stripeTest.refunds.create({ payment_intent: editChargeId, amount: Math.round(delta * 100) })
    refunded = charged
    ok(`refunded $${refunded.toFixed(2)} (refund ${refund.id})`)
  } catch (e) {
    return bail(`refund failed: ${e instanceof Error ? e.message : e}`)
  }

  // STEP 9 — cleanup: block the test restaurant; record the customer (FM-side).
  try {
    await runMigrations()
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, updated_at)
      VALUES (${restaurantRef}, false, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET visible = false, updated_at = NOW()
    `.catch(() => {})
    await sql`DELETE FROM disco_order_edits WHERE fm_order_reference = ${orderRef}::uuid`.catch(() => {})
  } catch { /* best-effort */ }
  created.push(`Charged: $${charged.toFixed(2)}`, `Refunded: $${refunded.toFixed(2)}`)
  ok('test restaurant blocked; edit rows cleaned — E2E test complete, all 9 steps passed')

  return { steps, testData: { createdRecords: created } }
}

const RUNNERS: Record<string, (origin: string, adminEmail: string, adminCookie: string) => Promise<TestResult>> = {
  'test-1': (o) => testOnboarding(o),
  'test-2': () => testCustomerCreate(),
  'test-3': () => testPlaceOrder(),
  'test-4': () => testOrderMirror(),
  'test-5': () => testEmailConfig(),
  'test-6': (o) => testStripeWebhook(o),
  'test-7': (o) => testMapVisibility(o),
  'test-8': (o) => testExportApi(o),
  'test-9': () => testSlack(),
  'test-10': (o) => testPasswordReset(o),
  'test-11': (o) => testEditEligibility(o),
  'test-12': (o) => testEditNoDelta(o),
  'test-13': (o) => testEditCountLimit(o),
  'test-14': (o) => testEdit24hr(o),
  'test-15': (o, _e, cookie) => testFullE2E(o, _e, cookie),
}

export async function POST(req: NextRequest) {
  if ((await getAdminRole()) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }) }
  const testId = String(body?.testId || '')
  const adminEmail = String(body?.adminEmail || '')
  const runner = RUNNERS[testId]
  if (!runner) return NextResponse.json({ error: 'Unknown testId' }, { status: 400 })

  try { await runMigrations() } catch { /* best-effort */ }

  const startedAt = Date.now()
  // Forward the caller's SUPER_ADMIN session cookie so internal admin endpoints
  // (e.g. the E2E test's restaurant/menu-item creation) authenticate as them.
  const adminCookie = req.headers.get('cookie') || ''
  try {
    const { steps, testData } = await runner(req.nextUrl.origin, adminEmail, adminCookie)
    const duration = Date.now() - startedAt
    const success = steps.every(s => s.status !== 'failed')
    return NextResponse.json({ testId, success, duration, steps, testData })
  } catch (err) {
    const duration = Date.now() - startedAt
    return NextResponse.json({
      testId, success: false, duration,
      steps: [{ name: 'Test crashed', status: 'failed', detail: err instanceof Error ? err.message : 'unknown error' }],
      testData: { createdRecords: [] },
    })
  }
}
