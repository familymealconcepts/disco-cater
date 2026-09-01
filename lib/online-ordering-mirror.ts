import { sql } from './db'
import { alertOps } from './ops-alert'

// Mirrors disco_restaurant_overrides.online_ordering_enabled from FM's
// onlineOrderingAllowed for every FM-BACKED restaurant.
//
// ── THE RULE THIS ENCODES ──────────────────────────────────────────────────
// FM is the source of truth before conversion; Disco owns the value after. So
// while a restaurant is FM-backed its Neon flag is a MIRROR with no independent
// authority, and the moment convertToNative sets is_disco_native = true
// (lib/native-conversion.ts) it becomes Disco's own and this job must never
// touch it again. That is the entire WHERE clause below.
//
// ── WHY IT DRIFTED ─────────────────────────────────────────────────────────
// The column was added as a "Disco-side mirror of FM's onlineOrderingAllowed"
// (lib/db.ts) but nothing ever mirrored it. The bulk import wrote `false`
// fleet-wide — note it wrote a value rather than leaving the column's
// DEFAULT true unset, which is why the false-dominance never looked anomalous —
// and after that the only writers were humans clicking a toggle. Measured live
// against FM's 4,382 restaurants: 4,052 comparable, 3,727 agreeing, 296 where
// FM says true and Neon says false (186 of those take real orders), and 29 in
// the other direction where FM says false and Neon says true.
//
// ── WHY THIS IS SAFE TO RUN, INCLUDING THE 29 ──────────────────────────────
// No FM-backed gate reads this column. lib/restaurant-orderable.ts only
// suppresses ordering when `isDiscoNative && onlineOrderingEnabled === false`,
// and lib/marketplace-restaurants.ts deliberately applies a 2-part rule to
// FM-backed rows for exactly this reason (the column being a stale default was
// already known there; a real mirror was the tracked follow-up, and this is it).
// So correcting an FM-backed row in EITHER direction changes nothing a customer
// can see today. What it changes is conversion: native-conversion.ts's
// readiness gate reads `online_ordering_enabled !== false`, so a stale false is
// what makes a perfectly healthy FM restaurant report not-ready — the symptom
// hit at both Gracious Cafe and Bakery locations.
//
// ── WHY IT READS A NEON TABLE AND NOT FM ───────────────────────────────────
// disco_restaurant_admin_list_cache already stores FM's RAW admin-list JSON for
// all 4,382 restaurants and refresh-restaurant-admin-list rebuilds it every 15
// minutes, so onlineOrderingAllowed is already local. That makes this a
// Neon-to-Neon UPDATE: no FM call, no auth, no concurrency worker, no timeout.
//
// It must NOT be folded into sync-restaurants instead, for two reasons. That
// cron is daily, and its upsert only writes disco_restaurant_cache. More
// importantly lib/restaurant-cache.ts's normalize() drops every non-ACCEPTED or
// blocked row, and FM couples `blocked` to `onlineOrderingAllowed`
// bidirectionally — so a mirror living in that loop would fix the safe
// direction and silently skip the risky one. The raw cache is unfiltered and
// carries blocked restaurants, which is what makes it the correct source.
//
// ── ALERTS, NEVER A SILENT CORRECTION ──────────────────────────────────────
// Same posture as lib/money-flow-reconcile.ts: every flip is reported. The
// true → false direction is called out separately because it is the one that
// takes ordering AWAY at conversion, even though it is inert until then.

/** A restaurant whose FM-backed mirror value was corrected. */
export interface OnlineOrderingFlip {
  restaurantReference: string
  name: string | null
  before: boolean | null
  after: boolean
  /** true → false: the direction that removes ordering once the restaurant converts. */
  dangerous: boolean
}

export interface OnlineOrderingMirrorResult {
  /** FM-backed, un-archived rows with a usable FM value to compare against. */
  comparable: number
  matched: number
  flipped: number
  /** FM-backed rows whose FM value was absent or non-boolean — left untouched. */
  skippedNoFmValue: number
  /** Native rows deliberately excluded: Disco owns these. */
  skippedNative: number
  flips: OnlineOrderingFlip[]
  durationMs: number
}

interface CandidateRow {
  restaurant_reference: string
  name: string | null
  current: boolean | null
  fm_value: boolean | null
}

/**
 * Reconcile FM-backed rows. `dryRun` returns the same report without writing —
 * used by scripts/verify-online-ordering-mirror.ts and safe to expose to an
 * admin preview.
 */
export async function mirrorOnlineOrderingFromFm(
  opts: { dryRun?: boolean } = {},
): Promise<OnlineOrderingMirrorResult> {
  const startedAt = Date.now()

  const nativeRows = (await sql`
    SELECT COUNT(*)::int AS n
    FROM disco_restaurant_overrides o
    JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference
    WHERE c.is_disco_native = true
  `) as { n: number }[]
  const skippedNative = nativeRows[0]?.n ?? 0

  // raw->>'onlineOrderingAllowed' is text: 'true' | 'false' | NULL (absent).
  // Anything else is treated as no value rather than coerced, so an FM schema
  // change can never be read as `false` and turn ordering off at conversion.
  const rows = (await sql`
    SELECT o.restaurant_reference,
           c.name,
           o.online_ordering_enabled AS current,
           CASE l.raw->>'onlineOrderingAllowed'
             WHEN 'true' THEN true
             WHEN 'false' THEN false
             ELSE NULL
           END AS fm_value
    FROM disco_restaurant_overrides o
    JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference
    JOIN disco_restaurant_admin_list_cache l ON l.restaurant_reference = o.restaurant_reference
    WHERE COALESCE(c.is_disco_native, false) = false
      AND c.archived_at IS NULL
  `) as CandidateRow[]

  const withValue = rows.filter(r => typeof r.fm_value === 'boolean')
  const skippedNoFmValue = rows.length - withValue.length

  const flips: OnlineOrderingFlip[] = []
  let matched = 0
  for (const r of withValue) {
    const after = r.fm_value as boolean
    // Compare on the same "null means on" semantics every reader uses
    // (COALESCE(online_ordering_enabled, true)), so an unset row that already
    // behaves as true is not reported as a flip to true.
    if ((r.current !== false) === after) { matched++; continue }
    flips.push({
      restaurantReference: r.restaurant_reference,
      name: r.name,
      before: r.current,
      after,
      dangerous: r.current !== false && after === false,
    })
  }

  if (!opts.dryRun && flips.length > 0) {
    // One statement, not a loop: this is a fleet-wide correction and a partial
    // application would leave the report disagreeing with the table.
    const refs = flips.map(f => f.restaurantReference)
    const values = flips.map(f => f.after)
    await sql`
      UPDATE disco_restaurant_overrides AS o
      SET online_ordering_enabled = v.val, updated_at = NOW()
      FROM (
        SELECT UNNEST(${refs}::text[]) AS ref, UNNEST(${values}::boolean[]) AS val
      ) AS v
      WHERE o.restaurant_reference = v.ref
    `
  }

  if (flips.length > 0) {
    const dangerous = flips.filter(f => f.dangerous)
    const show = flips.slice(0, 25)
    const lines = show.map(f =>
      `• ${f.name || f.restaurantReference} (${f.restaurantReference}): ${f.before === null ? 'unset' : f.before} → ${f.after}${f.dangerous ? ' ⚠ removes ordering at conversion' : ''}`,
    ).join('\n')
    const more = flips.length > show.length ? `\n…and ${flips.length - show.length} more` : ''
    await alertOps(
      `online-ordering-mirror${opts.dryRun ? ' (DRY RUN, nothing written)' : ''}: ${flips.length} FM-backed row(s) corrected from FM out of ${withValue.length} compared` +
      `${dangerous.length ? ` — ${dangerous.length} in the true→false direction` : ''}` +
      `. Inert until conversion: no FM-backed gate reads this column.\n${lines}${more}`,
    )
  }

  return {
    comparable: withValue.length,
    matched,
    flipped: flips.length,
    skippedNoFmValue,
    skippedNative,
    flips,
    durationMs: Date.now() - startedAt,
  }
}
