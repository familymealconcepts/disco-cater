import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import fs from 'node:fs'

const BASE = 'https://www.discocater.com'
const OUT = 'tests/e2e/a11y-out'
fs.mkdirSync(OUT, { recursive: true })

type Summary = { rule: string; impact: string; nodes: number }

async function scan(page: import('@playwright/test').Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const byRule: Summary[] = r.violations
    .map(v => ({ rule: v.id, impact: v.impact || '?', nodes: v.nodes.length }))
    .sort((a, b) => b.nodes - a.nodes)
  const total = byRule.reduce((n, v) => n + v.nodes, 0)
  const serious = r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
    .reduce((n, v) => n + v.nodes.length, 0)

  // Colour-contrast pairs, so a token count is possible rather than a node count.
  const pairs: Record<string, number> = {}
  for (const v of r.violations.filter(v => v.id === 'color-contrast')) {
    for (const n of v.nodes) {
      const m = (n.any?.[0]?.message || '') as string
      const fg = m.match(/foreground color: (#[0-9a-f]{3,8})/i)?.[1]?.toLowerCase() || '?'
      const bg = m.match(/background color: (#[0-9a-f]{3,8})/i)?.[1]?.toLowerCase() || '?'
      const ratio = m.match(/contrast ratio of ([\d.]+)/i)?.[1] || '?'
      const k = `${fg} on ${bg}  (${ratio}:1)`
      pairs[k] = (pairs[k] || 0) + 1
    }
  }
  fs.writeFileSync(`${OUT}/${label}.json`, JSON.stringify({ total, serious, byRule, pairs, violations: r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.html?.slice(0, 160) })) }, null, 2))

  console.log(`\n===== ${label} =====`)
  console.log(`total violation nodes: ${total}   serious+critical: ${serious}`)
  console.log('--- by rule ---')
  for (const b of byRule) console.log(`  ${String(b.nodes).padStart(4)}  ${b.impact.padEnd(9)} ${b.rule}`)
  const pe = Object.entries(pairs).sort((a, b) => b[1] - a[1])
  if (pe.length) {
    console.log('--- contrast, by colour pair ---')
    for (const [k, n] of pe) console.log(`  ${String(n).padStart(4)}  ${k}`)
  }
  return { total, serious }
}

test('locations page', async ({ page }) => {
  await page.goto(`${BASE}/locations/hugosrestaurant`, { waitUntil: 'networkidle' })
  await scan(page, 'locations-hugosrestaurant')
})

test('order page on load', async ({ page }) => {
  await page.goto(`${BASE}/order/hugosstudiocity`, { waitUntil: 'networkidle' })
  await scan(page, 'order-hugosstudiocity')
})
