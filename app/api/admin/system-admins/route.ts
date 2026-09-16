import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { sql } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

interface FmSystemAdmin {
  reference: string; firstName: string; lastName?: string; email: string
  managedRestaurants?: { reference: string; businessName?: string }[]
  // 'FM' | 'DISCO' | 'BOTH' — which account system this person exists in. Read by
  // the page to badge the row and to disable the FM-only edit/delete actions on a
  // Disco-native account.
  source?: 'FM' | 'DISCO' | 'BOTH'
}

// ── DISCO-NATIVE SYSTEM ADMINS ──────────────────────────────────────────────
// A converted restaurant is Disco-native: Disco owns its people, and its system
// admins live in disco_restaurant_accounts, never in FM. This endpoint proxied
// FM alone, so every one of them was invisible in super admin —
// rita.jones@eggbred.com is a correct SYSTEM_ADMIN with two location grants that
// Kealoha simply could not see. Reaching only to FM for a native restaurant is
// the gap; this closes it.
//
// Reach comes from disco_restaurant_location_access, NOT from the account's own
// restaurant_reference anchor and NOT from its role. The anchor is one location
// (and can even be stale — rita's says Huntington Beach while her anchor is Seal
// Beach), whereas the grants are the real membership. Joining accounts on
// restaurant_reference to derive locations is the mistake that produced the
// multi-unit reach bug; do not reintroduce it here.
const DISCO_ADMIN_PREFIX = 'disco:'

async function fetchDiscoSystemAdmins(): Promise<FmSystemAdmin[]> {
  try {
    const rows = (await sql`
      SELECT a.email, a.first_name, a.last_name,
             COALESCE(
               json_agg(
                 json_build_object('reference', g.restaurant_reference, 'businessName', c.name)
                 ORDER BY c.name
               ) FILTER (WHERE g.restaurant_reference IS NOT NULL),
               '[]'
             ) AS managed
        FROM disco_restaurant_accounts a
        LEFT JOIN disco_restaurant_location_access g ON lower(g.account_email) = lower(a.email)
        LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = g.restaurant_reference
       WHERE a.role = 'SYSTEM_ADMIN'
         AND a.archived_at IS NULL
         AND a.email NOT LIKE 'stripe-import+%'
       GROUP BY a.email, a.first_name, a.last_name
    `) as Array<{ email: string; first_name: string | null; last_name: string | null; managed: { reference: string; businessName: string | null }[] }>
    return rows.map(r => ({
      // Prefixed so it can never be mistaken for an FM user reference and posted
      // to an FM endpoint — the page keys off this to disable edit/delete.
      reference: `${DISCO_ADMIN_PREFIX}${r.email}`,
      firstName: r.first_name || r.email.split('@')[0],
      lastName: r.last_name || '',
      email: r.email,
      managedRestaurants: (r.managed || []).map(m => ({ reference: m.reference, businessName: m.businessName || undefined })),
      source: 'DISCO' as const,
    }))
  } catch (e) {
    // NEVER let a Neon failure blank the FM list. Losing the Disco rows is a
    // degraded page; throwing loses every admin on it.
    console.error('[admin/system-admins] Disco-native fetch failed:', e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * One list from two account systems, with neither able to hide the other.
 *
 * FM-BACKED RESTAURANTS STILL NEED FM'S LIST. Their admins only exist there —
 * Disco holds no account row for them — so dropping the FM call would blank most
 * of this page. The two are merged rather than switched between.
 *
 * Merged on lowercased email. A person present in both is ONE row carrying the
 * union of their locations and source 'BOTH', because they really do administer
 * both kinds of restaurant; showing them twice, or letting either copy win and
 * silently drop the other's locations, would both misreport their reach.
 */
function mergeAdminLists(fm: FmSystemAdmin[], disco: FmSystemAdmin[]): FmSystemAdmin[] {
  const byEmail = new Map<string, FmSystemAdmin>()
  for (const a of fm) byEmail.set((a.email || '').toLowerCase(), { ...a, source: 'FM' })
  for (const d of disco) {
    const key = (d.email || '').toLowerCase()
    const existing = byEmail.get(key)
    if (!existing) { byEmail.set(key, d); continue }
    const seen = new Set((existing.managedRestaurants || []).map(m => m.reference))
    byEmail.set(key, {
      ...existing,
      source: 'BOTH',
      managedRestaurants: [
        ...(existing.managedRestaurants || []),
        ...(d.managedRestaurants || []).filter(m => !seen.has(m.reference)),
      ],
    })
  }
  return Array.from(byEmail.values()).sort((a, b) =>
    `${a.firstName || ''} ${a.lastName || ''}`.trim().localeCompare(`${b.firstName || ''} ${b.lastName || ''}`.trim()))
}

// FM's /api/admin/users/system-admin accepts NO working filter param — confirmed
// empirically (search/query/name/email/q/businessName/restaurantName/keyword/
// searchName/fullName all silently no-op; totalElements stays 363 regardless).
// This is what made the System Admins page's search look broken: the frontend
// searched only whatever 25-row page happened to be loaded, so typing "decheco"
// against a 363-admin, 15-page list found only whichever DeCheco's admin(s)
// happened to land on page 1 — which is exactly how "Nathan and Cory don't
// exist" got concluded when both were really just off-page.
//
// FM returns all 363 in a single call at size=1000 (confirmed totalPages:1), so
// the fix is to filter here, server-side, across the FULL list — not to keep
// asking FM for something it doesn't support.
const FM_FETCH_SIZE = 2000

async function fetchAllFmSystemAdmins(h: Record<string, string>): Promise<FmSystemAdmin[]> {
  const res = await fetch(`${FM}/api/admin/users/system-admin?size=${FM_FETCH_SIZE}`, { headers: h })
  if (!res.ok) throw new Error(`FM system-admin fetch failed: ${res.status}`)
  const j = await res.json()
  return (j.content || []) as FmSystemAdmin[]
}

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const search = (sp.get('search') || '').trim().toLowerCase()
  const page = Number(sp.get('page') || '0')
  const size = Number(sp.get('size') || '25')

  // ── ONE MERGED LIST, ALWAYS ────────────────────────────────────────────────
  // The unfiltered case used to be a thin passthrough to FM with FM's own paging.
  // That cannot survive merging a second source: FM's totalElements would not
  // count the Disco rows, and FM's page slice would not contain them. So both
  // cases now take the same route — fetch everything from both sides, merge,
  // filter, then paginate locally.
  //
  // Affordable because FM already returns all of its system admins in ONE call
  // (measured: totalElements 363, totalPages 1 at size=2000), which is also why
  // the search path was written this way to begin with.
  try {
    const [fmAll, discoAll] = await Promise.all([
      fetchAllFmSystemAdmins(h),
      fetchDiscoSystemAdmins(),
    ])
    const merged = mergeAdminLists(fmAll, discoAll)

    const matches = !search ? merged : merged.filter(a =>
      `${a.firstName || ''} ${a.lastName || ''}`.toLowerCase().includes(search) ||
      (a.email || '').toLowerCase().includes(search) ||
      (a.managedRestaurants || []).some(r => (r.businessName || '').toLowerCase().includes(search)),
    )

    const start = page * size
    return NextResponse.json({
      content: matches.slice(start, start + size),
      totalElements: matches.length,
      totalPages: Math.max(1, Math.ceil(matches.length / size)),
    })
  } catch (e) {
    console.error('[admin/system-admins] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to fetch system admins' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    body.role = 'SYSTEM_ADMIN'
    const res = await fetch(`${FM}/api/admin/users/system-admin`, {
      method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to create system admin', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to create system admin' }, { status: 500 })
  }
}
