import { test, expect, type Page } from '@playwright/test'
import { stubCheckout, openCheckout, json } from './helpers/checkout'

/**
 * checkout_completed IS THE GOOGLE ADS CONVERSION: one per order, with transaction_id, value and
 * currency, and the value is what the diner was CHARGED as the place response states it.
 *
 * Drives a stubbed FM-path order to completion: place answers order 900000999 with a charged total
 * of $199.99 (deliberately not the $205.20 the drawer estimated), confirm-payment answers
 * 'succeeded'. Google's tag script is aborted, so the event is read off window.dataLayer (gtag's
 * queue) and never reaches Analytics. Writes nothing (helpers/checkout.ts).
 */
const ORDER_NUMBER = 900000999

function placeAndConfirm() {
  return {
    '/api/order/place': (route: Parameters<typeof json>[0]) => json(route, {
      success: true,
      data: {
        orderReference: 'e2e-order-ref',
        orderNumber: ORDER_NUMBER,
        paymentDetails: { stripePaymentIntentDto: { paymentIntentId: 'pi_e2e_stub' } },
        checkoutPublicResponseDto: { total: 199.99 },
      },
    }),
    '/api/order/confirm-payment': (route: Parameters<typeof json>[0]) =>
      json(route, { data: { stripePaymentIntentDto: { paymentIntentStatus: 'succeeded' } } }),
  }
}

// gtag() pushes its arguments onto window.dataLayer; with gtag.js blocked, that queue is the
// whole record of what the page tried to send. Exposed binding: it survives the redirect.
async function recordGtagEvents(page: Page) {
  const events: Array<{ name: string; params: Record<string, unknown> }> = []
  await page.exposeBinding('__e2eGtagEvent', (_src, name: string, params: Record<string, unknown>) => { events.push({ name, params }) })
  await page.addInitScript(() => {
    const w = window as unknown as { dataLayer: unknown[]; __e2eGtagEvent: (n: string, p: unknown) => void }
    w.dataLayer = w.dataLayer || []
    const push = w.dataLayer.push.bind(w.dataLayer)
    w.dataLayer.push = (...items: unknown[]) => {
      for (const it of items) {
        const a = it as ArrayLike<unknown>
        if (a && a[0] === 'event') w.__e2eGtagEvent(String(a[1]), JSON.parse(JSON.stringify(a[2] ?? {})))
      }
      return push(...items)
    }
  })
  return events
}

test('checkout_completed fires once with transaction_id, the charged value and USD', async ({ page, baseURL }) => {
  const harness = await stubCheckout(page, baseURL, placeAndConfirm())
  const events = await recordGtagEvents(page)
  await openCheckout(page)

  await page.getByRole('button', { name: /^Place Order/ }).click()
  await expect.poll(() => events.filter(e => e.name === 'checkout_completed').length, { timeout: 15000 }).toBe(1)
  const params = events.find(e => e.name === 'checkout_completed')!.params
  expect(params).toMatchObject({
    transaction_id: String(ORDER_NUMBER),
    order_number: ORDER_NUMBER,
    value: 199.99,
    currency: 'USD',
    value_source: 'charged',
  })
  expect(harness.unexpectedWrites, 'writes the test did not expect').toEqual([])
})

test('an order already counted in this session is not counted again', async ({ page, baseURL }) => {
  await stubCheckout(page, baseURL, placeAndConfirm())
  const events = await recordGtagEvents(page)
  await openCheckout(page, () => { sessionStorage.setItem('disco_checkout_completed_900000999', '1') })

  await page.getByRole('button', { name: /^Place Order/ }).click()
  // The order still completes (the drawer navigates to its confirmation page)...
  await page.waitForURL(/\/order-confirmation\/e2e-order-ref/, { timeout: 15000 })
  // ...but no second conversion is sent for it.
  expect(events.filter(e => e.name === 'checkout_completed')).toEqual([])
})
