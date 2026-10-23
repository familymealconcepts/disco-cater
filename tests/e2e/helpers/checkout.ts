import { expect, type Page, type Route } from '@playwright/test'

/**
 * Shared harness for checkout specs: reaches the Review & Pay step of a real restaurant page with a
 * stubbed diner session, a stubbed cart, a stubbed order draft and a stubbed saved card.
 *
 * WRITES NOTHING ANYWHERE. Every non-GET /api call is answered here (the spec supplies the place
 * and confirm answers), Google's tag script and Clarity are aborted, so no analytics event leaves
 * the browser either. Safe against production.
 */
export const SLUG = process.env.E2E_SLUG || 'altacalidad'
export const ITEM = process.env.E2E_ITEM || 'Carne Asada'

export type WriteHandler = (route: Route, path: string) => Promise<void> | void
export type Harness = { unexpectedWrites: string[] }

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

export async function stubCheckout(page: Page, baseURL: string | undefined, writes: Record<string, WriteHandler>): Promise<Harness> {
  const harness: Harness = { unexpectedWrites: [] }
  // A protected Vercel preview: send the local development OIDC token, ONLY to the preview's own
  // origin. Run as `vercel env run -- npx playwright test ...` from a linked checkout.
  const oidc = process.env.VERCEL_OIDC_TOKEN
  if (oidc && baseURL && new URL(baseURL).hostname.endsWith('.vercel.app')) {
    const origin = new URL(baseURL).origin
    await page.route(u => u.origin === origin, route =>
      route.continue({ headers: { ...route.request().headers(), 'x-vercel-trusted-oidc-idp-token': oidc } }))
  }
  await page.route(/googletagmanager\.com|google-analytics\.com|clarity\.ms|doubleclick/, r => r.abort())
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    if (p === '/api/fm-user') return json(route, { reference: 'e2e-user', email: 'e2e@example.com', firstName: 'E2E', lastName: 'Test', phoneNumber: '5555550100', role: 'CUSTOMER' })
    if (p === '/api/order/saved-card-disco') return json(route, { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, stripePaymentMethodId: 'pm_e2e_stub' })
    if (p === '/api/order/init') return json(route, { success: true, data: { orderReference: 'e2e-order-ref', checkoutPublicResponseDto: { subtotal: 190, total: 205.2, taxes: 15.2 } } })
    if (writes[p]) return writes[p](route, p)
    if (req.method() === 'GET') return route.fallback()
    if (!/^\/api\/(auth\/refresh|checkout-funnel\/track|checkout-contact|v1\/intent_pixel\/track_request|order\/update|fm-user-addresses)$/.test(p)) {
      harness.unexpectedWrites.push(`${req.method()} ${p}`)
    }
    return json(route, {})
  })
  return harness
}

export async function openCheckout(page: Page, initScript?: () => void) {
  await page.addInitScript(([slug, item]) => {
    sessionStorage.setItem('disco_reorder', JSON.stringify({ restaurantSlug: slug, items: [{ name: item, count: 1 }] }))
  }, [SLUG, ITEM])
  if (initScript) await page.addInitScript(initScript)
  await page.goto(`/restaurants/${SLUG}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Start Order' }).click()
  await page.getByRole('button', { name: 'Continue to Checkout' }).click()
  await expect(page.getByRole('button', { name: /^Place Order/ })).toBeVisible({ timeout: 20000 })
  // The saved-card path, so no card is ever tokenized with Stripe.
  await expect(page.getByText('4242').first()).toBeVisible({ timeout: 10000 })
}

export { json }
