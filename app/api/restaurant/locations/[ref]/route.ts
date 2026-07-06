import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { discoGroupRefs } from '../../../../../lib/disco-restaurant-auth'
import { sql, runMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Disco-native: return the location from disco_restaurant_cache in the shape the
  // edit dialog expects. Category/fulfillment defaults keep the form submittable.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    if (!(await discoGroupRefs(ctx.businessName, ctx.email, ctx.restaurantReference)).has(ref)) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    await runMigrations()
    const rows = (await sql`
      SELECT restaurant_reference AS reference, name, address, address_line2, city, state, zipcode, phone, lat, lng, timezone, cuisine
      FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
    `) as Record<string, unknown>[]
    if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const r = rows[0]
    return NextResponse.json({
      reference: r.reference,
      businessName: r.name,
      businessNameWithoutSpaces: String(r.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
      timezone: r.timezone || '',
      restaurantCategories: r.cuisine ? [r.cuisine] : [],
      fulfillmentOptions: ['PICKUP'],
      address: {
        addressLine1: r.address || '', addressLine2: r.address_line2 || '',
        city: r.city || '', state: r.state || '', zipcode: r.zipcode || '',
        phoneNumber: r.phone || '',
        latitude: r.lat != null ? Number(r.lat) : undefined,
        longitude: r.lng != null ? Number(r.lng) : undefined,
      },
    })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/${ref}`, { headers: h })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to fetch location', raw: text }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch { return NextResponse.json({ error: 'Unable to fetch location' }, { status: 500 }) }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Disco-native: persist the editable fields to disco_restaurant_cache.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    if (!(await discoGroupRefs(ctx.businessName, ctx.email, ctx.restaurantReference)).has(ref)) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    try {
      const ct = req.headers.get('content-type') || ''
      let payload: Record<string, unknown> = {}
      if (ct.startsWith('multipart/form-data')) {
        const fd = await req.formData()
        const blob = fd.get('restaurant')
        if (blob && typeof (blob as Blob).text === 'function') payload = JSON.parse(await (blob as Blob).text())
      } else {
        payload = await req.json()
      }
      const a = (payload.address ?? {}) as Record<string, unknown>
      const cats = Array.isArray(payload.categories) ? (payload.categories as string[]) : []
      await runMigrations()
      await sql`
        UPDATE disco_restaurant_cache SET
          name = COALESCE(NULLIF(${(payload.businessName as string) ?? null}, ''), name),
          address = ${(a.addressLine1 as string) ?? null},
          address_line2 = ${(a.addressLine2 as string) ?? null},
          city = ${(a.city as string) ?? null},
          state = ${(a.state as string) ?? null},
          zipcode = ${(a.zipcode as string) ?? null},
          phone = ${(a.phoneNumber as string) ?? null},
          lat = ${(a.latitude as number) ?? null},
          lng = ${(a.longitude as number) ?? null},
          timezone = COALESCE(NULLIF(${(payload.timezone as string) ?? null}, ''), timezone),
          cuisine = COALESCE(${cats[0] ?? null}, cuisine),
          cached_at = NOW()
        WHERE restaurant_reference = ${ref}
      `
      return NextResponse.json({ ok: true })
    } catch (e) {
      console.error('[locations/[ref]] disco update failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to update' }, { status: 500 })
    }
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const ct = req.headers.get('content-type') || ''
    let fd: FormData
    if (ct.startsWith('multipart/form-data')) {
      // Client already built FormData (restaurant blob + optional CSV file).
      // Forward as-is. Reconstructing FormData strips the original boundary
      // header that fetch() needs; setting Content-Type from headers handles it.
      fd = await req.formData()
    } else {
      const body = await req.json()
      fd = new FormData()
      fd.append('restaurant', new Blob([JSON.stringify(body)], { type: 'application/json' }))
    }
    const res = await fetch(`${FM}/api/system-admin/restaurants/${ref}`, {
      method: 'PUT',
      headers: h,
      body: fd,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to update', raw: text }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update' }, { status: 500 }) }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/${ref}`, { method: 'DELETE', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ error: 'Unable to delete' }, { status: 500 }) }
}
