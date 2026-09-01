// Barbara's portal, as her, with her REAL role and the REAL resolver output.
// /me is stubbed (her session can't be minted without impersonating her) but the
// role and the location list are exactly what the live code produces for her.
import { chromium } from '@playwright/test'
const BASE = 'http://localhost:3000'
const OUT = '/private/tmp/claude-501/-Users-peterventi-Desktop-VS-Code/76bbaa67-ff60-4fba-92b4-a107221c33ae/scratchpad'
const p = JSON.parse(process.env.PEOPLE_JSON)[0]
let fails = 0
const check = (l, ok, extra='') => { if (!ok) fails++; console.log(`   ${ok?'PASS':'FAIL'}  ${l}${extra?` — ${extra}`:''}`) }
const TEXT = () => { const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); const o=[]; let n
  while((n=w.nextNode())){const q=n.parentElement; if(!q||['SCRIPT','STYLE','NOSCRIPT'].includes(q.tagName))continue
    const s=(n.nodeValue||'').trim(); if(s)o.push(s)} return o.join(' | ') }

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport:{width:1500,height:1000} })
await ctx.addCookies([{ name:'disco_restaurant_token', value:'stub-barbara', url: BASE }])
const page = await ctx.newPage()
await page.route('**/api/disco-restaurant-auth/me', r => r.fulfill({ status:200, contentType:'application/json',
  body: JSON.stringify({ email:p.email, firstName:p.firstName, lastName:'Coultas', role:p.role,
    restaurantReference:p.anchor, restaurantName:p.anchorName, businessName:p.anchorName }) }))
await page.route('**/api/restaurant/locations**', r => r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(p.locationsPayload) }))

console.log(`\n═══ Barbara <${p.email}>  role=${p.role}  grants=${p.grants}`)
await page.goto(`${BASE}/restaurant/manage/locations`, { waitUntil:'domcontentloaded' })
await page.waitForTimeout(4500)
let t = await page.evaluate(TEXT)
check('multi-location shell (Locations nav present)', /\| Locations \|/.test(t))
const found = p.expectNames.filter(n => t.includes(n))
check(`both Gracious locations listed`, found.length === p.expectNames.length, found.join(' + '))
await page.screenshot({ path:`${OUT}/barbara-locations.png` })

// Switching: click the NON-anchor location and confirm the portal enters it.
const other = p.expectNames.find(n => n !== p.anchorName)
console.log(`\n   switching to "${other}" …`)
await page.locator(`text=${other}`).first().click().catch(e => console.log('   click err: ' + e.message))
await page.waitForTimeout(4000)
t = await page.evaluate(TEXT)
check('portal switched into the other location', t.includes(other), (t.match(/cater \| [^|]+/)||[''])[0])
check('and it is now in single-location (Mode B) view for that location', /\| Orders \|/.test(t))
await page.screenshot({ path:`${OUT}/barbara-switched.png` })

// And back.
// The control is "← View as System Admin" (layout.tsx:398), not "All locations".
const back = page.locator('button', { hasText: /View as System Admin/i }).first()
check('the "View as System Admin" control is offered', (await back.count()) > 0)
if (await back.count()) {
  await back.click().catch(()=>{}); await page.waitForTimeout(4000)
  const b = await page.evaluate(TEXT)
  check('switched BACK to the all-locations view', /\| Locations \|/.test(b) && p.expectNames.every(n => b.includes(n)),
    (b.match(/cater \| [^|]+((\| [^|]+){0,4})/)||[''])[0].slice(0,120))
}
await page.screenshot({ path:`${OUT}/barbara-back.png` })

await browser.close()
console.log('\n' + '='.repeat(58))
console.log(fails===0 ? 'BARBARA SEES BOTH — CLOSED' : `${fails} CHECK(S) FAILED`)
process.exit(fails===0?0:1)
