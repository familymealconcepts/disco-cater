import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// TEMPORARY diagnostic gate (removed after we confirm the prod row count). When
// ?debug=<key> matches, skip admin auth and return a sanitized count/sample so we
// can observe exactly what production returns without a super-admin session.
const DEBUG_KEY = 'x7k9-orphans-probe-3f8a2e'

// Disco-native restaurants with NO FM record (fm_restaurant_reference IS NULL). The
// super-admin restaurant list is sourced from FM, so these would otherwise be
// invisible. The ordering page merges these in (deduped by admin email against the
// FM rows) so a restaurant is never hidden — even if FM creation failed at signup.
export async function GET(req: NextRequest) {
  const isDebug = req.nextUrl.searchParams.get('debug') === DEBUG_KEY
  if (!isDebug) {
    try { await getAdminAuthHeader() } catch {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
  }
  try {
    // (Removed a runDiscoOrderMigrations() call here — the orphans query only reads
    // disco_restaurant_accounts + disco_restaurant_cache, which already exist, so
    // running the order-migration file on every request was unnecessary work and a
    // cold-start failure point.)
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
               to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdDate",
               (a.stripe_account_id IS NOT NULL AND a.stripe_onboarding_complete = true) AS "stripeConnected",
               COALESCE(a.fm_creation_failed, false) AS "fmCreationFailed",
               a.fm_creation_error AS "fmCreationError",
               COALESCE(c.is_live, false) AS "isLive"
        FROM disco_restaurant_accounts a
        LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = a.restaurant_reference
        WHERE a.is_disco_native = true
          AND a.fm_restaurant_reference IS NULL
          AND a.restaurant_name IS NOT NULL AND a.restaurant_name <> ''
        ORDER BY a.restaurant_reference, a.created_at DESC
      ) sub
      ORDER BY sub."createdDate" DESC
    `) as Record<string, unknown>[]
    // TEMP diagnostic: confirm what production returns for this feed.
    console.log('[disco-native-orphans] returning', rows.length, 'rows:',
      rows.map(r => `${r.businessName}(${String(r.reference).slice(0, 8)})`).join(', '))
    if (isDebug) {
      return NextResponse.json({
        count: rows.length,
        sample: rows.map(r => ({ name: r.businessName, ref: String(r.reference).slice(0, 8), isLive: r.isLive })),
      })
    }
    return NextResponse.json({ orphans: rows })
  } catch (e) {
    console.error('[admin/disco-native-orphans] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load disco-native restaurants' }, { status: 500 })
  }
}
