import { NextResponse } from 'next/server'
import { sql } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { toClientIso } from '../../../../lib/utils/timestamp'
import { stripeReadySql } from '../../../../lib/stripe-readiness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Disco-native restaurants with NO FM record (fm_restaurant_reference IS NULL). The
// super-admin restaurant list is sourced from FM, so these would otherwise be
// invisible. The ordering page merges these in (deduped by reference against the FM
// rows) so a restaurant is never hidden — even if FM creation failed at signup.
export async function GET() {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    // One row per restaurant_reference — a restaurant can have several accounts
    // (e.g. sub-admins, or repeated onboarding), which would otherwise duplicate it
    // in the list (and collide on the React key). DISTINCT ON keeps the most recent
    // account per restaurant; the outer query restores created-date ordering.
    // ── DRIVEN BY THE CACHE, NOT BY ACCOUNTS ─────────────────────────────────
    // This used to select FROM disco_restaurant_accounts, which silently required
    // a native restaurant to HAVE an account row. Two consequences, both live:
    //
    //   * A DUPLICATED location has no account row at all — the clone writes
    //     disco_restaurant_cache, disco_restaurant_overrides and the menu tree,
    //     and nothing else. So "Stacks & Cordials - Royal Oak (Copy)" could never
    //     appear here however long anyone waited.
    //   * Native restaurants whose only accounts are stripe-import sentinels, or
    //     which have none, were invisible too.
    //
    // It also keyed on accounts.is_disco_native, which CLAUDE.md records as the
    // stale, unreliable copy — disco_restaurant_cache.is_disco_native is the
    // authoritative one (it is what broke the password-reset routing). The cache
    // row is also the thing the clone actually creates, so driving from it means
    // the list cannot disagree with what exists.
    //
    // Accounts are still joined, for the Admin column — LEFT, and DISTINCT ON so
    // a restaurant with several accounts yields one row rather than colliding on
    // the React key. Sentinel stripe-import addresses are not shown as an admin:
    // they are never deliverable and reading one as a contact is worse than blank.
    const rows = (await sql`
      SELECT * FROM (
        SELECT DISTINCT ON (c.restaurant_reference)
               c.restaurant_reference AS reference,
               c.name AS "businessName",
               c.slug AS "businessNameWithoutSpaces",
               CASE WHEN a.email LIKE 'stripe-import+%' THEN NULL ELSE a.email END AS "adminEmail",
               NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), '') AS "adminName",
               COALESCE(a.created_at, c.cached_at) AS "createdAtRaw",
               (${sql.unsafe(stripeReadySql('o'))}) AS "stripeConnected",
               COALESCE(a.fm_creation_failed, false) AS "fmCreationFailed",
               a.fm_creation_error AS "fmCreationError",
               COALESCE(c.is_live, false) AS "isLive",
               COALESCE(o.money_flow, 'DIRECT') AS "moneyFlow",
               COALESCE(o.nash_allowed, false) AS "nashAllowed",
               COALESCE(o.shipday_enabled, false) AS "shipdayEnabled",
               COALESCE(o.visible, false) AS "visible",
               o.online_ordering_enabled AS "onlineOrderingEnabled",
               -- ── THE FM ROW THIS NATIVE ROW SUPERSEDES ────────────────────
               -- 21 restaurants render TWICE in the ordering list: this native
               -- row holding the menu, the account and the Stripe account, and
               -- an empty FamilyMeal row for the same business under a different
               -- reference. The FM rows cannot be deleted — most render straight
               -- from FM's live admin list, and the rest would be recreated by
               -- the 04:00 mirror — so the page hides them using this.
               --
               -- Two guards, both load-bearing:
               --   <> c.restaurant_reference  — 155 of 177 native accounts point
               --     at themselves, where hiding "the FM row" would hide this row.
               --   NOT EXISTS (... is_disco_native) — never hide a reference that
               --     is itself a native restaurant. This is what keeps Atlanta
               --     Bread's two LIVE locations (Asheville, 34 orders; Westside,
               --     15 orders) rendering as two rows: they look like a pair only
               --     because of fm_restaurant_reference cross-wiring, and
               --     collapsing them would hide a real restaurant.
               (SELECT a2.fm_restaurant_reference::text
                  FROM disco_restaurant_accounts a2
                 WHERE a2.restaurant_reference = c.restaurant_reference
                   AND a2.fm_restaurant_reference IS NOT NULL
                   AND a2.fm_restaurant_reference::text <> c.restaurant_reference::text
                   AND NOT EXISTS (
                     SELECT 1 FROM disco_restaurant_cache c2
                      WHERE c2.restaurant_reference = a2.fm_restaurant_reference
                        AND c2.is_disco_native = true)
                 LIMIT 1) AS "supersedesFmReference"
        FROM disco_restaurant_cache c
        LEFT JOIN disco_restaurant_accounts a
               ON a.restaurant_reference = c.restaurant_reference
              AND a.archived_at IS NULL
        LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
        WHERE c.is_disco_native = true
          AND c.archived_at IS NULL
          AND c.name IS NOT NULL AND c.name <> ''
        -- A real admin sorts ahead of a sentinel, so DISTINCT ON keeps the useful one.
        ORDER BY c.restaurant_reference,
                 (a.email LIKE 'stripe-import+%') ASC NULLS LAST,
                 a.created_at DESC NULLS LAST
      ) sub
      ORDER BY sub."createdAtRaw" DESC
    `) as Record<string, unknown>[]
    // Merge boundary — see lib/utils/timestamp.ts. The ordering page merges
    // these orphan rows against FM-sourced restaurant rows (per the header
    // comment above), so this one's real, not just future-proofing — same
    // bare-to_char pattern that broke admin Orders sort.
    const normalized = rows.map((r) => {
      const { createdAtRaw, ...rest } = r
      return { ...rest, createdDate: toClientIso(createdAtRaw) }
    })
    return NextResponse.json({ orphans: normalized })
  } catch (e) {
    console.error('[admin/disco-native-orphans] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load disco-native restaurants' }, { status: 500 })
  }
}
