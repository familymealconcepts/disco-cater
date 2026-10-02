import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../../lib/admin-auth'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import { discoEmailDomain, grantLocationAccess } from '../../../../../../lib/disco-restaurant-auth'
import { getFmServiceAuthHeader } from '../../../../../../lib/fm-service-auth'
import { fmFetch } from '../../../../../../lib/fm-fetch'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const runtime = 'nodejs'

// POST /api/admin/restaurants/{ref}/promote-system-admin
//
// "Transfer to System Admin". FamilyMeal is the specification, so this now does
// what FM's own action does and then keeps Neon in step — it used to do ONLY the
// Neon half, which is why it reported success while the person stayed a
// single-location ADMIN in their portal.
//
// ── WHAT FM DOES (RestaurantServiceImpl.transferAdminToSystemAdmin) ──────────
//   PUT /api/admin/restaurants/{reference}/system-admin   (SUPER_ADMIN only)
//   restaurant.getAdmins().stream().findFirst().ifPresent(user -> {
//       if (Role.ADMIN.equals(user.getRole())) {
//           user.setRole(Role.SYSTEM_ADMIN);
//           if (restaurant.getRestaurantGroup() == null) {
//               var g = createRestaurantGroup(restaurant.getBusinessName());
//               restaurant.setRestaurantGroup(g); user.setRestaurantGroup(g);
//           } else { user.setRestaurantGroup(restaurant.getRestaurantGroup()); }
//       }
//   });
// So: the restaurant's FIRST admin, and ONLY if they are currently ADMIN, becomes
// SYSTEM_ADMIN and is attached to the restaurant's group — creating a group named
// after the business when the restaurant has none. It is the ROLE change that
// gives the portal its system-admin level. FM writes no
// tbl_system_admin_restaurants rows here, and neither do we — mirroring exactly,
// not designing new role logic.
//
// Disco's service account (FM_ADMIN_EMAIL) is SUPER_ADMIN in FM, so it can call
// that endpoint directly; it is already the account behind every other
// /api/admin/... proxy in this codebase.
//
// ── DISCO-NATIVE RESTAURANTS ─────────────────────────────────────────────────
// A converted restaurant's people may have no FM role to change — FM may 404, or
// find an admin who is not ADMIN, in which case FM's own method is a no-op. That
// is not a failure: the Neon half below is what their portal reads. Both halves
// run independently and both outcomes are reported, so the caller is never told
// something happened that did not.
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  // Super admin must be authenticated (same guard as the sibling FM proxies).
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { ref } = await params
  // The admin's email (passed by the UI) lets us find the Disco account even when
  // its restaurant_reference differs from the cache/FM reference shown in the
  // table — a real account was being missed when only matching on restaurant_reference.
  const email = (req.nextUrl.searchParams.get('email') || '').trim().toLowerCase()
  try {
    await runDiscoOrderMigrations() // ensures role + business_name columns exist

    // NEVER MATCH THE STRIPE-IMPORT SENTINEL. importRestaurantStripeAccount
    // creates a login-disabled holder row (stripe-import+{ref}@familymeal.com)
    // for restaurants that had no account to attach a Stripe id to. It matches on
    // restaurant_reference, so it silently absorbed promotions meant for real
    // people: Rooted Cafe was "promoted" three times, each one re-promoting the
    // sentinel and returning success while Nicole Tomaszewski was never touched.
    // 233 of these sentinels currently hold SYSTEM_ADMIN for exactly that reason.
    const accounts = (await sql`
      SELECT id, email, business_name, restaurant_name, restaurant_reference
      FROM disco_restaurant_accounts
      WHERE (restaurant_reference = ${ref}
         OR (${email} <> '' AND LOWER(email) = ${email}))
        AND email NOT LIKE 'stripe-import+%'
        AND archived_at IS NULL
      ORDER BY id ASC
    `) as Array<{ id: number; email: string; business_name: string | null; restaurant_name: string | null; restaurant_reference: string | null }>

    // ── IS THIS RESTAURANT FAMILYMEAL'S, OR DISCO'S? ────────────────────────
    // Peter's ruling, 2026-10-02: creating a system admin for a DISCO-NATIVE
    // restaurant has nothing to do with FamilyMeal. No FM call, no FM role
    // change, no FM group. Disco owns it entirely.
    //
    // Read from disco_restaurant_cache, which is the authoritative flag
    // (disco_restaurant_accounts.is_disco_native is stale — see CLAUDE.md).
    // Unknown reference → treated as FM-backed, the pre-existing behaviour, so a
    // cache miss cannot silently skip a step an FM restaurant still needs.
    const nativeRows = (await sql`
      SELECT COALESCE(is_disco_native, false) AS native FROM disco_restaurant_cache
      WHERE restaurant_reference = ${ref} LIMIT 1
    `.catch(() => [])) as { native: boolean }[]
    const isNative = nativeRows[0]?.native === true

    // ── FM'S HALF — FM-BACKED RESTAURANTS ONLY ──────────────────────────────
    // For those, FM's role change is what actually gives the portal its
    // system-admin level, so it stays exactly as it was.
    let fm: { ok: boolean; status: number; detail: string }
    if (isNative) {
      fm = {
        ok: true, status: 0,
        detail: 'Disco-native restaurant — FamilyMeal was not contacted. The role and the location grant live entirely in Disco Cater.',
      }
    } else {
      try {
        const h = await getFmServiceAuthHeader()
        const res = await fmFetch(`${FM}/api/admin/restaurants/${ref}/system-admin`, { method: 'PUT', headers: h })
        fm = {
          ok: res.ok,
          status: res.status,
          detail: res.ok
            ? 'FamilyMeal transferred the restaurant\'s admin to SYSTEM_ADMIN.'
            : `FamilyMeal returned ${res.status}.`,
        }
      } catch (e) {
        fm = { ok: false, status: 0, detail: `FamilyMeal call failed: ${e instanceof Error ? e.message : e}` }
      }
      if (!fm.ok) console.error('[promote-system-admin] FM transfer did not succeed:', ref, fm.status, fm.detail)
    }

    // No Disco row is NOT a failure any more — FM's half may well have done the
    // work. Only report a hard error when NEITHER side could do anything.
    if (!accounts.length) {
      if (isNative) {
        // Nothing happened anywhere, and for a native restaurant nothing could:
        // there is no FM half to fall back on. Say so rather than reporting a
        // success built entirely out of a call that was never made.
        return NextResponse.json(
          { error: 'No Disco Cater portal account exists for this restaurant yet, so there is nobody to promote. Invite an admin first.' },
          { status: 404 },
        )
      }
      if (fm.ok) {
        return NextResponse.json({
          success: true, updatedCount: 0, fm: fm.detail,
          message: 'Transferred to System Admin in FamilyMeal. No Disco portal account exists for this restaurant yet, so no Disco-side role was changed.',
        })
      }
      return NextResponse.json(
        { error: `Could not transfer to System Admin. ${fm.detail} No Disco portal account exists for this restaurant either.` },
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

    // Report what actually happened, per side. The old response fed a toast that
    // claimed "access granted to all locations" — this action grants each promoted
    // account its OWN home location only, so that wording was never true.
    const grantedCount = ids.length
    return NextResponse.json({
      success: true,
      updatedCount: promotedIds.size,
      grantedCount,
      fm: fm.detail,
      fmOk: fm.ok,
      message: `${fm.ok ? 'Transferred in FamilyMeal. ' : `FamilyMeal: ${fm.detail} `}`
        + `${promotedIds.size} Disco account${promotedIds.size === 1 ? '' : 's'} set to System Admin.`,
    })
  } catch (err) {
    console.error('[promote-system-admin] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to promote to System Admin' }, { status: 500 })
  }
}
