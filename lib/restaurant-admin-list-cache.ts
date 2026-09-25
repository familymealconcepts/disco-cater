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

import { fmFetch } from './fm-fetch'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
// 250, not 500. Pages of 500 return 230-270 KB each and were slow enough that
// page 4 hit the ~100s Cloudflare proxy timeout in front of FM: nginx logged it
// as 499 (client closed request) at 06:05:24 on two consecutive days, and the
// single short retry then hit the same slow page and failed the same way. That
// is what "1 page failed even after retry" was. Halving the page halves the
// per-request work; the extra round trips are cheap because this endpoint is
// NOT in FM's rate-limited `orders` zone (zero 429s against it).
const SIZE = 250
const MAX_PAGES = 100

type FmRow = Record<string, unknown>

// FOUR attempts with exponential backoff, not two with a flat 1.5s. A 401
// force-refreshes the service token first (it can expire mid-run on a slow full
// pull) and retries immediately, without waiting out the backoff meant for slow
// pages and FM 5xxs.
//
// TWO ATTEMPTS WAS NOT ENOUGH, and the reason is that the failure is not random:
// a page that times out at the proxy takes just as long on the immediate retry,
// so both attempts failed for the same reason 1.5 seconds apart. Backing off
// gives FM room to drain whatever made that page slow.
//
// Goes through fmFetch for its 429/502/503/504 retry and Retry-After handling,
// with a 60s timeout — generous on purpose, since a full page legitimately takes
// several seconds and the default 10s would turn a slow page into a hard failure.
const PAGE_ATTEMPTS = 4
const PAGE_TIMEOUT_MS = 60_000

async function fetchPageWithRetry(page: number, getHeader: (force?: boolean) => Promise<Record<string, string>>): Promise<any | null> {
  for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
    try {
      const header = await getHeader()
      const params = new URLSearchParams({ page: String(page), size: String(SIZE) })
      const res = await fmFetch(`${FM}/api/admin/restaurants?${params}`, { headers: header, cache: 'no-store' }, PAGE_TIMEOUT_MS)
      if (res.status === 401) { await getHeader(true); continue }
      if (res.ok) return await res.json().catch(() => null)
      console.warn(`[admin-list-cache] page ${page} attempt ${attempt + 1} failed: HTTP ${res.status}`)
    } catch (e) {
      // Includes the proxy cutting a slow page: fetch throws rather than
      // returning a status, which is why this must retry on a throw too.
      console.warn(`[admin-list-cache] page ${page} attempt ${attempt + 1} errored: ${e instanceof Error ? e.message : e}`)
    }
    if (attempt < PAGE_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)))
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
