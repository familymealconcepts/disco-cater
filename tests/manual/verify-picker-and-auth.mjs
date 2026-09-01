// Browser verification for two changes:
//   1. No delivery fee renders in the date/time picker modal (either delivery
//      type), while ✓ validation and the out-of-radius refusal still work, and
//      the fee STILL renders in the Order Summary once a real cart exists.
//   2. The checkout auth gate opens on Sign Up; the header Log In still opens Log In.
//
// Test targets are chosen deliberately:
//   • hugosweho     OWN_DELIVERY, feeFixed 25 + 10%, $0 minimum — a REAL non-zero
//                   fee, so the summary check proves a paid case, and checkout is
//                   reachable. (Bird & Co. was a bad target: feeFixed 0, so its
//                   summary legitimately says "Free", and its $250 delivery
//                   minimum blocks checkout entirely.)
//   • dechecos-fairlawn  THIRD_PARTY, $0 minimum — the reported case.
//
// validate-address is STUBBED WITH A NON-ZERO FEE on purpose: a menu whose fee
// happens to be 0 would prove nothing. This proves that even when the API returns
// $25, nothing renders it in the picker.
//
// Assertions on the picker are MODAL-SCOPED. A whole-page scan gives false
// failures — item prices behind the overlay match a bare /25.00/.
import { chromium } from '@playwright/test'

const BASE = 'http://localhost:3000'
const OUT = '/private/tmp/claude-501/-Users-peterventi-Desktop-VS-Code/76bbaa67-ff60-4fba-92b4-a107221c33ae/scratchpad'
const ADDR = { addresses: [{ id: 1, is_default: true, address_line1: '8455 Beverly Blvd', address_line2: '', city: 'Los Angeles', state: 'CA', zipcode: '90048', latitude: 34.0759, longitude: -118.3745, delivery_instructions: '' }] }

let fails = 0
const check = (l, ok, extra = '') => { if (!ok) fails++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ` — ${extra}` : ''}`) }

const MODAL_TEXT = () => {
  const inp = document.querySelector('input[placeholder="Enter delivery address..."]')
  if (!inp) return '(no address input — picker closed)'
  let el = inp
  for (let i = 0; i < 12 && el.parentElement; i++) { el = el.parentElement; if (getComputedStyle(el).position === 'fixed') break }
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const out = []; let n
  while ((n = w.nextNode())) { const s = (n.nodeValue || '').trim(); if (s) out.push(s) }
  return out.join(' | ')
}
const PAGE_TEXT = () => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const out = []; let n
  while ((n = w.nextNode())) {
    const p = n.parentElement; if (!p || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(p.tagName)) continue
    const s = (n.nodeValue || '').trim(); if (s) out.push(s)
  }
  return out.join(' | ')
}

async function stub(page, { valid = true, fee = 25 } = {}) {
  await page.route('**/api/customer-addresses**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ADDR) }))
  await page.route('**/api/order/validate-address**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(valid
      ? { valid: true, deliveryFee: fee, thirdPartyDeliverySubsiding: 0, method: 'OWN_DELIVERY', distanceMiles: 2.1, latitude: 34.07, longitude: -118.37 }
      : { valid: false, deliveryFee: 0, message: 'That address is outside this restaurant’s delivery area.' }),
  }))
}
async function toDelivery(page, slug) {
  await page.goto(`${BASE}/restaurants/${slug}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  await page.locator('button', { hasText: /^Delivery$/ }).first().click().catch(() => {})
  await page.waitForTimeout(3000)
}

async function main() {
  const browser = await chromium.launch()

  for (const [label, slug] of [['OWN_DELIVERY  Hugo\'s WeHo', 'hugosweho'], ['THIRD_PARTY   DeCheco\'s Fairlawn', 'dechecos-fairlawn']]) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    const page = await ctx.newPage()
    console.log(`\n═══ picker modal — ${label}`)
    await stub(page, { valid: true, fee: 25 })
    await toDelivery(page, slug)
    const m = await page.evaluate(MODAL_TEXT)
    check('no "Delivery fee" in the picker', !/Delivery fee/i.test(m), /Delivery fee/i.test(m) ? m.match(/.{0,45}Delivery fee.{0,25}/i)?.[0] : '')
    check('no "calculated at checkout" placeholder either', !/calculated at checkout/i.test(m))
    check('the stubbed $25 is not rendered in the modal', !m.includes('25.00'))
    check('address still validated (✓)', m.includes('✓'), m.slice(0, 95))
    await page.screenshot({ path: `${OUT}/picker-${slug}.png` })
    await ctx.close()
  }

  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    const page = await ctx.newPage()
    console.log('\n═══ out-of-radius refusal still works')
    await stub(page, { valid: false })
    await toDelivery(page, 'hugosweho')
    const m = await page.evaluate(MODAL_TEXT)
    check('refusal shown inside the modal', /Delivery not available at this address/i.test(m), m.slice(0, 110))
    check('no fee on the refusal path', !/Delivery fee/i.test(m))
    check('still gated (no ✓)', !m.includes('✓'))
    await page.screenshot({ path: `${OUT}/picker-outofradius.png` })
    await ctx.close()
  }

  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    const page = await ctx.newPage()
    console.log('\n═══ real cart → summary fee, then checkout opens SIGN UP')
    await stub(page, { valid: true, fee: 25 })
    await toDelivery(page, 'hugosweho')
    await page.locator('button', { hasText: /^Start Order$/ }).first().click().catch(() => {})
    await page.waitForTimeout(3000)
    check('picker closed (Start Order accepted)', (await page.locator('input[placeholder="Enter delivery address..."]').count()) === 0)

    // Beverages deliberately: its items have only OPTIONAL add-on groups, so Add
    // is enabled immediately. The tray items carry a REQUIRED modifier group and
    // their Add button stays disabled until one is chosen — a real product rule
    // (see the three FM minimum concepts), not a bug, but it makes them a poor
    // fixture for this test.
    await page.locator('button', { hasText: /^Beverages$/ }).first().click().catch(() => {})
    await page.waitForTimeout(2000)
    const card = page.locator('div').filter({ hasText: /Serves/ }).last()
    await card.scrollIntoViewIfNeeded().catch(() => {})
    await card.click().catch(() => {})
    await page.waitForTimeout(2500)
    const add = page.locator('button', { hasText: /^Add to Order/ }).first()
    check('item config modal opened with an enabled Add button', (await add.count()) > 0 && await add.isEnabled().catch(() => false))
    if (await add.count()) { await add.click().catch(() => {}); await page.waitForTimeout(5000) }

    const t = await page.evaluate(PAGE_TEXT)
    check('cart has a real item (Subtotal present)', /Subtotal/i.test(t), t.slice(0, 100))
    const feeRow = t.match(/Delivery fee \| ([^|]+)/i)
    check('Order Summary STILL shows a Delivery fee row', /Delivery fee/i.test(t), feeRow ? `renders as "${feeRow[1].trim()}"` : 'no row found')
    check('  ...and it is a real non-zero amount, not Free', !!feeRow && /\d/.test(feeRow[1]) && !/free/i.test(feeRow[1]), feeRow ? feeRow[1].trim() : '')
    await page.screenshot({ path: `${OUT}/summary-fee.png` })

    const co = page.locator('button', { hasText: /^Continue to Checkout/i }).first()
    if (await co.count()) {
      await co.click().catch(() => {}); await page.waitForTimeout(2000)
      const a = await page.evaluate(PAGE_TEXT)
      // The Sign Up view is the only one with First Name; Log In is the only one
      // with "Welcome back" / "Forgot password".
      check('checkout auth modal opens on SIGN UP', /First Name/i.test(a) && !/Welcome back/i.test(a),
        a.match(/.{0,45}(First Name|Welcome back).{0,35}/i)?.[0] || a.slice(0, 130))
      await page.screenshot({ path: `${OUT}/auth-checkout-signup.png` })

      // Scope to the modal. A bare button:has-text("Log In") matches the HEADER
      // button first (it comes earlier in the DOM), which reopens the modal
      // instead of switching its tab — that produced a false failure.
      await page.locator('div[style*="fixed"] button', { hasText: /^Log In$/i }).first().click().catch(() => {})
      await page.waitForTimeout(1000)
      const bTxt = await page.evaluate(PAGE_TEXT)
      check('switch → Log In works', /Welcome back|Forgot password/i.test(bTxt) && !/First Name/i.test(bTxt))
      await page.locator('div[style*="fixed"] button', { hasText: /^Sign Up$/i }).first().click().catch(() => {})
      await page.waitForTimeout(1000)
      check('switch → back to Sign Up works', /First Name/i.test(await page.evaluate(PAGE_TEXT)))

      await page.locator('button', { hasText: /^×$/ }).first().click().catch(() => {})
      await page.waitForTimeout(1500)
      const after = await page.evaluate(PAGE_TEXT)
      check('cart intact after the auth modal closes', /Subtotal/i.test(after) && /Delivery fee/i.test(after))
      await page.screenshot({ path: `${OUT}/cart-after-auth.png` })
    } else {
      check('a Checkout button was reachable', false, 'not found — cart may be under a minimum')
    }
    await ctx.close()
  }

  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    const page = await ctx.newPage()
    console.log('\n═══ header Log In must STILL open Log In')
    await page.goto(`${BASE}/restaurants/hugosweho`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4000)
    await page.locator('button', { hasText: /^×$/ }).first().click().catch(() => {})
    await page.waitForTimeout(800)
    const hdr = page.locator('button', { hasText: /^Log in$/i }).first()
    if (await hdr.count()) {
      await hdr.click(); await page.waitForTimeout(1200)
      const t = await page.evaluate(PAGE_TEXT)
      check('header Log In → Log In view, NOT Sign Up', /Welcome back/i.test(t) && !/First Name/i.test(t),
        t.match(/.{0,45}(First Name|Welcome back).{0,35}/i)?.[0] || '')
      await page.screenshot({ path: `${OUT}/auth-header-login.png` })
    } else check('header Log In button found', false)
    await ctx.close()
  }

  await browser.close()
  console.log('\n' + '='.repeat(62))
  console.log(fails === 0 ? 'ALL BROWSER CHECKS PASSED' : `${fails} BROWSER CHECK(S) FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
