/**
 * Sign in to FamilyMeal in a real browser as a restaurant admin, using the
 * master password — and leave the SAME audit record an API read leaves.
 *
 * WHY THE AUDIT MATTERS. FM_MASTER_PASSWORD stands in for any enabled restaurant
 * admin's real password. lib/fm-master-admin-read.ts writes a
 * FM_MASTER_PASSWORD_READ row for every use, and that table is the only answer to
 * "who used the master password, on whose account, and when". A browser login
 * that skipped it would be an unrecorded use of someone else's credentials. So
 * this module writes the row FIRST — before the login is attempted — and writes
 * a second row recording the outcome. A failed login is still a use.
 *
 * Exported for scripts/compare-fm-disco.mjs; not used by anything in the app.
 *
 *   import { fmSignIn } from './fm-browser-session.mjs'
 *   const page = await fmSignIn(context, { email, restaurantReference, reason })
 */
import 'dotenv/config'

const FM_WEB = process.env.FM_WEB_BASE_URL || 'https://www.familymeal.com'

/** Written through the same helper the API path uses, so both land identically. */
async function audit(args) {
  // tsx is not in play here (this is plain .mjs run by node), so the TS helper is
  // reached through a child tsx process rather than imported directly.
  const { spawnSync } = await import('node:child_process')
  const payload = JSON.stringify(args)
  const r = spawnSync('npx', ['tsx', '-e', `
    require('dotenv').config({ path: '.env.local' })
    const { auditMasterPasswordUse } = require('./lib/fm-master-admin-read')
    auditMasterPasswordUse(${payload}).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
  `], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`audit write failed, refusing to sign in: ${r.stderr || r.stdout}`)
}

/**
 * @param context a Playwright BrowserContext
 * @param opts.email               the restaurant admin to sign in AS
 * @param opts.restaurantReference the restaurant being inspected (for the audit)
 * @param opts.reason              why — recorded verbatim in the audit row
 * @returns a signed-in Page, or throws
 */
export async function fmSignIn(context, opts) {
  const password = process.env.FM_MASTER_PASSWORD
  if (!password) throw new Error('FM_MASTER_PASSWORD is not set — cannot sign in')
  if (!opts?.email) throw new Error('an admin email is required')

  // BEFORE the attempt, never after. A login that fails, hangs, or is
  // interrupted is still a use of someone's credentials.
  await audit({
    adminEmail: opts.email,
    restaurantReference: opts.restaurantReference ?? null,
    via: 'browser',
    ok: false,
    reason: `attempting: ${opts.reason || 'unspecified'}`,
    extra: { script: 'fm-browser-session.mjs' },
  })

  const page = await context.newPage()
  // FM has no /login route — it 404s to /page/not-found. Sign-in is a modal.
  await page.goto(`${FM_WEB}/?action=signIn`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.locator('input[placeholder="Email"]').first().fill(opts.email)
  await page.locator('input[placeholder="Password"]').first().fill(password)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(6000)

  const signedIn = await page.evaluate(() =>
    !/Log In|Sign Up/i.test(document.body.innerText.slice(0, 400)))

  await audit({
    adminEmail: opts.email,
    restaurantReference: opts.restaurantReference ?? null,
    via: 'browser',
    ok: signedIn,
    reason: `${signedIn ? 'signed in' : 'sign-in failed'}: ${opts.reason || 'unspecified'}`,
    extra: { script: 'fm-browser-session.mjs', finalUrl: page.url() },
  })

  if (!signedIn) throw new Error('FM sign-in did not take — the page still shows Log In')
  return page
}
