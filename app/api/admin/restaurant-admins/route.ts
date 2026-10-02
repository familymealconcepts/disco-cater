import { NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/restaurant-admins — every ADMIN and the restaurant(s) they can
// reach. READ ONLY; it changes nothing and decides nothing.
//
// ── WHY THIS IS A SEPARATE ROUTE FROM /api/admin/system-admins ──────────────
// That one lists SYSTEM_ADMINs (Neon `role = 'SYSTEM_ADMIN'` merged with FM's
// system-admin endpoint). A plain ADMIN appears in neither, so the people who
// run most single-location restaurants were invisible in Super Admin.
//
// ── REACH IS NOT RE-DERIVED HERE ───────────────────────────────────────────
// The system-admin structure is settled and this view must report it, not
// reinterpret it. For an ADMIN that rule is: ONE location — their own —
// regardless of how many grant rows exist (CLAUDE.md: "ROLE GATES REACH. An
// ADMIN's reach is their own location regardless of grants"). So this reports
// the anchor as their reach, and shows any extra grant rows separately as an
// anomaly worth a human look rather than silently widening the number.
//
// ── TWO SOURCES, BECAUSE AN ADMIN CAN EXIST IN EITHER SYSTEM ───────────────
//   * Disco — disco_restaurant_accounts, for a converted restaurant's people.
//   * FamilyMeal — the cached admin list, which names one admin per restaurant.
//     That is where the Ordering table's "Admin / Email" column comes from, and
//     it is a REAL login: an FM session resolves its restaurant from the JWT's
//     own claim, so that person can administer the restaurant whether or not
//     Disco holds a row for them.
interface AdminRow {
  email: string
  name: string
  source: 'DISCO' | 'FM' | 'BOTH'
  /** Can they sign in with a Disco Cater password today? */
  hasDiscoPassword: boolean
  restaurants: { reference: string; name: string | null; isDiscoNative: boolean }[]
  /** Grant rows beyond the anchor. An ADMIN's reach does not include these. */
  extraGrants: number
}

export async function GET() {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    await runDiscoOrderMigrations()

    const discoRows = (await sql`
      SELECT lower(a.email) AS email,
             TRIM(COALESCE(a.first_name,'') || ' ' || COALESCE(a.last_name,'')) AS name,
             (a.password_set_at IS NOT NULL) AS has_password,
             a.restaurant_reference::text AS ref,
             c.name AS restaurant_name,
             COALESCE(c.is_disco_native,false) AS native,
             (SELECT count(*)::int FROM disco_restaurant_location_access g
               WHERE lower(g.account_email) = lower(a.email)
                 AND g.restaurant_reference <> a.restaurant_reference) AS extra_grants
        FROM disco_restaurant_accounts a
        LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = a.restaurant_reference
       WHERE a.role = 'ADMIN' AND a.archived_at IS NULL
         AND a.email NOT LIKE 'stripe-import+%'
    `) as {
      email: string; name: string; has_password: boolean; ref: string | null
      restaurant_name: string | null; native: boolean; extra_grants: number
    }[]

    // FamilyMeal names one admin per restaurant. A person running several shows
    // up once per restaurant, so they are merged on email below.
    const fmRows = (await sql`
      SELECT lower(a.raw->'admin'->>'email') AS email,
             TRIM(COALESCE(a.raw->'admin'->>'firstName','') || ' ' || COALESCE(a.raw->'admin'->>'lastName','')) AS name,
             a.raw->>'reference' AS ref,
             a.raw->>'businessName' AS restaurant_name,
             COALESCE(c.is_disco_native,false) AS native
        FROM disco_restaurant_admin_list_cache a
        LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = a.raw->>'reference'
       WHERE a.raw->'admin'->>'email' IS NOT NULL
         AND COALESCE(a.raw->'admin'->>'role','ADMIN') = 'ADMIN'
    `) as { email: string; name: string; ref: string; restaurant_name: string | null; native: boolean }[]

    const byEmail = new Map<string, AdminRow>()
    const put = (email: string, name: string, source: 'DISCO' | 'FM') => {
      let row = byEmail.get(email)
      if (!row) {
        row = { email, name: name || email.split('@')[0], source, hasDiscoPassword: false, restaurants: [], extraGrants: 0 }
        byEmail.set(email, row)
      } else if (row.source !== source) row.source = 'BOTH'
      return row
    }
    for (const d of discoRows) {
      if (!d.email) continue
      const row = put(d.email, d.name, 'DISCO')
      row.hasDiscoPassword = row.hasDiscoPassword || d.has_password
      row.extraGrants = Math.max(row.extraGrants, d.extra_grants || 0)
      if (d.ref && !row.restaurants.some(r => r.reference === d.ref)) {
        row.restaurants.push({ reference: d.ref, name: d.restaurant_name, isDiscoNative: d.native })
      }
    }
    for (const f of fmRows) {
      if (!f.email) continue
      const row = put(f.email, f.name, 'FM')
      if (f.ref && !row.restaurants.some(r => r.reference === f.ref)) {
        row.restaurants.push({ reference: f.ref, name: f.restaurant_name, isDiscoNative: f.native })
      }
    }

    const admins = [...byEmail.values()].sort((a, b) =>
      b.restaurants.length - a.restaurants.length || a.name.localeCompare(b.name))
    return NextResponse.json({
      admins,
      totals: {
        admins: admins.length,
        withDiscoPassword: admins.filter(a => a.hasDiscoPassword).length,
        fmOnly: admins.filter(a => a.source === 'FM').length,
        multiLocation: admins.filter(a => a.restaurants.length > 1).length,
      },
    })
  } catch (e) {
    console.error('[admin/restaurant-admins] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load admins' }, { status: 500 })
  }
}
