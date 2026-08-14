import { NextResponse } from 'next/server'
import { sql } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { toClientIso } from '../../../../lib/utils/timestamp'

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
    const rows = (await sql`
      SELECT * FROM (
        SELECT DISTINCT ON (a.restaurant_reference)
               a.restaurant_reference AS reference,
               a.restaurant_name AS "businessName",
               a.email AS "adminEmail",
               a.created_at AS "createdAtRaw",
               (a.stripe_account_id IS NOT NULL AND a.stripe_onboarding_complete = true) AS "stripeConnected",
               COALESCE(a.fm_creation_failed, false) AS "fmCreationFailed",
               a.fm_creation_error AS "fmCreationError",
               COALESCE(c.is_live, false) AS "isLive",
               -- Neon-backed row toggles so they reflect persisted state on reload (S5)
               COALESCE(o.money_flow, 'DIRECT') AS "moneyFlow",
               COALESCE(o.nash_allowed, false) AS "nashAllowed",
               COALESCE(o.shipday_enabled, false) AS "shipdayEnabled",
               -- Expose the marketplace + online-ordering flags directly so the admin
               -- toggles have a source even if a per-row overrides lookup misses.
               COALESCE(o.visible, false) AS "visible",
               o.online_ordering_enabled AS "onlineOrderingEnabled"
        FROM disco_restaurant_accounts a
        LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = a.restaurant_reference
        LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = a.restaurant_reference
        WHERE a.is_disco_native = true
          AND a.fm_restaurant_reference IS NULL
          AND a.restaurant_name IS NOT NULL AND a.restaurant_name <> ''
        ORDER BY a.restaurant_reference, a.created_at DESC
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
