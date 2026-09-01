/**
 * Render FamilyMeal and Disco Cater side by side for the SAME restaurant and
 * diff what each page actually shows a customer.
 *
 * WHY. Nearly every real bug this week surfaced from exactly this comparison —
 * the 15-minute slot grid, the partial-day blackouts, the missing item images,
 * the delivery fee. Each was invisible in the data and obvious side by side.
 * This runs the comparison without waiting for a person to notice.
 *
 * WHAT IT COMPARES. Rendered text, not API responses: item names, the price and
 * "Serves"/"Select" line under each, the notice banner, and the fulfilment
 * date/time bar. Slot GRIDS are deliberately NOT compared here — FM's picker is
 * an Angular flow, and scripts/verify-lead-time.ts already diffs slots against
 * FM's own availablePickUp far more precisely than a screenshot can.
 *
 *   node scripts/compare-fm-disco.mjs veselka
 *   node scripts/compare-fm-disco.mjs veselka --base http://localhost:3000 --out /tmp/x
 *
 * FM is read ANONYMOUSLY. A restaurant-portal comparison would need the master
 * password (FM_MASTER_PASSWORD); see the note at the bottom of this file.
 */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const slug = process.argv[2]
if (!slug) { console.error('usage: node scripts/compare-fm-disco.mjs <slug> [--base URL] [--out DIR]'); process.exit(1) }
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d }
const BASE = arg('--base', 'https://www.discocater.com')
const OUT = arg('--out', '.')
mkdirSync(OUT, { recursive: true })

const FM_URL = `https://www.familymeal.com/disco/${slug}/catering`
const DISCO_URL = `${BASE}/restaurants/${slug}`

/** Visible text only — a blanket querySelectorAll('*') pulls in script bodies. */
const VISIBLE = () => {
  const out = []
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n
  while ((n = w.nextNode())) {
    const el = n.parentElement
    if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue
    const s = (n.textContent || '').replace(/\s+/g, ' ').trim()
    if (s) out.push(s)
  }
  return out
}

async function grab(page, url, shot) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForTimeout(6500)
  // Disco opens a date/time modal on load; dismiss it so the menu is visible.
  const close = page.locator('button', { hasText: /^×$/ }).first()
  if (await close.count()) { await close.click().catch(() => {}); await page.waitForTimeout(900) }
  const text = await page.evaluate(VISIBLE)
  await page.screenshot({ path: `${OUT}/${shot}`, fullPage: false })
  return text
}

const MONEY = /^\$[\d,]+(\.\d{2})?(\s*(per|\/)\s*\w+)?\+?$/i
const NOISE = /^(sign up|log in|menu|menus|close|×|contact|privacy policy|merchant agreement|\.\.\.|order summary|catering)$/i

const classify = (lines) => {
  const prices = new Set(), serves = new Set(), selects = new Set(), notices = new Set(), names = new Set()
  for (const l of lines) {
    if (NOISE.test(l)) continue
    if (MONEY.test(l)) { prices.add(l); continue }
    if (/^Serves\b/i.test(l)) { serves.add(l); continue }
    if (/^Select \d/i.test(l) || /minimum/i.test(l)) { selects.add(l); continue }
    if (/notice|minimum on|allow \d/i.test(l)) { notices.add(l); continue }
    // A plausible item/section name: title-ish, not a sentence.
    if (l.length >= 3 && l.length <= 60 && !/[.!?]$/.test(l)) names.add(l)
  }
  return { prices, serves, selects, notices, names }
}

const diff = (a, b) => [...a].filter(x => !b.has(x))
const show = (label, only, cap = 12) => {
  const list = [...only]
  console.log(`   ${label}: ${list.length}`)
  list.slice(0, cap).forEach(x => console.log(`      ${x}`))
  if (list.length > cap) console.log(`      … and ${list.length - cap} more`)
}

const b = await chromium.launch()
try {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 1200 } })
  const [fmText, discoText] = [
    await grab(await ctx.newPage(), FM_URL, `compare-${slug}-fm.png`),
    await grab(await ctx.newPage(), DISCO_URL, `compare-${slug}-disco.png`),
  ]
  const fm = classify(fmText), disco = classify(discoText)

  console.log(`\n=== ${slug} ===`)
  console.log(`   FM    ${FM_URL}`)
  console.log(`   Disco ${DISCO_URL}`)
  console.log(`   screenshots: ${OUT}/compare-${slug}-{fm,disco}.png\n`)

  console.log('── ITEM / SECTION NAMES ──')
  show('on FM only', diff(fm.names, disco.names))
  show('on Disco only', diff(disco.names, fm.names))

  console.log('\n── PRICES ──')
  show('on FM only', diff(fm.prices, disco.prices))
  show('on Disco only', diff(disco.prices, fm.prices))

  console.log('\n── SERVES / MINIMUM LABELS ──')
  show('on FM only', new Set([...diff(fm.serves, disco.serves), ...diff(fm.selects, disco.selects)]))
  show('on Disco only', new Set([...diff(disco.serves, fm.serves), ...diff(disco.selects, fm.selects)]))

  console.log('\n── NOTICES / BANNERS ──')
  show('on FM only', diff(fm.notices, disco.notices))
  show('on Disco only', diff(disco.notices, fm.notices))

  const gaps = diff(fm.names, disco.names).length + diff(fm.prices, disco.prices).length
  console.log(`\n${'='.repeat(60)}`)
  console.log(gaps === 0
    ? 'No name or price appears on FM that is missing from Disco.'
    : `${gaps} name/price value(s) render on FM and NOT on Disco — inspect the screenshots.`)
} finally {
  await b.close()
}

// ── Authenticating as a restaurant ──────────────────────────────────────────
// FM's login is a modal at https://www.familymeal.com/?action=signIn (there is
// no /login route — it 404s to /page/not-found). It renders Email + Password
// inputs, so a browser login is mechanically straightforward, and
// FM_MASTER_PASSWORD works in place of any enabled restaurant admin's password.
//
// NOT DONE HERE, on purpose. lib/fm-master-admin-read.ts writes an audit row for
// every master-password use ('FM_MASTER_PASSWORD_READ'); a browser login would
// bypass that trail unless it writes the same entry. Wire that first, then add a
// restaurant-portal comparison — do not sign in from a script without it.
