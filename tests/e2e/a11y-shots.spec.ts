import { test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import fs from 'node:fs'
const BASE = 'http://localhost:3000'
const DIR = 'tests/e2e/a11y-out/shots'
const PHASE = process.env.PHASE || 'before'
fs.mkdirSync(DIR, { recursive: true })

async function axeCount(page: import('@playwright/test').Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()
  const total = r.violations.reduce((n,v)=>n+v.nodes.length,0)
  const contrast = r.violations.filter(v=>v.id==='color-contrast').reduce((n,v)=>n+v.nodes.length,0)
  const other = r.violations.filter(v=>v.id!=='color-contrast').map(v=>`${v.id}:${v.nodes.length}`)
  for (const v of r.violations) for (const n of v.nodes) {
    const d = (n.any?.[0]?.data||{}) as {fgColor?:string;bgColor?:string;contrastRatio?:number}
    console.log(`   DETAIL ${v.id} ${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}:1 | ${(n.html||'').replace(/\s+/g,' ').slice(0,110)}`)
  }
  console.log(`AXE ${PHASE} ${label}: total=${total} contrast=${contrast} other=[${other.join(', ')}]`)
  return { total, contrast, other }
}

test('shots', async ({ page }) => {
  test.setTimeout(300000)
  await page.setViewportSize({ width: 1440, height: 900 })

  // ---- 1. order page, date/time modal dismissed, fixed scroll
  await page.goto(`${BASE}/order/hugosstudiocity`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await page.getByText('×', { exact: true }).first().click({ timeout: 8000 }).catch(()=>{})
  await page.waitForTimeout(1200)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${DIR}/${PHASE}-1-menu.png` })
  const a1 = await axeCount(page, '1-menu')

  // ---- 2. item modal (complete the gate first, then open an item)
  await page.goto(`${BASE}/order/hugosstudiocity`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  const sel = page.locator('select').first()
  const opts = await sel.locator('option').allTextContents()
  const real = opts.find(o => /\d/.test(o) && !/select/i.test(o))
  if (real) await sel.selectOption({ label: real }).catch(()=>{})
  await page.waitForTimeout(600)
  await page.getByText('Start Order', { exact: true }).first().click({ timeout: 8000 }).catch(()=>{})
  await page.waitForTimeout(2200)
  await page.getByText('Breakfast Burritos (Classic)').first().click({ timeout: 10000 }).catch(()=>{})
  await page.waitForTimeout(2200)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: `${DIR}/${PHASE}-2-item-modal.png` })
  const a2 = await axeCount(page, '2-item-modal')

  // ---- 3. locations page
  await page.goto(`${BASE}/locations/hugosrestaurant`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: `${DIR}/${PHASE}-3-locations.png` })
  const a3 = await axeCount(page, '3-locations')

  fs.writeFileSync(`${DIR}/${PHASE}-axe.json`, JSON.stringify({ menu: a1, item: a2, locations: a3 }, null, 2))
})
