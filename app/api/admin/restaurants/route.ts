import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { sql } from '../../../../lib/db'
import { hashPassword } from '../../../../lib/disco-restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Create a Disco-native (Neon-only, zero-FM) restaurant: a login account
// (is_disco_native, no fm_restaurant_reference — a true zero-FM orphan), plus the
// marketplace cache + overrides rows. The account gets a random unusable password
// so it exists and is editable immediately; the restaurant sets a real password
// via the standard reset flow before logging in.
async function createDiscoNativeRestaurant(r: Record<string, unknown>): Promise<NextResponse> {
  const admin = (r.admin || {}) as Record<string, unknown>
  const addr = (r.address || {}) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? null : String(v))
  const name = String(r.businessName || '').trim()
  const email = String(admin.email || '').trim().toLowerCase()
  if (!name) return NextResponse.json({ error: 'Restaurant name is required' }, { status: 400 })
  if (!email) return NextResponse.json({ error: 'Admin email is required' }, { status: 400 })

  const ref = randomUUID()
  const slug = (name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 50) || 'restaurant') + '-' + ref.slice(0, 6)
  const leadOne = r.leadGenOne != null ? Number(r.leadGenOne) : 15
  const leadTwo = r.leadGenTwo != null ? Number(r.leadGenTwo) : 5

  try {
    const pwHash = await hashPassword(randomUUID() + randomUUID()) // random → unusable until reset
    await sql`
      INSERT INTO disco_restaurant_accounts
        (email, password_hash, restaurant_reference, first_name, last_name, phone,
         restaurant_name, business_name, address, is_disco_native)
      VALUES (${email}, ${pwHash}, ${ref}, ${s(admin.firstName)}, ${s(admin.lastName)}, ${s(addr.phoneNumber)},
         ${name}, ${name}, ${s(addr.addressLine1)}, true)
    `
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/unique|duplicate/i.test(msg)) return NextResponse.json({ error: 'That email is already used by another account.' }, { status: 409 })
    console.error('[admin/restaurants POST] native account insert failed:', msg)
    return NextResponse.json({ error: 'Unable to create restaurant' }, { status: 500 })
  }

  await sql`
    INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, is_premium, stripe_connected, lead_gen_one_pct, lead_gen_two_pct)
    VALUES (${ref}, false, false, false, ${leadOne}, ${leadTwo})
    ON CONFLICT (restaurant_reference) DO NOTHING
  `
  await sql`
    INSERT INTO disco_restaurant_cache
      (restaurant_reference, name, slug, phone, address, address_line2, city, state, zipcode, is_disco_native, is_live, cached_at)
    VALUES (${ref}, ${name}, ${slug}, ${s(addr.phoneNumber)}, ${s(addr.addressLine1)}, ${s(addr.addressLine2)}, ${s(addr.city)}, ${s(addr.state)}, ${s(addr.zipcode)}, true, false, NOW())
    ON CONFLICT (restaurant_reference) DO NOTHING
  `
  return NextResponse.json({ ok: true, reference: ref, discoNative: true })
}

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  const page = sp.get('page')
  if (page && page !== '0') params.set('page', page)
  params.set('size', sp.get('size') || '25')
  // FM filters the ordering list by `searchName` (restaurant.service.ts:378-393,
  // getDefaultFilters().searchName), NOT `search` — forwarding `search` was a
  // no-op, so the search box did nothing.
  const searchTerm = sp.get('search') || sp.get('searchName')
  if (searchTerm) params.set('searchName', searchTerm)
  if (sp.get('restaurantStatus')) params.set('restaurantStatus', sp.get('restaurantStatus')!)
  sp.getAll('sort').forEach(s => params.append('sort', s))
  try {
    const res = await fetch(`${FM}/api/admin/restaurants?${params}`, { headers: h })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to fetch restaurants', status: res.status, raw }, { status: res.status })
    }
    const data = await res.json() as { content?: unknown[]; totalElements?: number; totalPages?: number }

    // ── DISCO-NATIVE RESTAURANTS MUST APPEAR HERE TOO ────────────────────────
    // A converted restaurant is Disco-native: Disco owns it, and FM may hold no
    // record of it at all. This list asked FM alone, so a native-only restaurant
    // was invisible to super admin — the same defect closed for the System Admin
    // list, one screen over. Peter's "Stacks & Cordials - Royal Oak (Copy)" is the
    // worked example: created natively, complete, and absent from this page.
    //
    // MERGED, NOT SWITCHED. FM-backed restaurants exist only in FM's list, so
    // dropping the FM call would blank most of the page. Native rows are appended
    // and de-duplicated on reference, because a converted restaurant legitimately
    // appears in both and must not be listed twice.
    try {
      const fmList = Array.isArray(data.content) ? data.content : []
      const seen = new Set(fmList.map((r) => String((r as { reference?: unknown })?.reference ?? '').toLowerCase()))
      const term = (searchTerm || '').trim().toLowerCase()
      const native = (await sql`
        SELECT restaurant_reference, name, slug, address, city, state, zipcode, phone, is_live
          FROM disco_restaurant_cache
         WHERE is_disco_native = true
           AND archived_at IS NULL
           AND (${term} = '' OR LOWER(name) LIKE '%' || ${term} || '%')
         ORDER BY name ASC
      `) as Array<Record<string, unknown>>
      const extra = native
        .filter((n) => !seen.has(String(n.restaurant_reference).toLowerCase()))
        .map((n) => ({
          reference: n.restaurant_reference,
          businessName: n.name,
          businessNameWithoutSpaces: n.slug,
          address: {
            addressLine1: n.address || '', city: n.city || '', state: n.state || '',
            zipcode: n.zipcode || '', phoneNumber: n.phone || '',
          },
          blocked: !n.is_live,
          // Flags the row's origin so the screen can tell the two apart, and so a
          // reader is never left wondering why a restaurant has no FM fields.
          discoNative: true,
        }))
      if (extra.length) {
        data.content = [...fmList, ...extra]
        data.totalElements = (data.totalElements ?? fmList.length) + extra.length
      }
    } catch (e) {
      // Never let a Neon failure blank FM's list — a degraded page beats no page.
      console.error('[admin/restaurants] native merge failed:', e instanceof Error ? e.message : e)
    }

    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Unable to fetch restaurants' }, { status: 500 })
  }
}

// Create ordering restaurant — multipart with "restaurant" JSON blob + optional CSV "file"
export async function POST(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const ct = req.headers.get('content-type') || ''
    let fd: FormData
    let restaurantJson: Record<string, unknown> = {}
    if (ct.startsWith('multipart/form-data')) {
      fd = await req.formData()
      const part = fd.get('restaurant')
      const txt = typeof part === 'string' ? part : part instanceof Blob ? await part.text() : '{}'
      try { restaurantJson = JSON.parse(txt || '{}') } catch { restaurantJson = {} }
    } else {
      const body = await req.json()
      restaurantJson = body
      fd = new FormData()
      fd.append('restaurant', new Blob([JSON.stringify(body)], { type: 'application/json' }))
    }

    // Disco-native create — Neon-only, never touch FM. FM-backed create (the
    // default) is unchanged below.
    if (restaurantJson.discoNative === true) {
      return await createDiscoNativeRestaurant(restaurantJson)
    }

    const res = await fetch(`${FM}/api/admin/restaurants`, { method: 'POST', headers: h, body: fd })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to create restaurant', raw }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to create restaurant' }, { status: 500 })
  }
}
