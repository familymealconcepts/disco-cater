import { sql, runRestaurantAdminListCacheMigrations } from './db'
import { getFmServiceAuthHeader } from './fm-service-auth'
import { alertOps } from './ops-alert'

// Builds disco_restaurant_admin_list_cache from FM's full restaurant
// admin-list, so manage-restaurants/ordering reads Neon instead of calling FM
// directly on every load. FM's restaurant-list endpoint has a low
// concurrency ceiling — measured live against production, 8 concurrent page
// requests failed 6/8 with HTTP 504, while the same 8 pages fetched one at a
// time succeeded 8/8. This fetches strictly sequentially, same as the admin
// page's own fix for the identical endpoint — the extra wall time costs
// nobody here, since this runs on a schedule with nobody waiting on it.
//
// Reconciliation + staging swap: every row is fetched and checked against
// FM's own totalElements BEFORE anything is written. A run that comes up
// short (even after per-page retries) writes nothing at all — the live
// table is never touched, so a bad run can't leave admins looking at a
// truncated or half-refreshed list. Only a run that accounts for every row
// writes into the staging table and swaps it in for the live one, via an
// instant catalog-only three-way RENAME (no row copy, no long lock).

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const SIZE = 500
const MAX_PAGES = 50

type FmRow = Record<string, unknown>

// One retry with a short backoff on any failure; a 401 force-refreshes the
// service token first (it can expire mid-run on a slow full pull) and
// retries immediately, without waiting out the backoff meant for FM 5xxs.
async function fetchPageWithRetry(page: number, getHeader: (force?: boolean) => Promise<Record<string, string>>): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const header = await getHeader()
      const params = new URLSearchParams({ page: String(page), size: String(SIZE) })
      const res = await fetch(`${FM}/api/admin/restaurants?${params}`, { headers: header, cache: 'no-store' })
      if (res.status === 401) { await getHeader(true); continue }
      if (res.ok) return await res.json().catch(() => null)
    } catch { /* fall through to retry */ }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1500))
  }
  return null
}

export interface AdminListSyncResult {
  ok: boolean
  totalElements: number
  fetched: number
  failedPages: number
  durationMs: number
  error?: string
}

async function recordAttempt(result: { ok: boolean; total?: number; error?: string }): Promise<void> {
  if (result.ok) {
    await sql`
      UPDATE disco_restaurant_admin_list_sync_meta
      SET last_attempt_at = NOW(), last_success_at = NOW(), last_success_total = ${result.total ?? null}, last_error = NULL
      WHERE id = 1
    `
  } else {
    await sql`
      UPDATE disco_restaurant_admin_list_sync_meta
      SET last_attempt_at = NOW(), last_error = ${result.error ?? 'unknown error'}
      WHERE id = 1
    `
  }
}

export async function refreshRestaurantAdminListCache(): Promise<AdminListSyncResult> {
  const startedAt = Date.now()
  await runRestaurantAdminListCacheMigrations()

  let cachedHeader: Record<string, string> | null = null
  const getHeader = async (force = false): Promise<Record<string, string>> => {
    if (force || !cachedHeader) cachedHeader = await getFmServiceAuthHeader(force)
    return cachedHeader
  }

  try {
    const first = await fetchPageWithRetry(0, getHeader)
    if (!first) {
      const error = 'FM page 0 failed even after retry — cannot determine totalElements'
      await recordAttempt({ ok: false, error })
      await alertOps('refresh-restaurant-admin-list: FAILED — ' + error, { durationMs: Date.now() - startedAt })
      return { ok: false, totalElements: 0, fetched: 0, failedPages: 1, durationMs: Date.now() - startedAt, error }
    }

    let all: FmRow[] = Array.isArray(first.content) ? first.content : []
    const totalElements = Number(first.totalElements ?? first.total_elements ?? 0)
    const reportedPages = first.totalPages ?? first.total_pages
    const computedPages = totalElements > 0 ? Math.ceil(totalElements / SIZE) : (all.length > 0 ? 1 : 0)
    const totalPages = Math.min(Number(reportedPages ?? computedPages) || (all.length > 0 ? 1 : 0), MAX_PAGES)

    let failedPages = 0
    for (let page = 1; page < totalPages; page++) {
      const pg = await fetchPageWithRetry(page, getHeader)
      if (pg && Array.isArray(pg.content)) all = all.concat(pg.content)
      else failedPages++
    }

    if (totalElements > 0 && all.length < totalElements) {
      const error = `reconciliation failed: fetched ${all.length} of ${totalElements} restaurants (${failedPages} page(s) failed even after retry)`
      await recordAttempt({ ok: false, error })
      await alertOps('refresh-restaurant-admin-list: FAILED — ' + error, {
        durationMs: Date.now() - startedAt, totalElements, fetched: all.length, failedPages,
      })
      return { ok: false, totalElements, fetched: all.length, failedPages, durationMs: Date.now() - startedAt, error }
    }

    // Every row accounted for — safe to write. TRUNCATE + bulk insert into
    // staging (never read by the app until swapped in), then swap.
    await sql`TRUNCATE disco_restaurant_admin_list_cache_staging`
    const CHUNK = 50
    for (let i = 0; i < all.length; i += CHUNK) {
      const chunk = all.slice(i, i + CHUNK)
      await Promise.all(chunk.map((r) => {
        const reference = String(r.reference ?? r.restaurantReference ?? '')
        if (!reference) return Promise.resolve(undefined)
        const admin = (r.admin || {}) as Record<string, unknown>
        const adminEmail = (r.adminEmail as string) || (admin.email as string) || null
        const createdDate = r.createdDate ? String(r.createdDate) : null
        return sql`
          INSERT INTO disco_restaurant_admin_list_cache_staging
            (restaurant_reference, raw, business_name, restaurant_status, admin_email, created_date, cached_at)
          VALUES (${reference}, ${JSON.stringify(r)}::jsonb, ${String(r.businessName ?? '')},
                  ${String(r.restaurantStatus ?? '')}, ${adminEmail}, ${createdDate}, NOW())
          ON CONFLICT (restaurant_reference) DO UPDATE SET
            raw = EXCLUDED.raw, business_name = EXCLUDED.business_name,
            restaurant_status = EXCLUDED.restaurant_status, admin_email = EXCLUDED.admin_email,
            created_date = EXCLUDED.created_date, cached_at = NOW()
        `
      }))
    }

    // Atomic catalog-only swap — no row copy, no long lock, instant
    // regardless of table size.
    await sql.transaction([
      sql`ALTER TABLE disco_restaurant_admin_list_cache RENAME TO disco_restaurant_admin_list_cache_old`,
      sql`ALTER TABLE disco_restaurant_admin_list_cache_staging RENAME TO disco_restaurant_admin_list_cache`,
      sql`ALTER TABLE disco_restaurant_admin_list_cache_old RENAME TO disco_restaurant_admin_list_cache_staging`,
    ])

    await recordAttempt({ ok: true, total: totalElements || all.length })
    return { ok: true, totalElements: totalElements || all.length, fetched: all.length, failedPages, durationMs: Date.now() - startedAt }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await recordAttempt({ ok: false, error }).catch(() => {})
    await alertOps('refresh-restaurant-admin-list: FAILED — ' + error, { durationMs: Date.now() - startedAt })
    return { ok: false, totalElements: 0, fetched: 0, failedPages: 0, durationMs: Date.now() - startedAt, error }
  }
}
