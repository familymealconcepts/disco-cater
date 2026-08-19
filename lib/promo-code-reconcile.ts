// Daily cron: reconcile restaurant-funded promo codes against FM's live
// coupon. Same root cause as lib/money-flow-reconcile.ts (a value written
// once, never re-synced, that silently drifts) but a different shape:
// FM's coupon isn't a toggle a Disco admin ever sets — it's entered directly
// on FM's own portal (one coupon per restaurant, replaceable, with its own
// "End" button there), so Neon has no path that would ever notice FM
// replacing or ending one. Confirmed real, not hypothetical: three
// restaurants (Hugo's Studio City, Hugo's Tacos ×2) had a live FM coupon
// Neon didn't know about within WEEKS of the original migration, discovered
// only because someone happened to look.
//
// ALERT-ONLY, deliberately — unlike money-flow-reconcile, this does not
// write anything. A promo code is customer-facing and the "correct" fix
// (deactivate the stale row, add the new one, keep history) is exactly what
// was just done by hand for Hugo's; auto-applying that unattended, on a
// mechanism that hasn't run more than once, is a heavier bet than the
// money_flow column deserves. Revisit once this has alerted a few times
// without surprises.
//
// Scoped to the ~40-50 restaurants that currently have an ACTIVE,
// restaurant-funded promo code — not the full ~1,058-restaurant reachable
// population the tax/notifications/closed-days mechanism covers. Checking
// every reachable restaurant daily for a promo code most of them will never
// have is the wrong cost/value trade for this field; the moment a
// restaurant activates its first native promo code, it enters this set
// automatically (the query is live, not a fixed list).
import { sql } from './db'
import { readWalledFieldsForRestaurants } from './fm-master-admin-read'
import { alertOps } from './ops-alert'

export type PromoDriftKind = 'fm-has-code-neon-does-not' | 'neon-has-stale-code' | 'value-mismatch'

export interface PromoCodeDrift {
  restaurantReference: string
  restaurantName: string | null
  kind: PromoDriftKind
  neon: { code: string; discountPct: number; validFrom: string | null; validUntil: string | null; maxUses: number | null; maxUsesPerUser: number } | null // dates normalized to "YYYY-MM-DD" via dateOnly
  fm: { code: string; discountPct: number; startDate: string | null; endDate: string | null; maxAvailable: number | null; maxPerDiner: number | null } | null
  detail: string
}

export interface PromoCodeReconcileResult {
  total: number
  matched: number
  drifted: number
  errored: number
  drifts: PromoCodeDrift[]
  durationMs: number
}

interface NeonPromoRow {
  restaurant_reference: string
  name: string | null
  code: string
  discount_value: string
  valid_from: string | Date | null
  valid_until: string | Date | null
  max_uses: number | null
  max_uses_per_user: number
}

// Date-only string compare — Neon's driver returns timestamptz columns as
// Date objects (not strings — confirmed live, this threw on the first real
// run), FM sends plain "YYYY-MM-DD". Deliberately NOT timezone-tolerant: a
// fudge factor here would risk masking a real multi-day drift (Elmwood
// Park's FRAN10 was off by three years) the same way it would absorb a
// one-day artifact. Report the literal (UTC) difference; a human decides
// which this is.
function dateOnly(v: string | Date | null): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

export async function reconcilePromoCodes(): Promise<PromoCodeReconcileResult> {
  const startedAt = Date.now()

  const rows = (await sql`
    SELECT p.restaurant_reference, c.name, p.code, p.discount_value, p.valid_from, p.valid_until, p.max_uses, p.max_uses_per_user
    FROM (
      SELECT restaurant_ref AS restaurant_reference, code, discount_value, valid_from, valid_until, max_uses, max_uses_per_user
      FROM promo_codes
      WHERE active = true AND funded_by = 'RESTAURANT' AND scope = 'restaurant' AND restaurant_ref IS NOT NULL
    ) p
    LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = p.restaurant_reference
  `.catch(() => [])) as NeonPromoRow[]

  if (rows.length === 0) {
    return { total: 0, matched: 0, drifted: 0, errored: 0, drifts: [], durationMs: Date.now() - startedAt }
  }

  const refs = rows.map(r => r.restaurant_reference)
  const walledMap = await readWalledFieldsForRestaurants(refs)

  let matched = 0
  let errored = 0
  const drifts: PromoCodeDrift[] = []

  for (const row of rows) {
    const w = walledMap.get(row.restaurant_reference)
    if (!w?.ok) { errored++; continue }

    const fm = w.promoCode
    const neon = {
      code: row.code, discountPct: Number(row.discount_value),
      validFrom: dateOnly(row.valid_from), validUntil: dateOnly(row.valid_until),
      maxUses: row.max_uses, maxUsesPerUser: row.max_uses_per_user,
    }

    if (!fm) {
      drifts.push({
        restaurantReference: row.restaurant_reference, restaurantName: row.name,
        kind: 'neon-has-stale-code', neon, fm: null,
        detail: `Neon has active code ${row.code} (${neon.discountPct}%) but FM reports no coupon configured for this restaurant at all — likely ended on FM's side.`,
      })
      continue
    }

    const fmShaped = {
      code: fm.code || '', discountPct: Number(fm.discountPercentage ?? NaN),
      startDate: fm.startDate ?? null, endDate: fm.endDate ?? null,
      maxAvailable: fm.maxAvailable ?? null, maxPerDiner: fm.maxPerDiner ?? null,
    }

    const codeDiffers = neon.code.trim().toUpperCase() !== fmShaped.code.trim().toUpperCase()
    if (codeDiffers) {
      drifts.push({
        restaurantReference: row.restaurant_reference, restaurantName: row.name,
        kind: 'fm-has-code-neon-does-not', neon, fm: fmShaped,
        detail: `FM's live coupon is ${fmShaped.code} (${fmShaped.discountPct}%, ${fmShaped.startDate}–${fmShaped.endDate}) — Neon's active code is a different one, ${neon.code} (${neon.discountPct}%). Neon's is stale.`,
      })
      continue
    }

    // Same code — check every value FM's coupon carries.
    const mismatches: string[] = []
    if (!Number.isNaN(fmShaped.discountPct) && Math.abs(fmShaped.discountPct - neon.discountPct) > 0.01) {
      mismatches.push(`discount: Neon ${neon.discountPct}% vs FM ${fmShaped.discountPct}%`)
    }
    if (neon.validFrom !== fmShaped.startDate) {
      mismatches.push(`start date: Neon ${neon.validFrom} vs FM ${fmShaped.startDate}`)
    }
    if (neon.validUntil !== fmShaped.endDate) {
      mismatches.push(`end date: Neon ${neon.validUntil} vs FM ${fmShaped.endDate}`)
    }
    if (fmShaped.maxAvailable != null && neon.maxUses !== fmShaped.maxAvailable) {
      mismatches.push(`max uses: Neon ${neon.maxUses ?? 'unlimited'} vs FM ${fmShaped.maxAvailable}`)
    }
    if (fmShaped.maxPerDiner != null && neon.maxUsesPerUser !== fmShaped.maxPerDiner) {
      mismatches.push(`max per diner: Neon ${neon.maxUsesPerUser} vs FM ${fmShaped.maxPerDiner}`)
    }

    if (mismatches.length > 0) {
      drifts.push({
        restaurantReference: row.restaurant_reference, restaurantName: row.name,
        kind: 'value-mismatch', neon, fm: fmShaped,
        detail: `Code ${row.code} matches by name but differs: ${mismatches.join('; ')}.`,
      })
    } else {
      matched++
    }
  }

  if (drifts.length > 0) {
    const lines = drifts.map(d => `• ${d.restaurantName || d.restaurantReference} (${d.restaurantReference}) [${d.kind}]: ${d.detail}`).join('\n')
    await alertOps(
      `promo-code-reconcile: ${drifts.length} drift(s) found out of ${rows.length} active restaurant-funded code(s) checked (report only, nothing changed):\n${lines}`,
    )
  }

  return { total: rows.length, matched, drifted: drifts.length, errored, drifts, durationMs: Date.now() - startedAt }
}
