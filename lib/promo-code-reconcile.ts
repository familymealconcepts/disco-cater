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
// ── FM-BACKED RESTAURANTS ONLY, AND THAT IS THE WHOLE POINT ─────────────────
// Converting a restaurant to Disco-native means Disco Cater owns its promo
// codes. FamilyMeal's coupon is then a SNAPSHOT from before conversion that
// nothing updates, so comparing a native restaurant against it does not detect
// drift — it reports the conversion itself, every morning, forever. Confirmed
// with Peter: Atlanta Bread - Decatur's CATERING10 is 10% in Disco and 100% in
// FM, and DISCO IS CORRECT. 15 of the 28 drifts this reported were native
// restaurants and every one of them was this.
//
// There is nothing to reconcile a native restaurant's codes AGAINST: Disco is
// the only writer and the only reader, so a mismatch with FM is not a fact
// about Disco's data. They are excluded from the query, not just from the
// alert.
//
// ── DATES ARE COMPARED IN THE RESTAURANT'S OWN TIMEZONE ─────────────────────
// This reported a one-day end-date drift on EVERY remaining restaurant — 13 of
// 13 FM-backed. Not a timezone read on one side: a unit mismatch. Neon's
// valid_until is the last INSTANT of the last valid day in the restaurant's
// local time (Pete's Bagels - Ybor: 2027-01-01 04:59:59.999+00, which is
// 2026-12-31 23:59:59.999 Eastern), while FM's endDate is that day's CALENDAR
// DATE, 2026-12-31. Rendering the instant in UTC rolled it to the next day.
//
// localDate renders in disco_restaurant_cache.timezone, the zone the value was
// written in, which also handles the non-Eastern rows correctly — Bertolone's
// stores 05:59:59.999+00, right for Central, wrong for Eastern. With this,
// those 13 drifts become 13 matches and 0 drifts.
//
// Scoped to the ~40-50 restaurants that currently have an ACTIVE,
// restaurant-funded promo code — not the full ~1,058-restaurant reachable
// population the tax/notifications/closed-days mechanism covers. Checking
// every reachable restaurant daily for a promo code most of them will never
// have is the wrong cost/value trade for this field; the moment a
// restaurant activates its first native promo code, it enters this set
// automatically (the query is live, not a fixed list).
import { createHash } from 'crypto'
import { sql } from './db'
import { readWalledFieldsForRestaurants } from './fm-master-admin-read'
import { alertOnce } from './ops-alert'

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
  timezone: string | null
  code: string
  discount_value: string
  valid_from: string | Date | null
  valid_until: string | Date | null
  max_uses: number | null
  max_uses_per_user: number
}

/**
 * The calendar date a stored instant represents IN THE RESTAURANT'S OWN
 * TIMEZONE — the zone it was written in — so it can be compared to FM's plain
 * "YYYY-MM-DD".
 *
 * This is not a fudge factor, and the distinction matters because the previous
 * comment here argued against one. It does not widen the comparison or tolerate
 * a day either side: it converts one side into the other's unit before an exact
 * compare. A genuine multi-day drift (Francesca Elmwood Park's FRAN10, off by
 * three years) still reports at its full size. What stops reporting is the
 * artifact of reading 2026-12-31 23:59:59.999 Eastern as "2027-01-01".
 */
function localDate(v: string | Date | null, timezone: string | null): string | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) return null
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  // en-CA gives YYYY-MM-DD. An unknown/absent zone falls back to Eastern, which
  // is what the writer defaulted to; never throw a reconciler over a bad zone.
  try { return fmt(timezone || 'America/New_York') } catch { return fmt('America/New_York') }
}

export async function reconcilePromoCodes(): Promise<PromoCodeReconcileResult> {
  const startedAt = Date.now()

  // is_disco_native = false ONLY. A converted restaurant's codes are Disco's own
  // and FM's copy is a pre-conversion snapshot — see the header. An INNER JOIN,
  // deliberately: a promo row whose restaurant is not in the cache at all cannot
  // be shown to be FM-backed, and this job only makes claims about FM-backed ones.
  const rows = (await sql`
    SELECT p.restaurant_reference, c.name, c.timezone, p.code, p.discount_value, p.valid_from, p.valid_until, p.max_uses, p.max_uses_per_user
    FROM (
      SELECT restaurant_ref AS restaurant_reference, code, discount_value, valid_from, valid_until, max_uses, max_uses_per_user
      FROM promo_codes
      WHERE active = true AND funded_by = 'RESTAURANT' AND scope = 'restaurant' AND restaurant_ref IS NOT NULL
    ) p
    JOIN disco_restaurant_cache c ON c.restaurant_reference = p.restaurant_reference
    WHERE COALESCE(c.is_disco_native, false) = false
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
      validFrom: localDate(row.valid_from, row.timezone), validUntil: localDate(row.valid_until, row.timezone),
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

  // ── ONE LINE, AND ONLY WHEN THE SET CHANGES ───────────────────────────────
  // This posted 27 bullet lines every morning: one per drifting restaurant, with
  // code names, both sides' values and date comparisons. A channel is for
  // noticing, not for reading a report — the same list re-posted daily stops
  // being read at all, which is the failure mode that hides the 28th entry.
  //
  // The detail is not lost. It is on the returned PromoCodeReconcileResult, and
  // logged in full below, so the cron response and the function log both carry
  // it for anyone who goes looking.
  //
  // KEYED ON THE SET, so the same restaurants do not re-alert tomorrow and a new
  // one does. Sorted references, hashed: the key must change when membership
  // changes and must NOT change when only a value inside a drift moves, because
  // that is the same restaurants still drifting — already reported, still true.
  if (drifts.length > 0) {
    const detail = drifts
      .map(d => `${d.restaurantName || d.restaurantReference} (${d.restaurantReference}) [${d.kind}]: ${d.detail}`)
      .join('\n')
    console.warn(`[promo-code-reconcile] ${drifts.length} drift(s) of ${rows.length} checked:\n${detail}`)

    const fingerprint = createHash('sha256')
      .update(drifts.map(d => d.restaurantReference).sort().join(','))
      .digest('hex')
      .slice(0, 16)
    await alertOnce(
      `promo-code-reconcile:${fingerprint}`,
      `promo-code-reconcile: ${drifts.length} promo code drift(s) against FamilyMeal across ${rows.length} FM-backed restaurant-funded code(s). Details are in the cron log.`,
    )
  }

  return { total: rows.length, matched, drifted: drifts.length, errored, drifts, durationMs: Date.now() - startedAt }
}
