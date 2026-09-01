// Verifies the multi-location portal shell follows GRANTS, not role.
//
// No real credentials (Rule 7). The edge only checks that disco_restaurant_token
// EXISTS (see CLAUDE.md), so /api/disco-restaurant-auth/me is stubbed with each
// person's REAL role and REAL grant count as read from Neon, and
// /api/restaurant/locations is left to hit the real resolver.
import { chromium } from '@playwright/test'
const BASE = 'http://localhost:3000'
const OUT = '/private/tmp/claude-501/-Users-peterventi-Desktop-VS-Code/76bbaa67-ff60-4fba-92b4-a107221c33ae/scratchpad'

const PEOPLE = JSON.parse(process.env.PEOPLE_JSON)
let fails = 0
const check = (l, ok, extra = '') => { if (!ok) fails++; console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? ` — ${extra}` : ''}`) }
const TEXT = () => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const o = []; let n
  while ((n = w.nextNode())) { const p = n.parentElement; if (!p || ['SCRIPT','STYLE','NOSCRIPT'].includes(p.tagName)) continue
    const s = (n.nodeValue||'').trim(); if (s) o.push(s) } return o.join(' | ') }

const browser = await chromium.launch()
for (const p of PEOPLE) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  await ctx.addCookies([{ name: 'disco_restaurant_token', value: `stub-${p.email}`, url: BASE }])
  const page = await ctx.newPage()
  await page.route('**/api/disco-restaurant-auth/me', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ email: p.email, firstName: p.firstName, lastName: '', role: p.role,
      restaurantReference: p.anchor, restaurantName: p.anchorName, businessName: p.anchorName,
      locationAccessCount: p.grants }) }))
  await page.route('**/api/restaurant/locations**', async r => {
    // Real resolver output for this email, injected server-side by the runner.
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(p.locationsPayload) })
  })
  console.log(`\n═══ ${p.firstName} <${p.email}>  role=${p.role}  grants=${p.grants}`)
  await page.goto(`${BASE}/restaurant/manage/locations`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  const t = await page.evaluate(TEXT)
  const found = p.expectNames.filter(n => t.includes(n))
  check(`all ${p.expectNames.length} location(s) render`, found.length === p.expectNames.length,
    found.length === p.expectNames.length ? found.join(' + ') : `only ${found.length}: ${found.join(', ')}`)
  check('the Locations nav item is reachable', /Locations/.test(t), t.slice(0, 120))
  await page.screenshot({ path: `${OUT}/reach-${p.email.replace(/[^a-z0-9]/gi,'_')}.png`, fullPage: false })
  await ctx.close()
}
await browser.close()
console.log('\n' + '='.repeat(60))
console.log(fails === 0 ? 'ALL REACH CHECKS PASSED' : `${fails} REACH CHECK(S) FAILED`)
process.exit(fails === 0 ? 0 : 1)
