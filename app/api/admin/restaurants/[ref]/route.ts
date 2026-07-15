import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { sql } from '../../../../../lib/db'
import { deleteDiscoNativeRestaurant } from '../../../../../lib/disco-restaurant-delete'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// A restaurant is Disco-native (no FamilyMeal record) when its Disco account is
// flagged is_disco_native with no fm_restaurant_reference. For these, FM has no
// record at all — calling FM to delete just 404s — so we delete from Neon directly.
async function isDiscoNativeNoFm(ref: string): Promise<boolean> {
  try {
    const rows = (await sql`
      SELECT is_disco_native, fm_restaurant_reference
      FROM disco_restaurant_accounts WHERE restaurant_reference = ${ref} LIMIT 1
    `) as { is_disco_native: boolean | null; fm_restaurant_reference: string | null }[]
    const a = rows[0]
    return !!a && a.is_disco_native === true && !a.fm_restaurant_reference
  } catch {
    return false // on any doubt, fall through to the FM path (unchanged behavior)
  }
}

// Deep-merge `patch` onto `base`: nested objects merge recursively; arrays and
// primitives replace; `undefined` patch values are ignored (keep base). Used to
// build the full FM restaurant object from only the fields a caller changed.
function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const baseObj = (base && typeof base === 'object' && !Array.isArray(base)) ? (base as Record<string, unknown>) : {}
  const out: Record<string, unknown> = { ...baseObj }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    out[k] = deepMerge(baseObj[k], v)
  }
  return out
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params

  // Disco-native restaurants have no FM record — serve the edit form from Neon in
  // the FM-shaped envelope the dialog reads (admin/address/businessName/leadGen).
  // lat/lng/cuisine/description/image load separately from the restaurant-cache GET.
  if (await isDiscoNativeNoFm(ref)) {
    try {
      const acc = (await sql`SELECT first_name, last_name, email, phone, restaurant_name, business_name, address FROM disco_restaurant_accounts WHERE restaurant_reference = ${ref} LIMIT 1`) as Array<Record<string, unknown>>
      const cache = (await sql`SELECT name, slug, address, address_line2, city, state, zipcode, phone FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as Array<Record<string, unknown>>
      const ov = (await sql`SELECT lead_gen_one_pct, lead_gen_two_pct FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1`) as Array<Record<string, unknown>>
      const a = acc[0] || {}, c = cache[0] || {}, o = ov[0] || {}
      return NextResponse.json({
        businessName: c.name || a.restaurant_name || '',
        businessNameWithoutSpaces: c.slug || '',
        admin: { firstName: a.first_name || '', lastName: a.last_name || '', email: a.email || '', phoneNumber: a.phone || '' },
        address: {
          addressLine1: c.address || a.address || '', addressLine2: c.address_line2 || '',
          city: c.city || '', state: c.state || '', zipcode: c.zipcode || '', phoneNumber: c.phone || a.phone || '',
        },
        leadGenOne: o.lead_gen_one_pct ?? 15,
        leadGenTwo: o.lead_gen_two_pct ?? 5,
      })
    } catch (e) {
      console.error('[admin/restaurants GET] native load failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to load restaurant' }, { status: 500 })
    }
  }

  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch restaurant' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : null)
  } catch {
    return NextResponse.json({ error: 'Unable to fetch restaurant' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params

  // SAFEGUARD: never delete a restaurant that has real order history without an
  // explicit, restaurant-specific confirmation — regardless of how it's labeled
  // (FM or Disco-native). The caller must re-send ?confirmDeleteWithOrders=<ref>
  // (the exact reference), so a blanket/mis-clicked delete can't wipe a live
  // restaurant. This is exactly what would have protected Test Kitchen (c8322ff4).
  try {
    const [fm, disco] = await Promise.all([
      sql`SELECT count(*)::int n FROM fm_historical_orders WHERE restaurant_reference::text = ${ref}`,
      sql`SELECT count(*)::int n FROM disco_orders WHERE restaurant_reference::text = ${ref}`,
    ])
    const orderCount = ((fm as { n: number }[])[0]?.n || 0) + ((disco as { n: number }[])[0]?.n || 0)
    if (orderCount > 0 && req.nextUrl.searchParams.get('confirmDeleteWithOrders') !== ref) {
      return NextResponse.json(
        { error: `This restaurant has ${orderCount} order(s) in its history. Deletion is destructive and requires explicit confirmation.`, requiresConfirmation: true, orderCount },
        { status: 409 },
      )
    }
  } catch (guardErr) {
    // If the history check itself fails, do NOT proceed with a destructive delete.
    console.error('[admin/restaurants DELETE] order-history guard failed — blocking delete:', guardErr instanceof Error ? guardErr.message : guardErr)
    return NextResponse.json({ error: 'Could not verify order history; delete blocked for safety.' }, { status: 500 })
  }

  // Disco-native restaurants have no FM record — delete from Neon, never call FM
  // (which would just 404). Everything else deletes through FM as before.
  if (await isDiscoNativeNoFm(ref)) {
    try {
      const summary = await deleteDiscoNativeRestaurant(ref)
      return NextResponse.json({ ok: true, deletedFrom: 'neon', deleted: summary })
    } catch (e) {
      console.error('[admin/restaurants DELETE] Neon delete failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to delete restaurant' }, { status: 500 })
    }
  }

  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}`, { method: 'DELETE', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to delete restaurant' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to delete restaurant' }, { status: 500 })
  }
}

// GET → merge → PUT. Callers send ONLY the fields they changed; we read the
// current FM object, deep-merge the changes onto it, and PUT the complete object
// back. A partial PUT to FM resets omitted fields (restaurantStatus, blocked,
// online-ordering flags) — this guarantees those are always preserved unless the
// caller explicitly changes them.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  try {
    // Parse the caller's changes (JSON, or a multipart `restaurant` JSON part).
    let incoming: Record<string, unknown>
    const ct = req.headers.get('content-type') || ''
    if (ct.startsWith('multipart/form-data')) {
      const fd = await req.formData()
      const part = fd.get('restaurant')
      const txt = typeof part === 'string' ? part : (part instanceof Blob ? await part.text() : '{}')
      incoming = JSON.parse(txt || '{}')
    } else {
      incoming = await req.json()
    }

    // Disco-native: write identity/address/lead-gen straight to Neon and return —
    // FM has no record, so the FM GET→merge→PUT below would 404 and abort the save.
    // (Premium/visibility, cuisine/description/image, and lat/lng are written by the
    // dialog's follow-up overrides + cache PATCH calls, exactly as for FM-backed.)
    if (await isDiscoNativeNoFm(ref)) {
      const admin = (incoming.admin || {}) as Record<string, unknown>
      const addr = (incoming.address || {}) as Record<string, unknown>
      const s = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? null : String(v))
      const name = typeof incoming.businessName === 'string' ? incoming.businessName.trim() : null
      const leadOne = incoming.leadGenOne != null ? Number(incoming.leadGenOne) : null
      const leadTwo = incoming.leadGenTwo != null ? Number(incoming.leadGenTwo) : null
      try {
        await sql`
          UPDATE disco_restaurant_accounts SET
            first_name = ${s(admin.firstName)}, last_name = ${s(admin.lastName)},
            email = COALESCE(${s(admin.email)}, email), phone = ${s(addr.phoneNumber)},
            restaurant_name = COALESCE(${name}, restaurant_name), business_name = COALESCE(${name}, business_name),
            address = ${s(addr.addressLine1)}
          WHERE restaurant_reference = ${ref}
        `
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/unique|duplicate/i.test(msg)) return NextResponse.json({ error: 'That email is already used by another account.' }, { status: 409 })
        throw e
      }
      await sql`
        INSERT INTO disco_restaurant_cache (restaurant_reference, name, phone, address, address_line2, city, state, zipcode, cached_at)
        VALUES (${ref}, ${name ?? 'Restaurant'}, ${s(addr.phoneNumber)}, ${s(addr.addressLine1)}, ${s(addr.addressLine2)}, ${s(addr.city)}, ${s(addr.state)}, ${s(addr.zipcode)}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET
          name = COALESCE(${name}, disco_restaurant_cache.name),
          phone = EXCLUDED.phone, address = EXCLUDED.address, address_line2 = EXCLUDED.address_line2,
          city = EXCLUDED.city, state = EXCLUDED.state, zipcode = EXCLUDED.zipcode, cached_at = NOW()
      `
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, lead_gen_one_pct, lead_gen_two_pct)
        VALUES (${ref}, ${leadOne ?? 15}, ${leadTwo ?? 5})
        ON CONFLICT (restaurant_reference) DO UPDATE SET
          lead_gen_one_pct = COALESCE(${leadOne}, disco_restaurant_overrides.lead_gen_one_pct),
          lead_gen_two_pct = COALESCE(${leadTwo}, disco_restaurant_overrides.lead_gen_two_pct)
      `
      return NextResponse.json({ ok: true })
    }

    // 1) GET the current full FM restaurant object.
    const getRes = await fetch(`${FM}/api/admin/restaurants/${ref}`, { headers: h })
    if (!getRes.ok) {
      return NextResponse.json({ error: 'Failed to load restaurant before save' }, { status: getRes.status })
    }
    const existing = (await getRes.json().catch(() => ({}))) as Record<string, unknown>

    // Flag any online-ordering change away from ACCEPTED so it's easy to catch.
    if (incoming.restaurantStatus !== undefined && incoming.restaurantStatus !== 'ACCEPTED') {
      console.warn('[admin/restaurants PUT] restaurantStatus changing to non-ACCEPTED', {
        ref, from: existing.restaurantStatus, to: incoming.restaurantStatus,
      })
    }

    // 2) Merge only the changed fields onto the current object.
    const merged = deepMerge(existing, incoming) as Record<string, unknown>

    // Hard guard: these operational flags must NEVER change unless the edit body
    // explicitly sends them. Toggling online ordering, blocking, money flow, etc.
    // each go through their own dedicated request that DOES send the field; a
    // general restaurant edit must leave them exactly as they were in FM.
    const PROTECTED_FIELDS = [
      'onlineOrderingAllowed', 'restaurantStatus', 'blocked', 'moneyFlow',
      'leadGenOne', 'leadGenTwo', 'nashAllowed', 'shipdayEnabled',
    ]
    for (const f of PROTECTED_FIELDS) {
      if (!(f in incoming)) merged[f] = existing[f] // preserve the GET value
    }

    console.log('[restaurant edit] onlineOrderingAllowed before:', existing.onlineOrderingAllowed, 'after merge:', merged.onlineOrderingAllowed)

    // Safety net: a non-explicit edit (one that didn't send onlineOrderingAllowed)
    // must never end up turning it off. If FM had it on and the merged object lost
    // it, force it back. The dedicated toggle DOES send the field, so it's exempt.
    if (
      !('onlineOrderingAllowed' in incoming)
      && existing.onlineOrderingAllowed === true
      && merged.onlineOrderingAllowed !== true
    ) {
      console.error('[restaurant edit] onlineOrderingAllowed would have been turned off by a non-explicit edit — forcing it back on', { ref })
      merged.onlineOrderingAllowed = existing.onlineOrderingAllowed
    }

    // 3) PUT the complete merged object back to FM.
    const fd = new FormData()
    fd.append('restaurant', new Blob([JSON.stringify(merged)], { type: 'application/json' }))
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}`, { method: 'PUT', headers: h, body: fd })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      console.error('[admin/restaurants PUT] FM rejected:', res.status, ref, raw.slice(0, 800))
      return NextResponse.json({ error: 'Failed to update restaurant', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch (e) {
    console.error('[admin/restaurants PUT] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update restaurant' }, { status: 500 })
  }
}
