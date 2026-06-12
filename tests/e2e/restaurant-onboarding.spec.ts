import { test, expect } from '@playwright/test'

const TEST_EMAIL = `test+onboarding+${Date.now()}@discocater.com`
const TEST_PASSWORD = 'TestPassword123!'
const TEST_RESTAURANT = `Test Restaurant ${Date.now()}`

test.describe('Restaurant Onboarding', () => {
  test('completes full onboarding flow without Stripe', async ({ page }) => {
    // Step 1 — Your Info
    await page.goto('https://www.discocater.com/become-a-partner')
    await expect(page.getByText("Let's get you set up")).toBeVisible()

    await page.getByLabel('First name').fill('Test')
    await page.getByLabel('Last name').fill('Owner')
    await page.getByLabel('Email').fill(TEST_EMAIL)
    await page.getByLabel('Phone').fill('5551234567')
    await page.getByLabel('Zip code').fill('10001')
    await page.getByLabel('Restaurant name').fill(TEST_RESTAURANT)
    await page.getByLabel('Create a password').fill(TEST_PASSWORD)
    await page.getByRole('button', { name: 'Continue' }).click()

    // Step 2 — First-Party Pricing
    await expect(page.getByText('First-Party Ordering')).toBeVisible()
    await page.getByLabel(/I agree to the Disco Cater Terms/).check()
    await page.getByRole('button', { name: 'Continue' }).click()

    // Step 3 — Marketplace (Skip)
    await expect(page.getByText('Marketplace')).toBeVisible()
    await page.getByRole('button', { name: 'Skip for now' }).click()

    // Step 4 — Third-Party Delivery (Skip)
    await expect(page.getByText('Third-Party Delivery')).toBeVisible()
    await page.getByRole('button', { name: 'Skip for now' }).click()

    // Step 5 — Stripe Connect (Skip)
    await expect(page.getByText('Connect your bank')).toBeVisible()
    await page.getByRole('button', { name: 'Skip for now' }).click()

    // Step 6 — Menu Upload (Skip)
    await expect(page.getByText('Upload')).toBeVisible()
    await page.getByRole('button', { name: 'Skip for now' }).click()

    // Success screen
    await expect(page.getByText("You're all set")).toBeVisible()
    await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible()

    // Navigate to dashboard
    await page.getByRole('button', { name: 'Get started' }).click()

    // Should land on dashboard — not login page, not Test Kitchen
    await expect(page).toHaveURL(/\/restaurant\/dashboard/)
    await expect(page.getByText(TEST_RESTAURANT)).toBeVisible()

    // Verify not showing wrong restaurant
    await expect(page.getByText('Test Kitchen')).not.toBeVisible()
  })

  test('can log in after onboarding with chosen password', async ({ page }) => {
    // This test depends on the onboarding test having run first
    // In CI, run these in sequence or use a fixed test email
    await page.goto('https://www.discocater.com/restaurant/login')
    await page.getByLabel('Email').fill(TEST_EMAIL)
    await page.getByLabel('Password').fill(TEST_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/restaurant\/dashboard/)
    await expect(page.getByText(TEST_RESTAURANT)).toBeVisible()
  })
})
