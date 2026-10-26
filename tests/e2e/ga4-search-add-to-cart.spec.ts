import { test, expect } from '@playwright/test'
import { recordGtagEvents } from './helpers/gtag'
import { SLUG, ITEM, stubCheckout, openCheckout } from './helpers/checkout'

/**
 * search_performed (homepage) and add_to_cart (restaurant page), read off window.dataLayer.
 *
 * READ-ONLY: Google's tag script and Clarity are aborted so nothing reaches Analytics; every
 * non-GET /api call is answered with {} and nothing is placed, saved or signed in. The cart is
 * client state. The Enter-on-a-suggestion path needs Google's live Places dropdown and is checked on
 * the preview by hand, not here.
 */
test.beforeEach(async ({ page }) => {
  await page.route(/googletagmanager\.com|google-analytics\.com|clarity\.ms|doubleclick/, r => r.abort())
  await page.route('**/api/**', r => r.request().method() === 'GET'
    ? r.fallback()
    : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
})

test('homepage: a typed cuisine word fires one search_performed, with no search text', async ({ page }) => {
  const events = await recordGtagEvents(page)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const input = page.getByRole('textbox').first()
  await input.fill('Pizza')
  await input.press('Enter')
  await expect.poll(() => events.filter(e => e.name === 'search_performed').length, { timeout: 15000 }).toBe(1)
  const params = events.find(e => e.name === 'search_performed')!.params
  expect(params).toEqual({ surface: 'homepage', search_type: 'cuisine', selection: 'typed' })
})

test('restaurant: adding an item fires one add_to_cart with value and USD', async ({ page }) => {
  const events = await recordGtagEvents(page)
  await page.goto(`/restaurants/${SLUG}`, { waitUntil: 'networkidle' })
  await page.getByText(ITEM, { exact: false }).first().click()
  await page.getByRole('button', { name: /^Add to Order/ }).click()
  await expect.poll(() => events.filter(e => e.name === 'add_to_cart').length, { timeout: 15000 }).toBe(1)
  const params = events.find(e => e.name === 'add_to_cart')!.params
  expect(params).toMatchObject({ restaurant_slug: SLUG, currency: 'USD', quantity: expect.any(Number), value: expect.any(Number) })
  expect(String(params.item_name)).toContain(ITEM)
  expect(Object.keys(params).sort()).toEqual(['currency', 'item_id', 'item_name', 'quantity', 'restaurant_name', 'restaurant_slug', 'source', 'value'])
})

test('restaurant: Direct Entry fires no add_to_cart', async ({ page }) => {
  const events = await recordGtagEvents(page)
  await page.goto(`/restaurants/${SLUG}?mode=direct-entry`, { waitUntil: 'networkidle' })
  await page.getByText(ITEM, { exact: false }).first().click()
  await page.getByRole('button', { name: /^Add to Order/ }).click()
  await expect(page.getByRole('button', { name: /^Add to Order/ })).toBeHidden({ timeout: 10000 })
  expect(events.filter(e => e.name === 'add_to_cart')).toEqual([])
})

test('restaurant: a reorder rebuild puts the item in the cart and fires no add_to_cart', async ({ page, baseURL }) => {
  await stubCheckout(page, baseURL, {})
  const events = await recordGtagEvents(page)
  await openCheckout(page)
  expect(events.filter(e => e.name === 'add_to_cart')).toEqual([])
})
