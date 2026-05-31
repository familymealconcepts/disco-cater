// Regenerates scripts/output/restaurant-compact.json from the live FM API,
// keyed by Sanity's canonical restaurant list. Replaces the stale March CSV
// dump that only matched 7 of 368 Sanity names (98% fallback rate in the AI
// route).
//
// Shape per entry matches what app/api/disco-chat/route.ts reads:
//   { name, pricePerPerson:{min,max}, offersDelivery, serviceRadiusMiles,
//     eventTypes, topPackages:[{name, serves, pricePerPerson}] }
//
// Resolution: per Sanity restaurant we derive an FM slug from `orderUrl`
// (the segment after `/disco/`) and fall back to `slug.current`. Both are
// tried against /public-api/restaurants/business/{slug} until one returns a
// reference. A restaurant FM can't resolve is logged and skipped — no
// partial entries written.
//
// Run from the disco-cater folder:
//   npx ts-node --skip-project scripts/generateRestaurantCompact.ts --limit=5 --dry-run
//   npx ts-node --skip-project scripts/generateRestaurantCompact.ts --limit=5
//   npx ts-node --skip-project scripts/generateRestaurantCompact.ts        # full run
//
// Flags:
//   --limit=N    process only the first N Sanity restaurants (safe testing)
//   --dry-run    print what would be written; do not touch the file
//
// Env:
//   FM_API_BASE_URL   optional, defaults to https://api.familymeal.com

import { createClient } from '@sanity/client'
import * as fs from 'fs'
import * as path from 'path'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const REQUEST_DELAY_MS = 1000 // ~1 req/sec to FM, per spec

const sanity = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  useCdn: true,
  apiVersion: '2024-01-01',
})

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const limitArg = args.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity

interface SanityRestaurant { name: string; orderUrl?: string; slug?: { current?: string } }

interface FmRestaurantLookup {
  reference: string
  businessName: string
  businessNameWithoutSpaces?: string
}
interface FmMenu { reference: string; name?: string; type?: string }
interface FmPackage {
  reference?: string
  name?: string
  price?: number | string
  serves?: number | string
  displayServes?: number | string
  description?: string
}

interface CompactEntry {
  name: string
  pricePerPerson: { min: number | null; max: number | null }
  offersDelivery: boolean
  serviceRadiusMiles: number
  eventTypes: string[]
  topPackages: { name: string; serves: string; pricePerPerson: string }[]
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// FM slug extraction mirrors page.tsx — the segment between /disco/ and the
// next /. Sanity stores e.g. https://www.familymeal.com/disco/twohandsfranklin/catering
function fmSlugFromOrderUrl(orderUrl?: string): string | null {
  if (!orderUrl) return null
  const m = orderUrl.match(/\/disco\/([^/?#]+)/)
  return m ? m[1].trim() : null
}

async function fmGet<T>(urlPath: string): Promise<T | null> {
  try {
    const res = await fetch(`${FM}${urlPath}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function resolveFmRestaurant(slugs: string[]): Promise<FmRestaurantLookup | null> {
  for (const slug of slugs) {
    if (!slug) continue
    const data = await fmGet<FmRestaurantLookup>(
      `/public-api/restaurants/business/${encodeURIComponent(slug)}`,
    )
    if (data && data.reference) return data
    await sleep(REQUEST_DELAY_MS)
  }
  return null
}

async function fetchPackagesForRestaurant(ref: string): Promise<FmPackage[]> {
  const menus = await fmGet<FmMenu[]>(`/public-api/menu?restaurantReference=${ref}`)
  if (!Array.isArray(menus) || menus.length === 0) return []
  await sleep(REQUEST_DELAY_MS)

  const all: FmPackage[] = []
  for (const menu of menus) {
    // FM's mealPackages endpoint returns categories with nested packages —
    // shape mirrors what page.tsx feeds RestaurantClient. Flatten to a flat
    // list of FmPackage entries (handles either flat or {packages:[…]} shape).
    const cats = await fmGet<any[]>(
      `/public-api/restaurants/${ref}/mealPackages?menuReference=${menu.reference}`,
    )
    if (Array.isArray(cats)) {
      for (const c of cats) {
        const list: FmPackage[] = Array.isArray(c?.mealPackages)
          ? c.mealPackages
          : Array.isArray(c?.packages)
            ? c.packages
            : (c && (c.price != null || c.name)) ? [c as FmPackage] : []
        for (const p of list) all.push(p)
      }
    }
    await sleep(REQUEST_DELAY_MS)
  }
  return all
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return isFinite(n) ? n : null
  }
  return null
}

function pkgServes(p: FmPackage): number | null {
  return num(p.displayServes) ?? num(p.serves)
}

// Same heuristic as the existing CSV generator (process-restaurant-data.js).
function inferEventTypes(menuText: string, packageText: string): string[] {
  const all = (menuText + ' ' + packageText).toLowerCase()
  const types = new Set<string>()
  if (/corporate|office|business|meeting|conference|work\s*lunch|team/.test(all)) types.add('corporate/office')
  if (/holiday|christmas|thanksgiving|new\s*year|hanukkah|festive|seasonal/.test(all)) types.add('holiday parties')
  if (/wedding|birthday|party|celebration|social|graduation|baby\s*shower|bridal/.test(all)) types.add('social events')
  if (/meal\s*prep|weekly|subscription|daily/.test(all)) types.add('meal prep')
  if (/private\s*chef|exclusive|vip/.test(all)) types.add('private/exclusive events')
  if (types.size === 0) { types.add('corporate/office'); types.add('social events') }
  return [...types]
}

function buildCompactEntry(displayName: string, packages: FmPackage[]): CompactEntry | null {
  if (packages.length === 0) return null

  const perPersonPrices: number[] = []
  for (const p of packages) {
    const price = num(p.price)
    const serves = pkgServes(p) ?? 1
    if (price === null || price <= 0 || serves <= 0) continue
    perPersonPrices.push(Math.round((price / serves) * 100) / 100)
  }

  // Top 2 by serves (matches existing compact behavior — drinks/snacks rank
  // low naturally; entrée trays bubble up).
  const topPackages = packages
    .filter(p => num(p.price) !== null && (num(p.price) as number) > 0)
    .sort((a, b) => (pkgServes(b) ?? 0) - (pkgServes(a) ?? 0))
    .slice(0, 2)
    .map(p => {
      const price = num(p.price) as number
      const serves = pkgServes(p)
      const pppNum = serves && serves > 0 ? price / serves : null
      return {
        name: String(p.name ?? ''),
        serves: serves != null ? String(serves) : '',
        pricePerPerson: pppNum != null ? `$${pppNum.toFixed(2)}/person` : '',
      }
    })

  const eventTypes = inferEventTypes(
    packages.map(p => p.description ?? '').join(' '),
    packages.map(p => p.name ?? '').join(' '),
  )

  return {
    name: displayName,
    pricePerPerson: perPersonPrices.length
      ? { min: Math.min(...perPersonPrices), max: Math.max(...perPersonPrices) }
      : { min: null, max: null },
    // Every Disco-marketplace restaurant supports delivery via FM's Nash
    // integration (page.tsx's order flow toggles PICKUP/DELIVERY freely). No
    // public FM field distinguishes pickup-only, so we default true and let
    // server-side validate-address gate it at checkout.
    offersDelivery: true,
    serviceRadiusMiles: 20,
    eventTypes,
    topPackages,
  }
}

async function main() {
  console.log(`[generateRestaurantCompact] FM=${FM}, dryRun=${DRY_RUN}, limit=${LIMIT === Infinity ? 'all' : LIMIT}`)
  console.log('[1/3] Fetching Sanity restaurant list…')

  const rows: SanityRestaurant[] = await sanity.fetch(
    `*[_type=="restaurant" && defined(name)]{ name, orderUrl, slug }`,
  )
  console.log(`     ${rows.length} Sanity restaurants`)

  const targets = rows.slice(0, LIMIT)
  console.log(`[2/3] Resolving FM + fetching packages for ${targets.length} restaurants (sleep ${REQUEST_DELAY_MS}ms between FM calls)…`)

  const results: CompactEntry[] = []
  const skipped: { name: string; reason: string }[] = []
  let i = 0
  for (const r of targets) {
    i++
    const tag = `[${i}/${targets.length}]`
    const candidateSlugs = [fmSlugFromOrderUrl(r.orderUrl), r.slug?.current]
      .filter((s): s is string => !!s)
    if (candidateSlugs.length === 0) {
      console.warn(`${tag} ⏭  ${r.name} — no FM slug (no orderUrl or sanity slug)`)
      skipped.push({ name: r.name, reason: 'no-slug' }); continue
    }

    const fm = await resolveFmRestaurant(candidateSlugs)
    if (!fm) {
      console.warn(`${tag} ⏭  ${r.name} — FM lookup failed (tried: ${candidateSlugs.join(', ')})`)
      skipped.push({ name: r.name, reason: 'fm-404' }); continue
    }

    const packages = await fetchPackagesForRestaurant(fm.reference)
    if (packages.length === 0) {
      console.warn(`${tag} ⏭  ${r.name} — FM ref=${fm.reference} but no packages`)
      skipped.push({ name: r.name, reason: 'no-packages' }); continue
    }

    // KEY: use the Sanity name as the entry name so the route's name match
    // (sanity.name === compact.name, case-insensitive trim) hits. This is
    // the entire reason we're regenerating.
    const entry = buildCompactEntry(r.name, packages)
    if (!entry) {
      console.warn(`${tag} ⏭  ${r.name} — couldn't build entry from ${packages.length} packages`)
      skipped.push({ name: r.name, reason: 'no-priced-packages' }); continue
    }
    results.push(entry)

    const ppp = entry.pricePerPerson
    const range = ppp.min != null ? `$${ppp.min}-$${ppp.max}/p` : 'no price'
    console.log(`${tag} ✓  ${r.name} — ${packages.length} pkgs, ${entry.topPackages.length} top, ${range}, events: [${entry.eventTypes.join(', ')}]`)
  }

  console.log(`[3/3] Done. Built ${results.length} entries, skipped ${skipped.length}.`)
  if (skipped.length > 0) {
    const counts = skipped.reduce<Record<string, number>>((acc, s) => { acc[s.reason] = (acc[s.reason] ?? 0) + 1; return acc }, {})
    console.log(`     Skip reasons: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: NOT writing the file. Sample output (up to 3 entries):')
    console.log(JSON.stringify(results.slice(0, 3), null, 2))
    return
  }

  // Anchor on CWD so this works whether ts-node loads the script as CJS or
  // ESM (import.meta + __dirname behave differently across module modes).
  // The script is documented to run from the disco-cater project root.
  const outDir = path.join(process.cwd(), 'scripts', 'output')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'restaurant-compact.json')
  fs.writeFileSync(outPath, JSON.stringify(results))
  const sizeKb = Math.round(fs.statSync(outPath).size / 1024)
  console.log(`\nWrote ${results.length} entries → ${outPath} (${sizeKb} KB)`)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
