// After the revert: does the portal shell offer a Locations nav at all?
// ADMIN must get Mode B (no Locations); SYSTEM_ADMIN must keep the switcher.
import { chromium } from '@playwright/test'
const BASE = 'http://localhost:3000'
const OUT = '/private/tmp/claude-501/-Users-peterventi-Desktop-VS-Code/76bbaa67-ff60-4fba-92b4-a107221c33ae/scratchpad'
const PEOPLE = JSON.parse(process.env.PEOPLE_JSON)
let fails = 0
const check = (l, ok, extra='') => { if (!ok) fails++; console.log(`   ${ok?'PASS':'FAIL'}  ${l}${extra?` — ${extra}`:''}`) }
const TEXT = () => { const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); const o=[]; let n
  while((n=w.nextNode())){const p=n.parentElement; if(!p||['SCRIPT','STYLE','NOSCRIPT'].includes(p.tagName))continue
    const s=(n.nodeValue||'').trim(); if(s)o.push(s)} return o.join(' | ') }
const browser = await chromium.launch()
for (const p of PEOPLE) {
  const ctx = await browser.newContext({ viewport:{width:1500,height:1000} })
  await ctx.addCookies([{ name:'disco_restaurant_token', value:`stub-${p.email}`, url: BASE }])
  const page = await ctx.newPage()
  await page.route('**/api/disco-restaurant-auth/me', r => r.fulfill({ status:200, contentType:'application/json',
    body: JSON.stringify({ email:p.email, firstName:p.firstName, lastName:'', role:p.role,
      restaurantReference:p.anchor, restaurantName:p.anchorName, businessName:p.anchorName }) }))
  await page.route('**/api/restaurant/locations**', r => r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(p.locationsPayload) }))
  const expectSwitcher = p.role === 'SYSTEM_ADMIN' || p.role === 'SUPER_ADMIN'
  console.log(`\n═══ ${p.firstName} <${p.email}>  role=${p.role}  grants=${p.grants}  → expect ${expectSwitcher ? 'multi-location nav' : 'SINGLE location, no Locations nav'}`)
  await page.goto(`${BASE}/restaurant/orders`, { waitUntil:'domcontentloaded' })
  await page.waitForTimeout(4500)
  const t = await page.evaluate(TEXT)
  const navHasLocations = /\| Locations \|/.test(t) || /\| Authorized Users \|/.test(t)
  check(expectSwitcher ? 'Locations nav present' : 'Locations nav ABSENT (Mode B)', navHasLocations === expectSwitcher,
    `nav shows: ${(t.match(/cater \| [^|]+((\| [^|]+){0,8})/)||[''])[0].slice(0,150)}`)
  const others = p.expectNames.filter(n => n !== p.anchorName && t.includes(n))
  if (!expectSwitcher) check('no OTHER granted location name is rendered', others.length === 0, others.join(', '))
  await page.screenshot({ path:`${OUT}/revert-${p.email.replace(/[^a-z0-9]/gi,'_')}.png` })
  await ctx.close()
}
await browser.close()
console.log('\n' + '='.repeat(60))
console.log(fails===0 ? 'REVERT BEHAVES AS PETER SPECIFIED' : `${fails} CHECK(S) FAILED`)
process.exit(fails===0?0:1)
