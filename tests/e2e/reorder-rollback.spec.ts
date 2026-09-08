import { test, expect, type Page } from '@playwright/test'

/**
 * A FAILED REORDER MUST ROLL THE UI BACK.
 *
 * The bug this guards: the previous reorder code applied optimistically and
 * never rolled back, so a save that 500'd left the screen showing an order the
 * database did not have — the editor lying about the menu.
 *
 * Runs against the modifiers table because it is the simplest of the four
 * (flat list, one fixture endpoint). All of them share SortableRows, so the
 * roll-back path is the same code.
 */
const MODS = [
  { reference: '11111111-1111-4111-8111-111111111111', name: 'Alpha', price: 1, archived: false },
  { reference: '22222222-2222-4222-8222-222222222222', name: 'Bravo', price: 2, archived: false },
  { reference: '33333333-3333-4333-8333-333333333333', name: 'Charlie', price: 3, archived: false },
]

async function signIn(page: Page) {
  await page.context().addCookies([
    { name: 'disco_restaurant_token', value: 'e2e-stub', url: 'http://localhost:3000' },
  ])
  await page.context().addInitScript(() => {
    localStorage.setItem('restaurant_user', JSON.stringify({ email: 'e2e@example.com', role: 'ADMIN', restaurantName: 'E2E' }))
  })
  await page.route('**/api/disco-restaurant-auth/me', r => r.fulfill({ status: 401, body: '{}' }))
}

async function stubList(page: Page) {
  await page.route('**/api/restaurant/disco-modifiers*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ modifiers: MODS, restaurant_reference: '44444444-4444-4444-8444-444444444444' }) })
  })
  await page.route('**/api/restaurant/disco-modifier-groups*', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ groups: [] }) }))
}

async function rowNames(page: Page) {
  return page.locator('table tbody tr td:nth-child(2)').allInnerTexts()
}

/** Drag row `from` onto row `to` using real pointer events — @dnd-kit's
 *  PointerSensor needs a 6px move before it activates, so a single mouse.move
 *  to the target is not enough. */
async function dragRow(page: Page, fromIndex: number, toIndex: number) {
  const handles = page.locator('table tbody tr td:first-child')
  const from = await handles.nth(fromIndex).boundingBox()
  const to = await handles.nth(toIndex).boundingBox()
  if (!from || !to) throw new Error('row not found')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 5 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 })
  await page.mouse.up()
}

test('a failed reorder rolls the row order back', async ({ page }) => {
  await signIn(page)
  await stubList(page)
  let attempted = 0
  await page.route('**/api/restaurant/disco-modifiers/reorder', async (route) => {
    attempted++
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) })
  })

  await page.goto('/restaurant/menu-manager/modifiers')
  await expect(page.locator('table tbody tr').first()).toBeVisible()
  const before = await rowNames(page)
  expect(before).toEqual(['Alpha', 'Bravo', 'Charlie'])

  await dragRow(page, 2, 0)
  await expect.poll(() => attempted).toBeGreaterThan(0)
  // The order must return to what the server still holds.
  await expect.poll(() => rowNames(page)).toEqual(before)
})

test('a successful reorder keeps the new order', async ({ page }) => {
  await signIn(page)
  await stubList(page)
  let sent: string[] = []
  await page.route('**/api/restaurant/disco-modifiers/reorder', async (route) => {
    sent = JSON.parse(route.request().postData() || '{}').references ?? []
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })

  await page.goto('/restaurant/menu-manager/modifiers')
  await expect(page.locator('table tbody tr').first()).toBeVisible()
  await dragRow(page, 2, 0)
  await expect.poll(() => sent.length).toBe(3)
  // Charlie moved to the front, and the payload is the FULL ordered list.
  expect(sent[0]).toBe(MODS[2].reference)
  await expect.poll(() => rowNames(page)).toEqual(['Charlie', 'Alpha', 'Bravo'])
})
