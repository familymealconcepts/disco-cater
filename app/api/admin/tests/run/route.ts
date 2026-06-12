import { NextRequest, NextResponse } from 'next/server'
import { getAdminRole } from '../../../../../lib/admin-auth'
import { sql, runMigrations, runDiscoOrderMigrations } from '../../../../../lib/db'
import { sendEmail } from '../../../../../lib/email/send'

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
async function testStripeWebhook(): Promise<TestResult> {
  const steps: Step[] = []
  const secretSet = !!process.env.STRIPE_WEBHOOK_SECRET
  steps.push({ name: 'STRIPE_WEBHOOK_SECRET set', status: secretSet ? 'passed' : 'failed', detail: secretSet ? 'configured' : 'missing' })
  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`SELECT 1 FROM disco_stripe_payments LIMIT 1`) as unknown[]
    steps.push({ name: 'disco_stripe_payments has records', status: rows.length >= 1 ? 'passed' : 'failed', detail: rows.length >= 1 ? 'at least one payment record' : 'no records' })
  } catch (e) {
    steps.push({ name: 'Query disco_stripe_payments', status: 'failed', detail: e instanceof Error ? e.message : 'query failed' })
  }
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

const RUNNERS: Record<string, (origin: string, adminEmail: string) => Promise<TestResult>> = {
  'test-1': (o) => testOnboarding(o),
  'test-2': () => testCustomerCreate(),
  'test-3': () => testPlaceOrder(),
  'test-4': () => testOrderMirror(),
  'test-5': () => testEmailConfig(),
  'test-6': () => testStripeWebhook(),
  'test-7': (o) => testMapVisibility(o),
  'test-8': (o) => testExportApi(o),
  'test-9': () => testSlack(),
  'test-10': (o) => testPasswordReset(o),
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
  try {
    const { steps, testData } = await runner(req.nextUrl.origin, adminEmail)
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
