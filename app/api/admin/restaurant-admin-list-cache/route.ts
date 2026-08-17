import { NextResponse } from 'next/server'
import { sql, runRestaurantAdminListCacheMigrations } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

// Read-only endpoint backing manage-restaurants/ordering's restaurant list.
// Reads disco_restaurant_admin_list_cache (Neon) instead of the page calling
// FM directly — see lib/restaurant-admin-list-cache.ts for how that table is
// kept in sync (a 15-min cron + this page's own "Refresh Now" button).
//
// `totalElements` reflects the last SUCCESSFUL sync's row count (recorded at
// swap time), not a live FM count — this is deliberate, since the whole
// point is never calling FM from this request path. If the live table's
// actual row count doesn't match it (e.g. the cache has never been
// populated yet, right after this migration first deploys), the response
// still reports both numbers so the ordering page's existing incomplete-
// results banner fires exactly as it does for a live-fetch mismatch.
export async function GET() {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  try {
    await runRestaurantAdminListCacheMigrations()

    const [rows, metaRows] = await Promise.all([
      sql`SELECT raw, cached_at FROM disco_restaurant_admin_list_cache`,
      sql`SELECT last_success_at, last_success_total, last_attempt_at, last_error FROM disco_restaurant_admin_list_sync_meta WHERE id = 1`,
    ])

    const content = (rows as { raw: unknown; cached_at: string }[]).map((r) => r.raw)
    const meta = (metaRows as {
      last_success_at: string | null; last_success_total: number | null
      last_attempt_at: string | null; last_error: string | null
    }[])[0]

    return NextResponse.json({
      content,
      // Falls back to the actual row count only if no successful sync has
      // ever recorded a total (brand-new/never-synced cache) — otherwise an
      // empty or partial live table would trivially "match" itself and hide
      // the exact incompleteness this is meant to surface.
      totalElements: meta?.last_success_total ?? content.length,
      cachedAt: meta?.last_success_at ?? null,
      lastAttemptAt: meta?.last_attempt_at ?? null,
      lastError: meta?.last_error ?? null,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[restaurant-admin-list-cache] read failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
