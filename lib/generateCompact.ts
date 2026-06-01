// Shared core for regenerating scripts/output/restaurant-compact.json — the
// enriched, Sanity-keyed restaurant data the AI assistant (app/api/disco-chat/
// route.ts) reads at cold start. Both the CLI script
// (scripts/generateRestaurantCompact.ts) and the automation routes
// (app/api/cron/regenerate-compact, app/api/webhooks/sanity-restaurant) import
// this so the generation logic lives in exactly one place.
//
// Shape per entry MUST stay identical to what disco-chat reads:
//   { name, pricePerPerson:{min,max}, offersDelivery, serviceRadiusMiles,
//     eventTypes, topPackages:[{name, serves, pricePerPerson}] }
//
// Resolution: per Sanity restaurant we derive an FM slug from `orderUrl` (the
// segment after `/disco/`) and fall back to `slug.current`. Both are tried
// against /public-api/restaurants/business/{slug} until one returns a
// reference. A restaurant FM can't resolve is logged + skipped (no partials).
//
// NOTE on writeCompactFile + serverless: this writes to the project tree
// (scripts/output). That works locally, in CI, and on any writable host. On
// Vercel's serverless runtime the deployment filesystem is READ-ONLY, so a
// cron/webhook write there will not persist into the deployed bundle that
// disco-chat reads. To wire production end-to-end, regenerate then commit the
// file back to the repo (e.g. via the GitHub API → redeploy) or move the data
// to Blob/KV. The format + disco-chat are intentionally untouched here.

import { createClient } from '@sanity/client'
import * as fs from 'fs'
import * as path from 'path'

const DEFAULT_FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const DEFAULT_DELAY_MS = 1000 // ~1 req/sec to FM, per spec

const sanity = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  useCdn: true,
  apiVersion: '2024-01-01',
})

export interface CompactEntry {
  name: string
  pricePerPerson: { min: number | null; max: number | null }
  offersDelivery: boolean
  serviceRadiusMiles: number
  eventTypes: string[]
  topPackages: { name: string; serves: string; pricePerPerson: string }[]
}

export interface GenerateResult {
  entries: CompactEntry[]
  skipped: { name: string; reason: string }[]
}

export interface GenerateOptions {
  /** Process only the first N Sanity restaurants (safe testing). */
  limit?: number
  /** FM API base URL override. */
  fmBase?: string
  /** Delay between FM calls (ms). Defaults to 1000 (~1 req/sec). */
  requestDelayMs?: number
  /** Progress sink (e.g. console.log for the CLI; no-op in routes). */
  log?: (msg: string) => void
}

interface SanityRestaurant { name: string; orderUrl?: string; slug?: { current?: string } }
interface FmRestaurantLookup { reference: string; businessName: string; businessNameWithoutSpaces?: string }
interface FmMenu { reference: string; name?: string; type?: string }
interface FmPackage {
  reference?: string
  name?: string
  price?: number | string
  serves?: number | string
  displayServes?: number | string
  description?: string
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// FM slug extraction mirrors page.tsx — the segment between /disco/ and the
// next /. Sanity stores e.g. https://www.familymeal.com/disco/twohandsfranklin/catering
function fmSlugFromOrderUrl(orderUrl?: string): string | null {
  if (!orderUrl) return null
  const m = orderUrl.match(/\/disco\/([^/?#]+)/)
  return m ? m[1].trim() : null
}

async function fmGet<T>(fmBase: string, urlPath: string): Promise<T | null> {
  try {
    const res = await fetch(`${fmBase}${urlPath}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function resolveFmRestaurant(fmBase: string, slugs: string[], delay: number): Promise<FmRestaurantLookup | null> {
  for (const slug of slugs) {
    if (!slug) continue
    const data = await fmGet<FmRestaurantLookup>(fmBase, `/public-api/restaurants/business/${encodeURIComponent(slug)}`)
    if (data && data.reference) return data
    await sleep(delay)
  }
  return null
}

async function fetchPackagesForRestaurant(fmBase: string, ref: string, delay: number): Promise<FmPackage[]> {
  const menus = await fmGet<FmMenu[]>(fmBase, `/public-api/menu?restaurantReference=${ref}`)
  if (!Array.isArray(menus) || menus.length === 0) return []
  await sleep(delay)

  const all: FmPackage[] = []
  for (const menu of menus) {
    // FM's mealPackages endpoint returns categories with nested packages.
    // Flatten to a flat list (handles either flat or {packages:[…]} shape).
    const cats = await fmGet<any[]>(fmBase, `/public-api/restaurants/${ref}/mealPackages?menuReference=${menu.reference}`)
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
    await sleep(delay)
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

// Same heuristic as the original CSV generator (process-restaurant-data.js).
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

  // Top 2 by serves (entrée trays bubble up; drinks/snacks rank low).
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
    // integration; no public FM field distinguishes pickup-only, so default
    // true and let server-side validate-address gate it at checkout.
    offersDelivery: true,
    serviceRadiusMiles: 20,
    eventTypes,
    topPackages,
  }
}

/**
 * Core generation: fetch the Sanity restaurant list, resolve each against FM,
 * fetch packages, and build the compact entries. Pure data — does NOT write
 * any file (call writeCompactFile separately).
 */
export async function generateCompact(opts: GenerateOptions = {}): Promise<GenerateResult> {
  const fmBase = opts.fmBase || DEFAULT_FM
  const delay = opts.requestDelayMs ?? DEFAULT_DELAY_MS
  const limit = opts.limit ?? Infinity
  const log = opts.log ?? (() => {})

  log(`[generateCompact] FM=${fmBase}, limit=${limit === Infinity ? 'all' : limit}, delay=${delay}ms`)
  log('[1/3] Fetching Sanity restaurant list…')

  const rows: SanityRestaurant[] = await sanity.fetch(
    `*[_type=="restaurant" && defined(name)]{ name, orderUrl, slug }`,
  )
  log(`     ${rows.length} Sanity restaurants`)

  const targets = rows.slice(0, limit)
  log(`[2/3] Resolving FM + fetching packages for ${targets.length} restaurants…`)

  const entries: CompactEntry[] = []
  const skipped: { name: string; reason: string }[] = []
  let i = 0
  for (const r of targets) {
    i++
    const tag = `[${i}/${targets.length}]`
    const candidateSlugs = [fmSlugFromOrderUrl(r.orderUrl), r.slug?.current].filter((s): s is string => !!s)
    if (candidateSlugs.length === 0) {
      log(`${tag} ⏭  ${r.name} — no FM slug`)
      skipped.push({ name: r.name, reason: 'no-slug' }); continue
    }

    const fm = await resolveFmRestaurant(fmBase, candidateSlugs, delay)
    if (!fm) {
      log(`${tag} ⏭  ${r.name} — FM lookup failed (tried: ${candidateSlugs.join(', ')})`)
      skipped.push({ name: r.name, reason: 'fm-404' }); continue
    }

    const packages = await fetchPackagesForRestaurant(fmBase, fm.reference, delay)
    if (packages.length === 0) {
      log(`${tag} ⏭  ${r.name} — FM ref=${fm.reference} but no packages`)
      skipped.push({ name: r.name, reason: 'no-packages' }); continue
    }

    // KEY: use the Sanity name as the entry name so disco-chat's name match
    // (sanity.name === compact.name, case-insensitive trim) hits.
    const entry = buildCompactEntry(r.name, packages)
    if (!entry) {
      log(`${tag} ⏭  ${r.name} — couldn't build entry from ${packages.length} packages`)
      skipped.push({ name: r.name, reason: 'no-priced-packages' }); continue
    }
    entries.push(entry)

    const ppp = entry.pricePerPerson
    const range = ppp.min != null ? `$${ppp.min}-$${ppp.max}/p` : 'no price'
    log(`${tag} ✓  ${r.name} — ${packages.length} pkgs, ${entry.topPackages.length} top, ${range}`)
  }

  log(`[3/3] Done. Built ${entries.length} entries, skipped ${skipped.length}.`)
  if (skipped.length > 0) {
    const counts = skipped.reduce<Record<string, number>>((acc, s) => { acc[s.reason] = (acc[s.reason] ?? 0) + 1; return acc }, {})
    log(`     Skip reasons: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }

  return { entries, skipped }
}

export const COMPACT_OUTPUT_DIR = path.join(process.cwd(), 'scripts', 'output')
export const COMPACT_OUTPUT_PATH = path.join(COMPACT_OUTPUT_DIR, 'restaurant-compact.json')

/**
 * Write the compact entries to scripts/output/restaurant-compact.json. Returns
 * the path + size. Throws on a read-only filesystem (e.g. Vercel serverless —
 * see the note at the top of this file).
 */
export function writeCompactFile(entries: CompactEntry[]): { path: string; sizeKb: number } {
  if (!fs.existsSync(COMPACT_OUTPUT_DIR)) fs.mkdirSync(COMPACT_OUTPUT_DIR, { recursive: true })
  fs.writeFileSync(COMPACT_OUTPUT_PATH, JSON.stringify(entries))
  const sizeKb = Math.round(fs.statSync(COMPACT_OUTPUT_PATH).size / 1024)
  return { path: COMPACT_OUTPUT_PATH, sizeKb }
}
