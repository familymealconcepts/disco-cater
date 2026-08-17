// Shared core for regenerating scripts/output/restaurant-compact.json — the
// enriched restaurant data the AI assistant (app/api/disco-chat/route.ts)
// reads at cold start. Both the CLI script
// (scripts/generateRestaurantCompact.ts) and the automation routes
// (app/api/cron/regenerate-compact, app/api/webhooks/sanity-restaurant) import
// this so the generation logic lives in exactly one place.
//
// Shape per entry MUST stay identical to what disco-chat reads:
//   { name, pricePerPerson:{min,max}, offersDelivery, serviceRadiusMiles,
//     eventTypes, topPackages:[{name, serves, pricePerPerson}] }
//
// Source of the restaurant list: Neon disco_restaurant_cache, restricted to
// the same public-marketplace visibility rule as /api/restaurants (the
// fullmap feed) — the AI assistant shouldn't describe restaurants that aren't
// actually orderable. restaurant_reference IS the FM reference already (no
// slug-guessing/resolution step needed, unlike the old Sanity-sourced path).
//
// Two write paths:
//   • writeCompactFile() — writes to the project tree (scripts/output). Used by
//     the CLI script for local runs. On Vercel's serverless runtime the
//     deployment filesystem is READ-ONLY, so this throws there.
//   • commitCompactToGitHub() — commits the JSON back to the repo via the GitHub
//     API, which triggers a Vercel redeploy that bundles the fresh file. This is
//     the production path used by the cron + webhook routes (the only way the
//     regenerated data reaches disco-chat, which reads the bundled file at cold
//     start). The format + disco-chat are intentionally untouched here.

import * as fs from 'fs'
import * as path from 'path'
import { getMarketplaceRestaurants } from './marketplace-restaurants'

const DEFAULT_FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const DEFAULT_DELAY_MS = 1000 // ~1 req/sec to FM, per spec

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

interface NeonRestaurant { name: string; restaurantReference: string }
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

async function fmGet<T>(fmBase: string, urlPath: string): Promise<T | null> {
  try {
    const res = await fetch(`${fmBase}${urlPath}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
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
  log('[1/3] Fetching live marketplace restaurant list from Neon…')

  // Same public-marketplace visibility rule as /api/restaurants (the fullmap
  // feed), the city pages, the /restaurants directory, and the sitemap —
  // shared via lib/marketplace-restaurants.ts rather than a 5th copy of the
  // WHERE clause. This is exactly how this file ended up with a stale,
  // archived_at-less copy in the first place: the AI assistant kept
  // describing archived restaurants as orderable until this was fixed.
  const rows: NeonRestaurant[] = (await getMarketplaceRestaurants())
    .filter((r) => !!r.name)
    .map((r) => ({ name: r.name, restaurantReference: r.reference }))
  log(`     ${rows.length} live marketplace restaurants`)

  const targets = rows.slice(0, limit)
  log(`[2/3] Fetching packages for ${targets.length} restaurants…`)

  const entries: CompactEntry[] = []
  const skipped: { name: string; reason: string }[] = []
  let i = 0
  for (const r of targets) {
    i++
    const tag = `[${i}/${targets.length}]`

    const packages = await fetchPackagesForRestaurant(fmBase, r.restaurantReference, delay)
    if (packages.length === 0) {
      log(`${tag} ⏭  ${r.name} — FM ref=${r.restaurantReference} but no packages`)
      skipped.push({ name: r.name, reason: 'no-packages' }); continue
    }

    // KEY: use the Neon name as the entry name so disco-chat's name match
    // (client-sent restaurant.name === compact.name, case-insensitive trim) hits.
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

const GITHUB_REPO = 'familymealconcepts/disco-cater'
// Path within the repo (NOT the absolute COMPACT_OUTPUT_PATH, which is CWD-based).
const COMPACT_REPO_PATH = 'scripts/output/restaurant-compact.json'

/**
 * Commit the regenerated compact JSON back to the repo via the GitHub Contents
 * API. This is the production write path: the commit to `main` triggers a Vercel
 * redeploy that bundles the fresh file, which disco-chat then reads at cold
 * start (the serverless FS is read-only, so writeCompactFile can't be used).
 *
 * Requires env GITHUB_TOKEN (a PAT with `repo` / contents:write scope on
 * familymealconcepts/disco-cater). `[skip ci]` in the message keeps it from
 * triggering CI workflows — only Vercel's deploy hook fires.
 */
export async function commitCompactToGitHub(
  entries: CompactEntry[],
): Promise<{ success: true; sha?: string; skipped?: boolean; reason?: string }> {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is not set')

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${COMPACT_REPO_PATH}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'disco-cater-compact-regen',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  const newJson = JSON.stringify(entries)

  // 1. Current file SHA + content. SHA is required to UPDATE an existing file;
  //    content lets us skip a no-op commit when nothing changed. 404 → create.
  let sha: string | undefined
  let currentJson: string | null = null
  const getRes = await fetch(`${apiUrl}?ref=main`, { headers })
  if (getRes.ok) {
    const cur = await getRes.json()
    sha = cur?.sha
    // Contents API returns base64 (with embedded newlines) for files < 1MB.
    if (typeof cur?.content === 'string' && cur.content) {
      try { currentJson = Buffer.from(cur.content, 'base64').toString('utf8') } catch { currentJson = null }
    }
  } else if (getRes.status !== 404) {
    const body = await getRes.text().catch(() => '')
    throw new Error(`GitHub GET contents failed (${getRes.status}): ${body.slice(0, 300)}`)
  }

  // Skip the commit (and the redeploy it would trigger) when the regenerated
  // output is byte-identical to what's already in the repo.
  if (currentJson !== null && currentJson === newJson) {
    return { success: true, skipped: true, reason: 'no changes' }
  }

  // 2. PUT the new content (base64). Same compact format writeCompactFile emits.
  const content = Buffer.from(newJson, 'utf8').toString('base64')
  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'chore: regenerate restaurant-compact.json [skip ci]',
      content,
      ...(sha ? { sha } : {}),
      branch: 'main',
    }),
  })
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => '')
    throw new Error(`GitHub PUT contents failed (${putRes.status}): ${body.slice(0, 300)}`)
  }
  const out = await putRes.json()
  // commit.sha = the redeploy-triggering commit; content.sha = the new blob SHA.
  return { success: true, sha: out?.commit?.sha || out?.content?.sha || '' }
}
