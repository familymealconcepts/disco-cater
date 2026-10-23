import { test, expect } from '@playwright/test'
import { stubCheckout, openCheckout, json } from './helpers/checkout'

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
 * Writes nothing (helpers/checkout.ts); the place call answers 500 after a delay.
 * Against production before the fix this failed with 2 place requests.
 */
test('a double-clicked Place Order sends one place request, and a failed place frees the button', async ({ page, baseURL }) => {
  let place = 0
  const harness = await stubCheckout(page, baseURL, {
    '/api/order/place': async (route) => {
      place++
      // Long enough that a second submission, if one starts, overlaps this one.
      await new Promise(r => setTimeout(r, 1500))
      return json(route, { error: 'e2e stub: no order placed' }, 500)
    },
  })
  await openCheckout(page)

  // Two clicks in one task: both land before React re-renders.
  await page.getByRole('button', { name: /^Place Order/ }).evaluate((btn: HTMLButtonElement) => { btn.click(); btn.click() })
  await expect(page.getByText('e2e stub: no order placed')).toBeVisible({ timeout: 10000 })
  expect(place, 'place requests from one double-click').toBe(1)

  // The stub refused the order, so the lock must be released: a fresh click places again.
  await page.getByRole('button', { name: /^Place Order/ }).click()
  await expect.poll(() => place, { timeout: 10000 }).toBe(2)

  expect(harness.unexpectedWrites, 'writes the test did not expect').toEqual([])
})
