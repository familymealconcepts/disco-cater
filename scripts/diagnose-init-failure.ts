// Diagnose checkout init 500 for a restaurant: reports the data behind each
// hypothesis in docs/checkout-init-500-diagnostic.md so they can be compared
// across restaurants (Test Kitchen vs a known-working one).
//
// Run from the disco-cater folder:
//   FM_AUTH=<raw FM admin JWT, no "Bearer "> \
//     npx ts-node --skip-project scripts/diagnose-init-failure.ts <restaurantRef>
//
// Env:
//   FM_AUTH           FM admin JWT, raw (required for the /api/* checks)
//   FM_API_BASE_URL   optional, defaults to https://api.familymeal.com
//
// Read-only: issues GETs/HEADs only, never writes.

import * as https from 'https'
import { URL } from 'url'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const FM_AUTH = process.env.FM_AUTH || ''
const ref = process.argv[2]

interface Res { status: number; body: any; raw: string }

function request(method: 'GET' | 'HEAD', path: string, auth: boolean): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(`${FM}${path}`)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (auth && FM_AUTH) headers.Authorization = FM_AUTH
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      r => {
        let data = ''
        r.on('data', c => (data += c))
        r.on('end', () => {
          let body: any = null
          try { body = data ? JSON.parse(data) : null } catch { /* non-JSON */ }
          resolve({ status: r.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const line = (s = '') => console.log(s)

// Walk an arbitrary menu/package response and collect { name, price, displayPrice }.
function collectPackages(node: any, out: { name: string; price: any; displayPrice: any }[] = []): typeof out {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collectPackages(n, out); return out }
  if ('price' in node && ('name' in node || 'reference' in node)) {
    out.push({ name: node.name || node.reference, price: node.price, displayPrice: node.displayPrice })
  }
  for (const k of Object.keys(node)) {
    if (node[k] && typeof node[k] === 'object') collectPackages(node[k], out)
  }
  return out
}

async function main() {
  if (!ref) { console.error('Usage: diagnose-init-failure.ts <restaurantRef>'); process.exit(1) }
  if (!FM_AUTH) console.warn('⚠️  FM_AUTH not set — /api/* checks will likely 401. public-api checks still run.\n')

  line(`Diagnosing restaurant ${ref}`)
  line(`FM: ${FM}`)
  line('─'.repeat(60))

  // H1 — Stripe Connect
  line('\n[H1] STRIPE CONNECT')
  try {
    const s = await request('HEAD', `/api/stripe/${ref}`, true)
    // HEAD api/stripe/{ref}: 200 = connected, 404 = not connected (stripe.service.ts:33)
    line(`  HEAD /api/stripe/${ref} → ${s.status}  ${s.status === 200 ? '✓ connected' : s.status === 404 ? '✗ NOT connected (likely cause)' : '(unexpected)'}`)
  } catch (e) { line(`  HEAD /api/stripe failed: ${e}`) }

  // Restaurant object (H1 moneyFlow, H5 blocked/type/online ordering)
  let rest: any = null
  try {
    const r = await request('GET', `/api/admin/restaurants/${ref}`, true)
    rest = r.body
    if (r.status !== 200) line(`  GET /api/admin/restaurants/${ref} → ${r.status}`)
  } catch (e) { line(`  GET restaurant failed: ${e}`) }
  if (rest) {
    line(`  restaurantConnectToStripe: ${rest.restaurantConnectToStripe ?? '(absent)'}`)
    line(`  moneyFlow: ${rest.moneyFlow ?? '(absent)'}  (FAMILY_MEAL = held, DIRECT = released)`)
  }

  // H5 — visibility / type / online ordering
  line('\n[H5] VISIBILITY / TYPE / ONLINE ORDERING')
  if (rest) {
    line(`  blocked: ${rest.blocked ?? '(absent)'}`)
    line(`  type: ${rest.type ?? '(absent)'}  (expect ORDERING)`)
    line(`  onlineOrderingAllowed: ${rest.onlineOrderingAllowed ?? '(absent)'}`)
    line(`  restaurantStatus/status: ${rest.restaurantStatus ?? rest.status ?? '(absent)'}`)
    line(`  businessName: ${rest.businessName ?? '(absent)'}`)
  } else {
    line('  (no restaurant object — check FM_AUTH / ref)')
  }

  // H2 — menu / display pricing
  line('\n[H2] MENU / PRICING (public)')
  try {
    const m = await request('GET', `/public-api/restaurants/${ref}/mealPackages`, false)
    line(`  GET /public-api/restaurants/${ref}/mealPackages → ${m.status}`)
    const pkgs = collectPackages(m.body)
    if (!pkgs.length) line('  (no packages found in response — inspect raw if unexpected)')
    for (const p of pkgs.slice(0, 25)) {
      const bad = p.price === null || p.price === undefined || Number(p.price) <= 0
      line(`  • ${p.name}: price=${p.price}${p.displayPrice !== undefined ? ` displayPrice=${p.displayPrice}` : ''}${bad ? '  ⚠️ invalid price' : ''}`)
    }
  } catch (e) { line(`  meal packages fetch failed: ${e}`) }

  // H3 — lead time / cutoff (per menu)
  line('\n[H3] LEAD TIME / CUTOFF (menus)')
  try {
    const mn = await request('GET', `/api/menu?restaurantReference=${ref}&size=100`, true)
    line(`  GET /api/menu?restaurantReference=${ref} → ${mn.status}`)
    const menus = mn.body?.content || (Array.isArray(mn.body) ? mn.body : [])
    for (const menu of menus.slice(0, 25)) {
      const so = menu.scheduleOption || {}
      line(`  • ${menu.name || menu.reference}: prepTime(hrs)=${so.prepTime ?? '?'} cutOffType=${so.cutOffType ?? '-'} cutOff=${so.cutOff ?? '-'} cutOffDate=${so.cutOffDate ?? '-'}`)
    }
    if (!menus.length) line('  (no menus returned — may need a different param for SUPER_ADMIN)')
  } catch (e) { line(`  menu fetch failed: ${e}`) }
  line('  → compare prepTime/cutoff against the requested datetime + "now".')

  // H4 — tax config (best-effort; endpoint is normally JWT/selected-restaurant scoped)
  line('\n[H4] TAX CONFIG (best-effort)')
  try {
    const t = await request('GET', `/api/restaurants/taxRate?restaurantReference=${ref}`, true)
    line(`  GET /api/restaurants/taxRate → ${t.status}`)
    if (t.body) line(`  body: ${JSON.stringify(t.body).slice(0, 300)}`)
  } catch (e) { line(`  tax fetch failed: ${e}`) }

  line('\n' + '─'.repeat(60))
  line('Done. Cross-check against docs/checkout-init-500-diagnostic.md, and run')
  line('this against a known-working restaurant to diff (esp. H1 Stripe + H2 pricing).')
}

main().catch(e => { console.error(e); process.exit(1) })
