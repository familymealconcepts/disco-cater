import { NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// GET /api/admin/restaurant-admins — the Super Admin "Restaurant Admins" page:
// every System Admin and every Admin in ONE list (Peter, 22 Oct 2026; replaces
// the separate System Admins and Admins pages).
//
// ── TIER ───────────────────────────────────────────────────────────────────
//   PRIMARY  — SYSTEM_ADMIN with is_primary_system_admin (stamped by
//              scripts/migrate-system-admin-locations.ts; only a Super Admin
//              moves it, through ./[email]/primary).
//   REGIONAL — any other SYSTEM_ADMIN.
//   SINGLE   — ADMIN: Restaurant Staff on exactly one location.
//
// ── LOCATIONS ARE DISCO'S SINGLE LIST ──────────────────────────────────────
// A System Admin's locations are disco_restaurant_location_access, which Disco
// now owns. FamilyMeal's own managed list is NOT shown or merged: it stopped
// being the source of truth on 21 Oct. An Admin's location is their anchor
// (role gates reach — extra grant rows never widen an Admin).
//
// ── WHO IS LISTED ──────────────────────────────────────────────────────────
//   * every live Disco account with role SYSTEM_ADMIN or ADMIN,
//   * FamilyMeal-only System Admins (FM's list, READ ONLY) — they can hold a
//     Disco list keyed on their email without a Disco account row,
//   * FamilyMeal-only Admins from the cached admin list, as before.
// stripe-import+ sentinel rows are never listed. A System Admin with no
// locations is listed with none — that is a state worth seeing.

interface Loc { reference: string; name: string | null }
interface Person {
  email: string
  firstName: string
  lastName: string
  role: 'SYSTEM_ADMIN' | 'ADMIN'
  tier: 'PRIMARY' | 'REGIONAL' | 'SINGLE'
  source: 'DISCO' | 'FM'
  hasDiscoAccount: boolean
  hasDiscoPassword: boolean
  invitedBy: string | null
  locations: Loc[]
}

const isSentinel = (e: string) => e.startsWith('stripe-import+')

export async function GET() {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    await runDiscoOrderMigrations()

    const accounts = (await sql`
      SELECT lower(a.email) AS email, COALESCE(a.first_name, '') AS first_name, COALESCE(a.last_name, '') AS last_name,
             UPPER(COALESCE(a.role, 'ADMIN')) AS role,
             COALESCE(a.is_primary_system_admin, false) AS is_primary,
             (a.password_set_at IS NOT NULL) AS has_password,
             a.restaurant_reference::text AS anchor,
             lower(COALESCE(a.invited_by, CASE WHEN a.created_by LIKE '%@%' THEN a.created_by END)) AS invited_by
        FROM disco_restaurant_accounts a
       WHERE a.archived_at IS NULL
         AND UPPER(COALESCE(a.role, 'ADMIN')) IN ('SYSTEM_ADMIN', 'ADMIN')
         AND a.email NOT LIKE 'stripe-import+%'
    `) as Array<{ email: string; first_name: string; last_name: string; role: string; is_primary: boolean; has_password: boolean; anchor: string | null; invited_by: string | null }>

    const grants = (await sql`
      SELECT lower(g.account_email) AS email, g.restaurant_reference::text AS ref, c.name
        FROM disco_restaurant_location_access g
        LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = g.restaurant_reference
       ORDER BY c.name NULLS LAST
    `) as Array<{ email: string; ref: string; name: string | null }>
    const listOf = new Map<string, Loc[]>()
    for (const g of grants) {
      if (!listOf.has(g.email)) listOf.set(g.email, [])
      listOf.get(g.email)!.push({ reference: g.ref, name: g.name })
    }
    const anchorRefs = [...new Set(accounts.map(a => a.anchor).filter(Boolean))] as string[]
    const anchorNames = new Map(((await sql`
      SELECT restaurant_reference::text AS ref, name FROM disco_restaurant_cache WHERE restaurant_reference = ANY(${anchorRefs}::text[])
    `) as Array<{ ref: string; name: string | null }>).map(r => [r.ref, r.name]))

    const people = new Map<string, Person>()
    for (const a of accounts) {
      const sa = a.role === 'SYSTEM_ADMIN'
      people.set(a.email, {
        email: a.email, firstName: a.first_name, lastName: a.last_name,
        role: sa ? 'SYSTEM_ADMIN' : 'ADMIN',
        tier: sa ? (a.is_primary ? 'PRIMARY' : 'REGIONAL') : 'SINGLE',
        source: 'DISCO', hasDiscoAccount: true, hasDiscoPassword: a.has_password,
        invitedBy: a.invited_by,
        locations: sa ? (listOf.get(a.email) ?? []) : (a.anchor ? [{ reference: a.anchor, name: anchorNames.get(a.anchor) ?? null }] : []),
      })
    }

    // FamilyMeal-only System Admins. READ ONLY. A failure here degrades the
    // page to Disco's people rather than blanking it.
    try {
      const res = await fetch(`${FM}/api/admin/users/system-admin?size=2000&sort=createdDate,asc`, { headers: h })
      if (res.ok) {
        const j = await res.json()
        for (const f of (j.content || []) as Array<{ email?: string; firstName?: string; lastName?: string }>) {
          const e = (f.email || '').trim().toLowerCase()
          if (!e || isSentinel(e) || people.has(e)) continue
          people.set(e, {
            email: e, firstName: f.firstName || '', lastName: f.lastName || '',
            role: 'SYSTEM_ADMIN', tier: 'REGIONAL', source: 'FM',
            hasDiscoAccount: false, hasDiscoPassword: false, invitedBy: null,
            locations: listOf.get(e) ?? [],
          })
        }
      } else {
        console.error('[admin/restaurant-admins] FM system-admin read failed:', res.status)
      }
    } catch (e) {
      console.error('[admin/restaurant-admins] FM system-admin read threw:', e instanceof Error ? e.message : e)
    }

    // FamilyMeal-only Admins: the cached admin list names one per restaurant.
    const fmAdmins = (await sql`
      SELECT lower(a.raw->'admin'->>'email') AS email,
             COALESCE(a.raw->'admin'->>'firstName','') AS first_name,
             COALESCE(a.raw->'admin'->>'lastName','') AS last_name,
             a.raw->>'reference' AS ref, a.raw->>'businessName' AS name
        FROM disco_restaurant_admin_list_cache a
       WHERE a.raw->'admin'->>'email' IS NOT NULL
         AND COALESCE(a.raw->'admin'->>'role','ADMIN') = 'ADMIN'
    `.catch(() => [])) as Array<{ email: string; first_name: string; last_name: string; ref: string; name: string | null }>
    for (const f of fmAdmins) {
      if (!f.email || isSentinel(f.email)) continue
      const p = people.get(f.email)
      if (p) {
        if (p.source === 'FM' && p.role === 'ADMIN' && f.ref && !p.locations.some(l => l.reference === f.ref)) {
          p.locations.push({ reference: f.ref, name: f.name })
        }
        continue
      }
      people.set(f.email, {
        email: f.email, firstName: f.first_name, lastName: f.last_name,
        role: 'ADMIN', tier: 'SINGLE', source: 'FM',
        hasDiscoAccount: false, hasDiscoPassword: false, invitedBy: null,
        locations: f.ref ? [{ reference: f.ref, name: f.name }] : [],
      })
    }

    const tierRank = { PRIMARY: 0, REGIONAL: 1, SINGLE: 2 } as const
    const list = [...people.values()].sort((a, b) =>
      tierRank[a.tier] - tierRank[b.tier] ||
      `${a.firstName} ${a.lastName}`.trim().toLowerCase().localeCompare(`${b.firstName} ${b.lastName}`.trim().toLowerCase()) ||
      a.email.localeCompare(b.email))

    return NextResponse.json({
      people: list,
      totals: {
        all: list.length,
        primary: list.filter(p => p.tier === 'PRIMARY').length,
        regional: list.filter(p => p.tier === 'REGIONAL').length,
        single: list.filter(p => p.tier === 'SINGLE').length,
        systemAdminsWithNoLocations: list.filter(p => p.role === 'SYSTEM_ADMIN' && !p.locations.length).length,
      },
    })
  } catch (e) {
    console.error('[admin/restaurant-admins] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load restaurant admins' }, { status: 500 })
  }
}
