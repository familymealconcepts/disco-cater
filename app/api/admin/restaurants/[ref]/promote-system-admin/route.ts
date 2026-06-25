import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../../lib/admin-auth'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import { discoEmailDomain, grantLocationAccess } from '../../../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'

// POST /api/admin/restaurants/{ref}/promote-system-admin
// Disco-native SYSTEM_ADMIN promotion. Sets role = 'SYSTEM_ADMIN' on the
// restaurant's Disco account AND every account in the same group (same
// business_name, or same email domain as a fallback) so the whole group gets
// all-locations access in the restaurant portal. This mirrors FM's "promote to
// SYSTEM_ADMIN" but is driven entirely from Neon — no FM call.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  // Super admin must be authenticated (same guard as the sibling FM proxies).
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { ref } = await params
  try {
    await runDiscoOrderMigrations() // ensures role + business_name columns exist

    const accounts = (await sql`
      SELECT id, email, business_name, restaurant_name
      FROM disco_restaurant_accounts
      WHERE restaurant_reference = ${ref}
      ORDER BY id ASC
    `) as Array<{ id: number; email: string; business_name: string | null; restaurant_name: string | null }>

    if (!accounts.length) {
      return NextResponse.json(
        { error: 'This restaurant has no Disco Cater account yet. They must log in first.' },
        { status: 404 },
      )
    }

    const primary = accounts[0]
    const promotedIds = new Set<number>()

    // Promote the whole group: by business_name when set, else email domain.
    const bn = (primary.business_name || '').trim()
    if (bn) {
      const rows = (await sql`
        UPDATE disco_restaurant_accounts SET role = 'SYSTEM_ADMIN', updated_at = NOW()
        WHERE business_name = ${bn} RETURNING id
      `) as Array<{ id: number }>
      rows.forEach(r => promotedIds.add(r.id))
    } else {
      const domain = discoEmailDomain(primary.email)
      if (domain) {
        const rows = (await sql`
          UPDATE disco_restaurant_accounts SET role = 'SYSTEM_ADMIN', updated_at = NOW()
          WHERE LOWER(SPLIT_PART(email, '@', 2)) = ${domain} RETURNING id
        `) as Array<{ id: number }>
        rows.forEach(r => promotedIds.add(r.id))
      }
    }

    // Always promote the matched account itself — covers a null business_name +
    // unparseable email so the action is never a silent no-op.
    const primaryRows = (await sql`
      UPDATE disco_restaurant_accounts SET role = 'SYSTEM_ADMIN', updated_at = NOW()
      WHERE id = ${primary.id} RETURNING id
    `) as Array<{ id: number }>
    primaryRows.forEach(r => promotedIds.add(r.id))

    // Record each promoted account's ORIGINAL/home location in the explicit
    // access table. The home location is always retained and never removed, even
    // if other location access changes later.
    const grantedBy = (await getAdminEmail().catch(() => null)) || 'SUPER_ADMIN'
    const ids = Array.from(promotedIds)
    if (ids.length) {
      const promoted = (await sql`
        SELECT email, restaurant_reference FROM disco_restaurant_accounts
        WHERE id = ANY(${ids}::int[])
      `) as Array<{ email: string; restaurant_reference: string | null }>
      for (const p of promoted) {
        if (p.email && p.restaurant_reference) {
          await grantLocationAccess(p.email, p.restaurant_reference, grantedBy)
            .catch(e => console.error('[promote-system-admin] grant home access failed:', e instanceof Error ? e.message : e))
        }
      }
    }

    return NextResponse.json({ success: true, updatedCount: promotedIds.size })
  } catch (err) {
    console.error('[promote-system-admin] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to promote to System Admin' }, { status: 500 })
  }
}
