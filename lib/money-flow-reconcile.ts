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
  before: string
  after: string
  dangerous: boolean // DIRECT -> FAMILY_MEAL: the direction that can block a legitimate promo
}

export interface MoneyFlowReconcileResult {
  total: number
  matched: number
  flipped: number
  errored: number
  flips: MoneyFlowFlip[]
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
  `) as { restaurant_reference: string; money_flow: string; name: string | null }[]

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
          await sql`
            UPDATE disco_restaurant_overrides SET money_flow = ${live}, updated_at = NOW()
            WHERE restaurant_reference = ${row.restaurant_reference}
          `
          flips.push({
            restaurantReference: row.restaurant_reference, name: row.name,
            before: row.money_flow, after: live,
            dangerous: row.money_flow === 'DIRECT' && live === 'FAMILY_MEAL',
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
    const lines = flips.map(f =>
      `• ${f.name || f.restaurantReference} (${f.restaurantReference}): ${f.before} → ${f.after}${f.dangerous ? ' ⚠ dangerous direction — blocks restaurant-funded promos at validate until this correction' : ''}`,
    ).join('\n')
    await alertOps(
      `money-flow-reconcile: corrected ${flips.length} stale money_flow value(s) out of ${rows.length} checked${dangerousCount ? ` (${dangerousCount} were the dangerous DIRECT→FAMILY_MEAL direction)` : ''}:\n${lines}`,
    )
  }

  return { total: rows.length, matched, flipped: flips.length, errored, flips, durationMs: Date.now() - startedAt }
}
