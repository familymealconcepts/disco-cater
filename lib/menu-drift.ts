// FM-side menu drift detection for Disco-native restaurants.
//
// A converted restaurant's native menu (lib/menu-import/fm-faithful-import.ts)
// is a one-time, frozen snapshot — there is no ongoing sync back to FM. If
// restaurant staff keep editing prices/items on FM's side out of habit, those
// changes are invisible to Disco customers and nothing has ever flagged it.
//
// This is READ-ONLY against FM and does not touch the native menu at all — it
// only compares FM's CURRENT item state (name/price/category/visible, per
// menu) against the state captured at last import/verification (the
// "baseline"), and records whether they've diverged. Visibility only: it never
// auto-re-imports or auto-fixes anything, so a human decides what to do next.
import { sql } from './db'
import { getFmServiceAuthHeader } from './fm-service-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const arrOf = (d: unknown): Record<string, unknown>[] => {
  if (Array.isArray(d)) return d as Record<string, unknown>[]
  const o = d as { content?: unknown; data?: unknown } | null
  return (Array.isArray(o?.content) ? o!.content : Array.isArray(o?.data) ? o!.data : []) as Record<string, unknown>[]
}
async function fmGet(path: string, auth: Record<string, string>): Promise<unknown> {
  const r = await fetch(`${FM}${path}`, { headers: { ...auth, Accept: 'application/json' } })
  if (!r.ok) return null
  return r.json().catch(() => null)
}
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const str = (v: unknown): string => (v == null ? '' : String(v))
const round2 = (n: number) => Math.round(n * 100) / 100

export interface FmMenuSnapshotItem {
  reference: string
  name: string
  price: number
  category: string
  menuName: string
  visible: boolean
}

// Same three FM endpoints the faithful importer reads (menus + flat item
// catalog + each menu's real per-menu category traversal), reduced to just the
// fields drift detection needs. Returns null when FM has no real record for
// this reference (nothing to compare against — not the same as "no drift").
export async function fetchFmMenuSnapshot(fmRef: string): Promise<FmMenuSnapshotItem[] | null> {
  let auth: Record<string, string>
  try { auth = await getFmServiceAuthHeader() } catch { return null }

  const fmMenus = arrOf(await fmGet(`/api/admin/menu?restaurantReference=${fmRef}&page=0&size=100`, auth))
  const fmItems = arrOf(await fmGet(`/api/restaurants/${fmRef}/mealPackages?page=0&size=1000`, auth))
  if (!fmMenus.length && !fmItems.length) return null

  const flatByRef = new Map<string, Record<string, unknown>>()
  for (const it of fmItems) { const r = str(it.reference); if (r) flatByRef.set(r, it) }

  const snapshot: FmMenuSnapshotItem[] = []
  const seen = new Set<string>()
  for (const m of fmMenus) {
    const menuRef = str(m.reference); if (!menuRef) continue
    const menuName = str(m.name) || 'Menu'
    const cats = arrOf(await fmGet(`/public-api/restaurants/${fmRef}/mealPackages?menuReference=${menuRef}`, auth))
    for (const c of cats) {
      const catName = str(c.name) || 'Menu'
      for (const pub of arrOf(c.mealPackages)) {
        const ref = str(pub.reference); if (!ref) continue
        const flat = flatByRef.get(ref) || {}
        snapshot.push({
          reference: ref,
          name: str(pub.name) || str(flat.name) || 'Item',
          price: round2(num(pub.price) || num(flat.price)),
          category: catName,
          menuName,
          visible: flat.visible !== false,
        })
        seen.add(ref)
      }
    }
  }
  // Fallback for items the per-menu traversal never surfaced (mirrors the
  // faithful importer's own fallback) — still worth tracking for drift even if
  // we can't place them precisely, so a genuinely-new item isn't missed.
  for (const it of fmItems) {
    const ref = str(it.reference)
    if (!ref || seen.has(ref)) continue
    snapshot.push({
      reference: ref,
      name: str(it.name) || 'Item',
      price: round2(num(it.price)),
      category: (typeof it.itemCategory === 'object' && it.itemCategory ? str((it.itemCategory as Record<string, unknown>).name) : str(it.itemCategory)) || 'Menu',
      menuName: '',
      visible: it.visible !== false,
    })
  }
  return snapshot
}

export interface DriftDetail {
  type: 'added' | 'removed' | 'price_changed' | 'category_changed' | 'renamed'
  reference: string
  name: string
  before?: string | number
  after?: string | number
}

function diffSnapshots(baseline: FmMenuSnapshotItem[], current: FmMenuSnapshotItem[]): DriftDetail[] {
  const baseByRef = new Map(baseline.map((i) => [i.reference, i]))
  const curByRef = new Map(current.map((i) => [i.reference, i]))
  const details: DriftDetail[] = []

  for (const cur of current) {
    const base = baseByRef.get(cur.reference)
    if (!base) { details.push({ type: 'added', reference: cur.reference, name: cur.name }); continue }
    if (base.price !== cur.price) {
      details.push({ type: 'price_changed', reference: cur.reference, name: cur.name, before: base.price, after: cur.price })
    }
    if (base.category !== cur.category) {
      details.push({ type: 'category_changed', reference: cur.reference, name: cur.name, before: base.category, after: cur.category })
    }
    if (base.name !== cur.name) {
      details.push({ type: 'renamed', reference: cur.reference, name: cur.name, before: base.name, after: cur.name })
    }
  }
  for (const base of baseline) {
    if (!curByRef.has(base.reference)) details.push({ type: 'removed', reference: base.reference, name: base.name })
  }
  return details
}

// Capture (or explicitly reset) the baseline a restaurant's future drift
// checks are compared against. Called right after a faithful FM→native import,
// and callable standalone as "I've reviewed the drift — re-baseline it."
export async function setMenuDriftBaseline(restaurantRef: string, fmRef: string): Promise<{ ok: boolean; itemCount?: number; error?: string }> {
  const { runMenuDriftMigrations } = await import('./db')
  await runMenuDriftMigrations()
  const snapshot = await fetchFmMenuSnapshot(fmRef)
  if (!snapshot) return { ok: false, error: 'No FM menu data returned for this restaurant.' }
  await sql`
    INSERT INTO disco_menu_drift_snapshots (restaurant_reference, baseline_snapshot, baseline_captured_at, has_drift, drift_details, last_checked_at, updated_at)
    VALUES (${restaurantRef}::uuid, ${JSON.stringify(snapshot)}::jsonb, NOW(), false, NULL, NOW(), NOW())
    ON CONFLICT (restaurant_reference) DO UPDATE
      SET baseline_snapshot = EXCLUDED.baseline_snapshot, baseline_captured_at = NOW(),
          has_drift = false, drift_details = NULL, last_checked_at = NOW(), updated_at = NOW()
  `
  return { ok: true, itemCount: snapshot.length }
}

export interface MenuDriftResult {
  checked: boolean
  hasDrift: boolean
  details: DriftDetail[]
  baselineCapturedAt?: string | null
  error?: string
}

// Compare FM's CURRENT menu against the stored baseline for one restaurant.
// If no baseline exists yet (never imported/verified through this system),
// the current FM state becomes the baseline — a first check establishes a
// starting point rather than reporting drift against nothing.
export async function checkMenuDrift(restaurantRef: string, fmRef: string): Promise<MenuDriftResult> {
  const { runMenuDriftMigrations } = await import('./db')
  await runMenuDriftMigrations()

  const current = await fetchFmMenuSnapshot(fmRef)
  if (!current) return { checked: false, hasDrift: false, details: [], error: 'No FM menu data returned for this restaurant.' }

  const rows = (await sql`
    SELECT baseline_snapshot, baseline_captured_at FROM disco_menu_drift_snapshots
    WHERE restaurant_reference = ${restaurantRef}::uuid LIMIT 1
  `) as { baseline_snapshot: FmMenuSnapshotItem[]; baseline_captured_at: string }[]

  if (!rows.length) {
    await sql`
      INSERT INTO disco_menu_drift_snapshots (restaurant_reference, baseline_snapshot, baseline_captured_at, has_drift, drift_details, last_checked_at, updated_at)
      VALUES (${restaurantRef}::uuid, ${JSON.stringify(current)}::jsonb, NOW(), false, NULL, NOW(), NOW())
    `
    return { checked: true, hasDrift: false, details: [], baselineCapturedAt: new Date().toISOString() }
  }

  const details = diffSnapshots(rows[0].baseline_snapshot, current)
  const hasDrift = details.length > 0
  await sql`
    UPDATE disco_menu_drift_snapshots
    SET has_drift = ${hasDrift}, drift_details = ${hasDrift ? JSON.stringify(details) : null}::jsonb, last_checked_at = NOW(), updated_at = NOW()
    WHERE restaurant_reference = ${restaurantRef}::uuid
  `
  return { checked: true, hasDrift, details, baselineCapturedAt: rows[0].baseline_captured_at }
}

export interface MenuDriftStatus {
  hasBaseline: boolean
  hasDrift: boolean
  details: DriftDetail[]
  lastCheckedAt: string | null
  baselineCapturedAt: string | null
}

// Cheap read of the stored drift status — no FM call. Used by the admin list
// badge and detail panel.
export async function getMenuDriftStatus(restaurantRef: string): Promise<MenuDriftStatus> {
  const { runMenuDriftMigrations } = await import('./db')
  await runMenuDriftMigrations()
  const rows = (await sql`
    SELECT has_drift, drift_details, last_checked_at, baseline_captured_at
    FROM disco_menu_drift_snapshots WHERE restaurant_reference = ${restaurantRef}::uuid LIMIT 1
  `.catch(() => [])) as { has_drift: boolean; drift_details: DriftDetail[] | null; last_checked_at: string | null; baseline_captured_at: string | null }[]
  const row = rows[0]
  return {
    hasBaseline: !!row,
    hasDrift: row?.has_drift ?? false,
    details: row?.drift_details ?? [],
    lastCheckedAt: row?.last_checked_at ?? null,
    baselineCapturedAt: row?.baseline_captured_at ?? null,
  }
}
