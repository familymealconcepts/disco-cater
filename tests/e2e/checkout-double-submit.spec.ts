import { test, expect, type Page } from '@playwright/test'

/**
 * A DOUBLE-CLICKED PLACE ORDER MUST PLACE ONE ORDER.
 *
 * The bug this guards: Place Order stayed clickable until React re-rendered the
 * 'placing' step, so a second click landing before that re-render started a
 * second submission. In production (23 Oct 2026) 6 order pairs since June were
 * placed 0-2 seconds apart with the same customer, restaurant and total, and in
 * one the diner was charged twice.
 *
 * The two clicks are dispatched in ONE task, before React can re-render. That is
 * the exact window a real double-click hits on the card path, where the drawer
 * stays on the payment step through two Stripe round trips; it makes the race
 * deterministic instead of timing-dependent.
 *
 * WRITES NOTHING ANYWHERE. Every non-GET /api call is stubbed (the place call
 * answers 500 after a delay, so no order exists even in the stub), analytics and
 * Clarity are aborted, and the session is a stubbed /api/fm-user. Safe against
 * production, which is how the control below is run:
 *
 *   BASE_URL=<preview of this branch> npx playwright test checkout-double-submit   -> passes
 *   BASE_URL=https://www.discocater.com npx playwright test checkout-double-submit -> fails on
 *     main before this fix (2 place calls), proving the test can see the bug.
 */
const SLUG = process.env.E2E_SLUG || 'altacalidad'
const ITEM = process.env.E2E_ITEM || 'Carne Asada'

type Counts = { place: number; unexpectedWrites: string[] }

async function stubEverything(page: Page, counts: Counts, baseURL: string | undefined) {
  // A protected Vercel preview: send the local development OIDC token, and ONLY to the preview's own
  // origin (never to Stripe, Google or any other third party). Run as
  // `vercel env run -- npx playwright test ...` from a linked checkout; absent, nothing is added.
  const oidc = process.env.VERCEL_OIDC_TOKEN
  if (oidc && baseURL && new URL(baseURL).hostname.endsWith('.vercel.app')) {
    const origin = new URL(baseURL).origin
    await page.route(u => u.origin === origin, route =>
      route.continue({ headers: { ...route.request().headers(), 'x-vercel-trusted-oidc-idp-token': oidc } }))
  }
  await page.route(/google-analytics\.com|googletagmanager\.com\/.*collect|clarity\.ms|doubleclick/, r => r.abort())
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/api/fm-user') return json({ reference: 'e2e-user', email: 'e2e@example.com', firstName: 'E2E', lastName: 'Test', phoneNumber: '5555550100', role: 'CUSTOMER' })
    if (p === '/api/order/saved-card-disco') return json({ brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, stripePaymentMethodId: 'pm_e2e_stub' })
    if (p === '/api/order/init') return json({ success: true, data: { orderReference: 'e2e-order-ref', checkoutPublicResponseDto: { subtotal: 190, total: 205.2, taxes: 15.2 } } })
    if (p === '/api/order/place') {
      counts.place++
      // Long enough that a second submission, if one starts, overlaps this one.
      await new Promise(r => setTimeout(r, 1500))
      return json({ error: 'e2e stub: no order placed' }, 500)
    }
    if (req.method() === 'GET') return route.fallback()
    // Any other write is answered locally; record the ones the flow is not known to make.
    if (!/^\/api\/(auth\/refresh|checkout-funnel\/track|checkout-contact|v1\/intent_pixel\/track_request|order\/update)$/.test(p)) {
      counts.unexpectedWrites.push(`${req.method()} ${p}`)
    }
    return json({})
  })
}

async function openCheckout(page: Page) {
  await page.addInitScript(([slug, item]) => {
    sessionStorage.setItem('disco_reorder', JSON.stringify({ restaurantSlug: slug, items: [{ name: item, count: 1 }] }))
  }, [SLUG, ITEM])
  await page.goto(`/restaurants/${SLUG}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Start Order' }).click()
  await page.getByRole('button', { name: 'Continue to Checkout' }).click()
  await expect(page.getByRole('button', { name: /^Place Order/ })).toBeVisible({ timeout: 20000 })
  // The saved-card path, so no card is ever tokenized with Stripe.
  await expect(page.getByText('4242').first()).toBeVisible({ timeout: 10000 })
}

test('a double-clicked Place Order sends one place request, and a failed place frees the button', async ({ page, baseURL }) => {
  const counts: Counts = { place: 0, unexpectedWrites: [] }
  await stubEverything(page, counts, baseURL)
  await openCheckout(page)

  // Two clicks in one task: both land before React re-renders.
  await page.getByRole('button', { name: /^Place Order/ }).evaluate((btn: HTMLButtonElement) => { btn.click(); btn.click() })
  await expect(page.getByText('e2e stub: no order placed')).toBeVisible({ timeout: 10000 })
  expect(counts.place, 'place requests from one double-click').toBe(1)

  // The stub refused the order, so the lock must be released: a fresh click places again.
  await page.getByRole('button', { name: /^Place Order/ }).click()
  await expect.poll(() => counts.place, { timeout: 10000 }).toBe(2)

  expect(counts.unexpectedWrites, 'writes the test did not expect').toEqual([])
})
