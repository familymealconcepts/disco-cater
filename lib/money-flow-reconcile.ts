import { sql } from './db'
import { getFmServiceAuthHeader } from './fm-service-auth'
import { alertOps } from './ops-alert'

// Reconciles disco_restaurant_overrides.money_flow against FM's live moneyFlow.
// money_flow is written exactly once, as a side effect of the admin ordering
// page's "Hold Payments on FamilyMeal" toggle (app/api/admin/restaurants/[ref]/
// money-flow/route.ts) — it is NOT an ongoing sync, so any change on FM's side
// that doesn't go through that one toggle (FM's own admin panel, an FM-side
// process) leaves Neon stale indefinitely. A fleet-wide check found 9/4360
// restaurants disagreeing with FM's live value. This is the daily job that
// keeps it correct going forward, same shape as lib/restaurant-cache.ts's
// refreshRestaurantCache — one FM call per restaurant, this time the
// per-restaurant detail endpoint (not the list endpoint, which has a known low
// concurrency ceiling — this one tolerated concurrency 15-16 cleanly in two
// separate live fleet sweeps), so modest concurrency here is safe.
//
// ── THE NULL BLIND SPOT, FIXED 2026-09-01 ──────────────────────────────────
// The original query said `WHERE o.money_flow IS NOT NULL`, which made the 78
// NULL rows permanently uncorrectable — the one population that most needed a
// value, since a NULL is not a stale value but no value at all. FM had a real
// moneyFlow for 50 of them. Same shape as the online_ordering_enabled gap (see
// lib/online-ordering-mirror.ts): a column FM is authoritative for, with
// nothing carrying it.
//
// NULL rows are now included, but ONLY for FM-BACKED restaurants. Per the
// standing rule (FM authoritative pre-conversion, Disco after), filling an
// FM-backed NULL from FM is a mirror correction rather than a judgment. A NULL
// on a DISCO-NATIVE row is a different question: Disco owns that value, most of
// those restaurants have no FM record to read at all, and inventing one is not
// this job's call. Those are counted and returned as `nativeNulls` for a human
// to decide, never written.
//
// Alerts (never silently corrects without saying so) on every flip found —
// DIRECT → FAMILY_MEAL is the dangerous direction: it's what
// app/api/promo/validate/route.ts and lib/promo-apply.ts's preview path read
// to gate restaurant-funded (DIRECT-only) promos, and neither has a live
// fallback the way charge-time settlement does — a stale FAMILY_MEAL value
// silently blocks a legitimate promo at validate time, which nobody would
// report as a bug, they'd just think the promo code doesn't work.

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const CONCURRENCY = 20

export interface MoneyFlowFlip {
  restaurantReference: string
  name: string | null
  /** null = the row had NO value and is being FILLED, not corrected. */
  before: string | null
  after: string
  dangerous: boolean // DIRECT -> FAMILY_MEAL: the direction that can block a legitimate promo
  /** true when `before` was NULL — a fill of the former blind spot. */
  filled: boolean
}

/** A disco-native row with no money_flow. Reported, never written — see header. */
export interface NativeNullRow {
  restaurantReference: string
  name: string | null
  /** What FM says, if FM has a record at all. Usually absent for native-first restaurants. */
  fmValue: string | null
}

export interface MoneyFlowReconcileResult {
  total: number
  matched: number
  flipped: number
  /** Of `flipped`, how many were NULL→value fills rather than value corrections. */
  filled: number
  errored: number
  flips: MoneyFlowFlip[]
  /** Disco-native rows left NULL on purpose. Never written by this job. */
  nativeNulls: NativeNullRow[]
  durationMs: number
}

export async function reconcileMoneyFlow(): Promise<MoneyFlowReconcileResult> {
  const startedAt = Date.now()
  const auth = await getFmServiceAuthHeader()

  const rows = (await sql`
    SELECT o.restaurant_reference, o.money_flow, c.name
    FROM disco_restaurant_overrides o
    LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference
    WHERE o.money_flow IS NOT NULL
       OR COALESCE(c.is_disco_native, false) = false
  `) as { restaurant_reference: string; money_flow: string | null; name: string | null }[]

  // Reported, not touched. Read from the admin-list cache rather than a per-row FM
  // call — most of these have no FM record at all, so a fetch would just 404.
  const nativeNulls = (await sql`
    SELECT o.restaurant_reference, c.name, l.raw->>'moneyFlow' AS fm_value
    FROM disco_restaurant_overrides o
    JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference
    LEFT JOIN disco_restaurant_admin_list_cache l ON l.restaurant_reference = o.restaurant_reference
    WHERE o.money_flow IS NULL AND c.is_disco_native = true
    ORDER BY c.name
  `.catch(() => [])) as { restaurant_reference: string; name: string | null; fm_value: string | null }[]

  let matched = 0
  let errored = 0
  const flips: MoneyFlowFlip[] = []

  let idx = 0
  async function worker() {
    while (idx < rows.length) {
      const i = idx++
      const row = rows[i]
      try {
        const res = await fetch(`${FM}/api/admin/restaurants/${row.restaurant_reference}`, {
          headers: { ...auth, Accept: 'application/json' }, cache: 'no-store',
        })
        if (!res.ok) { errored++; continue }
        const d = await res.json().catch(() => null) as { moneyFlow?: string } | null
        const live = d?.moneyFlow ?? null
        if (!live) { errored++; continue }
        if (live !== row.money_flow) {
          const wasNull = row.money_flow == null
          await sql`
            UPDATE disco_restaurant_overrides SET money_flow = ${live}, updated_at = NOW()
            WHERE restaurant_reference = ${row.restaurant_reference}
          `
          flips.push({
            restaurantReference: row.restaurant_reference, name: row.name,
            before: row.money_flow, after: live,
            // A fill is never the dangerous direction: nothing was released before.
            dangerous: row.money_flow === 'DIRECT' && live === 'FAMILY_MEAL',
            filled: wasNull,
          })
        } else {
          matched++
        }
      } catch {
        errored++
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  if (flips.length > 0) {
    const dangerousCount = flips.filter(f => f.dangerous).length
    const filledCount = flips.filter(f => f.filled).length
    const lines = flips.map(f =>
      `• ${f.name || f.restaurantReference} (${f.restaurantReference}): ${f.before ?? 'NULL'} → ${f.after}${f.filled ? ' (fill — row had no value)' : ''}${f.dangerous ? ' ⚠ dangerous direction — blocks restaurant-funded promos at validate until this correction' : ''}`,
    ).join('\n')
    await alertOps(
      `money-flow-reconcile: wrote ${flips.length} money_flow value(s) out of ${rows.length} checked` +
      `${filledCount ? ` — ${filledCount} were FILLS of previously-NULL FM-backed rows` : ''}` +
      `${dangerousCount ? ` (${dangerousCount} were the dangerous DIRECT→FAMILY_MEAL direction)` : ''}` +
      `${nativeNulls.length ? `. ${nativeNulls.length} disco-native row(s) left NULL on purpose — Disco owns those` : ''}:\n${lines}`,
    )
  }

  return {
    total: rows.length, matched, flipped: flips.length,
    filled: flips.filter(f => f.filled).length,
    errored, flips,
    nativeNulls: nativeNulls.map(r => ({
      restaurantReference: r.restaurant_reference, name: r.name, fmValue: r.fm_value,
    })),
    durationMs: Date.now() - startedAt,
  }
}
