/**
 * Which BRAND does a location belong to?
 *
 * Multi-unit links are per brand (Peter, 2026-09-08), but FM's group is a
 * FRANCHISEE group and can span brands: /metairie holds three Fat Boy's Pizza
 * and three Savvy Sliders. FM has no brand field anywhere on the restaurant
 * record — checked: reference, businessName, restaurantConnectToStripe,
 * onlineOrderingAllowed, deliveryAllowed, deliveryType, timezone, address,
 * image, marketplaceImage, businessNameWithoutSpaces, itemCategories,
 * menuCategories, feeCategories, restaurantCategories, fulfillmentOptions,
 * type, deliveryOrderTimeWindows, enableMenuSearch. Nothing brand-shaped.
 *
 * Logos looked promising and are not: FM's image `name` is a shared storage
 * key, so a brand sharing one logo file would be detectable — but every
 * location has a distinct key, including the three Fat Boy's.
 *
 * So brand resolves in three steps, most trustworthy first:
 *   1. FM's `businessNameWithoutSpaces` when it carries a `<brand>-<location>`
 *      hyphen. FM's own data. Covers 94 of 342 (27%), and crucially it is what
 *      unifies 3 Pepper Burrito Co.'s nine Florida locations, whose display
 *      names spell the city four different ways with two dash characters and
 *      sometimes no separator at all.
 *   2. Longest-common-prefix clustering WITHIN one FM group. Safe only because
 *      the candidate set is one franchisee's 2-13 locations rather than the
 *      fleet; the same technique fleet-wide is what split 3 Pepper four ways.
 *   3. An explicit override. Some brands have to be set by hand and that is
 *      accepted — see data/brand-overrides.json.
 */

/** FM's own brand token, when businessNameWithoutSpaces carries the boundary. */
export function fmBrandToken(businessNameWithoutSpaces: string | null | undefined): string | null {
  if (!businessNameWithoutSpaces || !businessNameWithoutSpaces.includes('-')) return null
  const token = businessNameWithoutSpaces.split('-').slice(0, -1).join('-').trim().toLowerCase()
  return token || null
}

export const normalizeName = (n: string) =>
  n.split(/\s[-–—]\s/)[0].trim().toLowerCase().replace(/[^a-z0-9]/g, '')

export function longestCommonPrefix(a: string, b: string): string {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.slice(0, i)
}

/**
 * Agglomerative clustering by shared prefix, via union-find.
 *
 * Union-find rather than a single greedy pass: a greedy pass merges A into B
 * and then never reconsiders, which fragmented Taim into nine "brands"
 * (`taimp`, `taimf`, `taimcityspire`…) because each merge shortened the key
 * that later names were compared against. Union-find is order-independent.
 *
 * MIN_PREFIX is 4 because that is what `taim` needs. It is short, and it is
 * only safe because this runs inside one franchisee group — across the fleet a
 * 4-character prefix would merge unrelated businesses constantly.
 */
const MIN_PREFIX = 4
export function clusterByPrefix<T>(items: T[], keyOf: (t: T) => string): Map<string, T[]> {
  const keys = items.map(keyOf)
  const parent = keys.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (longestCommonPrefix(keys[i], keys[j]).length >= MIN_PREFIX) union(i, j)
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < keys.length; i++) {
    const r = find(i)
    groups.set(r, [...(groups.get(r) ?? []), i])
  }
  const out = new Map<string, T[]>()
  for (const idxs of groups.values()) {
    const token = idxs.map(i => keys[i]).reduce((a, b) => longestCommonPrefix(a, b))
    out.set(token || keys[idxs[0]], idxs.map(i => items[i]))
  }
  return out
}

export interface BrandMember { ref: string; name: string; bnws?: string | null }

/**
 * Split one FM group's members into brands. `overrides` maps a restaurant
 * reference to a brand key and wins over everything.
 */
export function splitGroupIntoBrands(
  members: BrandMember[],
  overrides: Record<string, string> = {},
): Map<string, BrandMember[]> {
  const out = new Map<string, BrandMember[]>()
  const push = (k: string, m: BrandMember) => out.set(k, [...(out.get(k) ?? []), m])

  const remaining: BrandMember[] = []
  for (const m of members) {
    const ov = overrides[m.ref]
    if (ov) { push(ov, m); continue }
    const fm = fmBrandToken(m.bnws)
    if (fm) { push(fm, m); continue }
    remaining.push(m)
  }
  for (const [token, ms] of clusterByPrefix(remaining, m => normalizeName(m.name))) {
    for (const m of ms) push(token, m)
  }
  return out
}
